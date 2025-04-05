import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import redisClient from './configDB.js';
import constants from './constants.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/**
 * Joins the socket to a room, updates online status, and sends previous messages.
 */
async function joinRoom(socket: Socket) {
  try {
    // Find a room that is not full, or create a new one
    const rooms = await redisClient.zrangebyscore(
      'active_rooms',
      '-inf',
      constants.MAX_USERS_PER_ROOM - 1,
      'LIMIT',
      0,
      1,
    );
    const selectedRoom = rooms.length ? rooms[0]! : `room:${Date.now()}`;

    // If new room, add it to the sorted set; otherwise, increment the room's user count
    if (!rooms.length) {
      await redisClient.zadd('active_rooms', 1, selectedRoom);
    } else {
      await redisClient.zincrby('active_rooms', 1, selectedRoom);
    }

    // Join the room and store room info in socket
    socket.join(selectedRoom);
    socket.data.room = selectedRoom;
    await redisClient.set(`user:${socket.id}:room`, selectedRoom);
    await redisClient.sadd(`${selectedRoom}:users`, socket.id);
    console.log(`User ${socket.id} joined ${selectedRoom}`);

    // Update online status by username and broadcast change
    await redisClient.hset(`${selectedRoom}:userStatus`, socket.data.username, 'online');
    io.to(selectedRoom).emit('userStatusChange', { username: socket.data.username, online: true });

    // Retrieve previous messages from Redis stream
    const messages = await redisClient.xrevrange(
      `${selectedRoom}:messages`,
      '+',
      '-',
      'COUNT',
      constants.MAX_MESSAGES_PER_ROOM,
    );

    const onlineCount = await redisClient.scard(`${selectedRoom}:users`);

    // Use pipeline to batch fetching user status and vote counts for each message
    const pipeline = redisClient.pipeline();
    const baseMessages = messages.map(([id, fields]) => {
      pipeline.hget(`${selectedRoom}:userStatus`, fields[1]!);
      pipeline.hgetall(`${selectedRoom}:messageVotes:${id}`);
      const [timestampStr] = id.split('-');
      return { id, username: fields[1]!, text: fields[3]!, timestamp: Number(timestampStr) };
    });
    const results = await pipeline.exec();

    // Process the pipelined results: two commands per message
    const formattedMessages = baseMessages.map((msg, i) => {
      const userStatusResult = results![2 * i]![1] as string | null;
      const voteCountsResult = results![2 * i + 1]![1] as Record<string, string>;
      return {
        ...msg,
        online: userStatusResult === 'online',
        upvotes: voteCountsResult.upvotes ? parseInt(voteCountsResult.upvotes, 10) : 0,
        downvotes: voteCountsResult.downvotes ? parseInt(voteCountsResult.downvotes, 10) : 0,
      };
    });

    // Sort messages chronologically and send them to the client
    formattedMessages.sort((a, b) => a.timestamp - b.timestamp);
    console.log(
      `Emitting online count: ${onlineCount}/${constants.MAX_USERS_PER_ROOM} in room ${selectedRoom}`,
    );
    socket.emit('previousMessages', formattedMessages, selectedRoom);
    io.to(selectedRoom).emit('onlineCount', onlineCount, constants.MAX_USERS_PER_ROOM);
  } catch (error) {
    console.error('Error in joinRoom:', error);
  }
}

/**
 * Handles a new message from a socket, stores it, and emits it to the room.
 */
