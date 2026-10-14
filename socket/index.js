
import { config } from 'dotenv';
config({ path: '../.env' });

import Message from '../models/messageModel.js';
import User from '../models/userModel.js';
import socketAuth from '../middlewares/socketAuth.js';
import { Server } from 'socket.io';

let io;
const userSockets = new Map(); // userId -> single socketId (if you want last tab only)

export const initializeSocket = (server) => {
  // create a new instance of socket.io by passing the HTTP server object
  const allowedOrigins = process.env.FRONTEND_URL?.split(',').map(origin => origin.trim()) || [];
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 30000,      // 30 seconds to respond to a ping
  pingInterval: 10000,     // Send a ping every 10 seconds
  transports: ['websocket'], // Force only websocket if you want to avoid polling
  });

  console.log('Socket.IO initialized. Applying authentication middleware...');
  io.use(socketAuth);

  // Listens for new connections and authenticates them
  io.on('connection', async (socket) => {
    const userId = socket.user.id; // Get the authenticated user's ID (from socketAuth)
    userSockets.set(userId, socket.id); // Map the userId to their unique socket ID
    socket.join(userId); // Add the user's socket to a private room identified by their user ID

    // Fetch username for logging
    try {
      const user = await User.findById(userId).select('name email');
      const displayName = user?.name || user?.email || 'Unknown';
      console.log(`🔌 User connected: ${displayName}`);
    } catch (error) {
      console.log(`🔌 User connected: ${userId}`);
    }

    // When a user reads a message, a messageRead event is emitted, marking the message as read and notifying the other user
    socket.on('messageRead', async ({ messageId }) => {
      console.log('messageRead event received:', { messageId, from: userId });
      try {
        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('Message not found.');
        }
    
        const { owner, participant, senderRole, readBy} = message;
        const isOwnerOrParticipant = userId === owner.toString() || userId === participant.toString();
        if (!isOwnerOrParticipant) {
          throw new Error('Unauthorized user');
        }
    
        const senderId = senderRole === 'owner' ? owner.toString() : participant.toString();
    
        // ✅ Skip if sender tries to mark their own message as read
        if (senderId === userId) {
          console.log('Ignoring read event for own message.');
          return;
        }
    
        // ✅ Skip if already marked read by this user
        if (readBy?.toString() === userId) {
          console.log(`Message ${messageId} already marked as read by user ${userId}.`);
          return;
        }
    
        // ✅ Mark message as read by the current user
        message.readBy = userId;
        await message.save();
        console.log(`Message ${messageId} marked as read by user ${userId}`);
    
        // ✅ Notify the sender (the other user)
        const otherUserId = userId === owner.toString() ? participant.toString() : owner.toString();
        io.to(otherUserId).emit('messageRead', { messageId: message._id, userId });
        console.log(`messageRead event emitted to user room ${otherUserId}`);
        
      } catch (error) {
        console.error('Error marking message as read:', error.message);
      }
    });
    
    // ===== SEAT SELECTION HANDLERS ===== //
// Add this section at the end, before the final closing braces

// Join event room for real-time seat updates
socket.on('seat:join_event', (eventId) => {
  if (!eventId) return;
  
  const eventRoom = `event_${eventId}`;
  socket.join(eventRoom);
  console.log(`User ${userId} joined event room: ${eventRoom}`);
  
  // Track which event room this user is in (for cleanup)
  socket.eventRoom = eventRoom;
  socket.eventId = eventId;
});

    // ===== END SEAT SELECTION HANDLERS ===== //

socket.on('disconnect', async (reason) => {
  userSockets.delete(userId);
  
  // Fetch username for logging
  try {
    const user = await User.findById(userId).select('name email');
    const displayName = user?.name || user?.email || 'Unknown';
    console.log(`🔌 User disconnected: ${displayName}`);
  } catch (error) {
    console.log(`🔌 User disconnected: ${userId}`);
  }
});

  });


};


// export server instance
export const getIO = () => {
  if (!io) {
    console.error('Socket.IO instance not initialized');
    throw new Error('Socket.IO not initialized');
  }
  return io;
};