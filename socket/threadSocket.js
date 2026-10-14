import { getIO } from './index.js';

export const initializeThreadSocket = (server) => {
  const io = getIO();
  console.log('ThreadSocket initialized with existing Socket.IO instance.');

  io.on('connection', (socket) => {
    socket.on('joinThread', (threadId) => {
      console.log(`Socket ${socket.id} joining thread: ${threadId}`);
      socket.join(threadId);
    });

    socket.on('leaveThread', (threadId) => {
      console.log(`Socket ${socket.id} leaving thread: ${threadId}`);
      socket.leave(threadId);
    });

    socket.on('sendThreadMessage', ({ threadId, message }) => {
      io.to(threadId).emit('newThreadMessage', message);
    });
  });
};

// No need for getIO here since we’re using index.js’s io.
// export const getIO = () => { ... }; // Remove or comment out