async function handleMessage(socket: Socket, message: { username: string; text: string }) {
  try {
    const room = socket.data.room;
    if (!room) return;

    // If username is not set in socket, assign it
    if (!socket.data.username) {
      socket.data.username = message.username;
    }

    // Add message to the Redis stream
    const messageId = await redisClient.xadd(
      `${room}:messages`,
      '*',
      'username',
      message.username,
      'message',
      message.text,
    );
    if (!messageId) return;
    const [timestampStr] = messageId.split('-');

    // Check if the sender is still online (via socket ID)
    const isOnline = await redisClient.sismember(`${room}:users`, socket.id);

    // Build the message object
    const newMessage = {
      id: messageId,
      username: message.username,
      text: message.text,
      timestamp: Number(timestampStr),
      online: isOnline === 1,
      upvotes: 0,
      downvotes: 0,
    };

    // Initialize vote counts for the new message
    await redisClient.hset(`${room}:messageVotes:${messageId}`, 'upvotes', 0, 'downvotes', 0);
    io.to(room).emit('newMessage', newMessage);
  } catch (error) {
    console.error('Error in handleMessage:', error);
  }
}

/**
 * Checks if a user (socket) has already voted on a message.
 */
async function userHasVoted(socket: Socket, messageId: string) {
  const room = socket.data.room;
  if (!room) return null;
  const userVote = await redisClient.hget(`${room}:userVotes`, `${socket.id}:${messageId}`);
  return userVote || null;
}

/**
 * Handles a vote (upvote or downvote) for a given message.
 */
async function handleVote(socket: Socket, messageId: string, type: 'upvote' | 'downvote') {
  const room = socket.data.room;
  if (!room) return;

  try {
    const existingVote = await userHasVoted(socket, messageId);
    if (existingVote) {
      console.log(`User has already ${existingVote}d this message`);
      return;
    }

    // Increment the appropriate vote count and store the vote record
    const field = type === 'upvote' ? 'upvotes' : 'downvotes';
    await redisClient.hincrby(`${room}:messageVotes:${messageId}`, field, 1);
    await redisClient.hset(`${room}:userVotes`, `${socket.id}:${messageId}`, type);

    // Retrieve updated vote counts and total online users in the room
    const [voteCounts, onlineCount] = await Promise.all([
      redisClient.hgetall(`${room}:messageVotes:${messageId}`),
      redisClient.scard(`${room}:users`),
    ]);

    const upvotes = parseInt(voteCounts.upvotes || '0', 10);
    const downvotes = parseInt(voteCounts.downvotes || '0', 10);

    // Check if downvotes exceed or equal half of the current online users
    if (downvotes >= Math.ceil(onlineCount / 2)) {
      console.log(`Message ${messageId} deleted due to too many downvotes.`);
      await redisClient.del(`${room}:messageVotes:${messageId}`); // Delete vote counts
      await redisClient.xdel(`${room}:messages`, messageId); // Delete message from stream
      io.to(room).emit('deleteMessage', { messageId }); // Notify clients to remove message
      return;
    }

    // Broadcast updated vote counts
    io.to(room).emit('updateVoteCounts', { messageId, upvotes, downvotes });
  } catch (error) {
    console.error(`Error in handleVote (${type}):`, error);
  }
}

const handleUpvote = (socket: Socket, messageId: string) => handleVote(socket, messageId, 'upvote');
const handleDownvote = (socket: Socket, messageId: string) =>
  handleVote(socket, messageId, 'downvote');

/**
 * Handles feedback submission.
 */
async function handleFeedback(socket: Socket, message: string) {
  try {
    const ip = socket.data.ip;

    // Check cooldown first
    const cooldownKey = `feedback:cooldown:${ip}`;
    const hasCooldown = await redisClient.exists(cooldownKey);
    if (hasCooldown) {
      const ttl = await redisClient.ttl(cooldownKey);
      // Emit cooldown info back to client
      socket.emit('feedbackCooldown', { remainingSeconds: ttl });
      return;
    }

    // Save feedback
    const feedbackId = await redisClient.xadd('feedback', '*', 'message', message);
    console.log(`Feedback received with ID: ${feedbackId}`);

    // Set cooldown for 12 hours
    await redisClient.set(cooldownKey, '1', 'EX', 43200); // 43200 seconds = 12 hours

    // Emit success response
    socket.emit('feedbackSuccess');
  } catch (error) {
    console.error('Error in handleFeedback:', error);
    socket.emit('feedbackError', 'Internal server error');
  }
}

