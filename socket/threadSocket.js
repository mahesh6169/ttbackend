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

    // Feature 1012: the old 'sendThreadMessage' relay was removed. It re-broadcast any message from
    // any client (no login, not saved, ignores the chat switch). Messages are sent through
    // POST /api/threads/send, which saves them and emits 'newThreadMessage' itself.
  });
};

// No need for getIO here since we’re using index.js’s io.
// export const getIO = () => { ... }; // Remove or comment out