/**
 * Cleans up a room when a user disconnects.
 */
async function cleanupRoom(socket: Socket) {
  try {
    const room = await redisClient.get(`user:${socket.id}:room`);
    if (!room) return;
    const username = socket.data.username;
    if (!username) return;
    await redisClient.srem(`${room}:users`, socket.id);
    await redisClient.del(`user:${socket.id}:room`);
    await redisClient.del(`user:${socket.id}:ip`);
    await redisClient.hset(`${room}:userStatus`, username, 'offline');
    const onlineCount = await redisClient.scard(`${room}:users`);
    io.to(room).emit('userStatusChange', { username, online: false }, onlineCount);

    // Sprawdzenie liczby użytkowników w pokoju
    const userCount = await redisClient.zincrby('active_rooms', -1, room);
    if (Number(userCount) <= 0) {
      await redisClient.zrem('active_rooms', room);
      await redisClient.del(`${room}:users`);
      await redisClient.del(`${room}:messages`);
      await redisClient.del(`${room}:userStatus`);
      await redisClient.del(`${room}:userVotes`);

      // Usunięcie wszystkich głosów na wiadomości w pokoju
      const messageVoteKeys = await redisClient.keys(`${room}:messageVotes:*`);
      if (messageVoteKeys.length > 0) {
        await redisClient.del(...messageVoteKeys);
      }
    }
  } catch (error) {
    console.error('Error in cleanupRoom:', error);
  }
}

/**
 * Sends back the list of users in the room.
 */
async function sendRoomInfo(socket: Socket) {
  const room = socket.data.room;
  if (!room) return;

  const socketIds = await redisClient.smembers(`${room}:users`);

  // Use pipeline to get all usernames
  const pipeline = redisClient.pipeline();
  socketIds.forEach((id) => {
    pipeline.get(`user:${id}:username`);
  });

  const results = await pipeline.exec();

  // Extract usernames, fallback to socket ID if no username is set
  const usernames = results!.map(
    ([err, username], index) => username || `User${socketIds[index]!.slice(0, 5)}`,
  );

  socket.emit('roomData', usernames);
}

/**
 * Handles user vote kick.
 */
async function handleUserVote(socket: Socket, username: string) {}

/**
 * Handles topic vote.
 */
async function handleTopicVote(socket: Socket, topic: string) {}

/**
 * Main connection handler.
 */
io.on('connection', async (socket: Socket) => {
  console.log(`User ${socket.id} connected`);
  socket.data.username = '';

  const ip = socket.handshake.address;
  socket.data.ip = ip;

  // Set username event handler.
  socket.on('setUsername', async (username: string) => {
    socket.data.username = username;
    await redisClient.set(`user:${socket.id}:ip`, ip);
    await redisClient.set(`user:${socket.id}:username`, username);
    console.log(`Username for ${socket.id} is set to ${username}`);
    const room = socket.data.room;
    if (room) {
      await redisClient.hset(`${room}:userStatus`, username, 'online');
      io.to(room).emit('userStatusChange', { username, online: true });
    }
    await joinRoom(socket);
  });

  // Message and vote event handlers.
  socket.on('sendMessage', async (message) => await handleMessage(socket, message));
  socket.on('upvote', (messageId) => handleUpvote(socket, messageId));
  socket.on('downvote', (messageId) => handleDownvote(socket, messageId));

  // UI event handlers.
  socket.on('feedback', async (message) => await handleFeedback(socket, message));
  socket.on('fetchData', async () => await sendRoomInfo(socket));
  socket.on('startUserVote', async (username) => await handleUserVote(socket, username));
  socket.on('startTopicVote', async (topic) => await handleTopicVote(socket, topic));

  // Cleanup on disconnect.
  socket.on('disconnecting', async () => await cleanupRoom(socket));
  socket.on('disconnect', (reason) => console.log(`User ${socket.id} disconnected: ${reason}`));
});

const port = 3000;
server.listen(port, () => console.log(`Server running at http://localhost:${port}`));
