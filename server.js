// Load environment variables only in development...
if (process.env.NODE_ENV !== 'production') {
    await import('dotenv').then(({ config }) => {
        config();
        console.log('✅ FRONTEND_URL loaded:', process.env.FRONTEND_URL);
    });
}

import { createServer } from 'http';
import colors from 'colors';
import connectDB from './config/db.js';
import { initializeSocket } from './socket/index.js';
import { initializeThreadSocket } from './socket/threadSocket.js';
import app from './app.js';

// Connect to MongoDB
connectDB();

// Create HTTP Server and Attach Socket.IO.
const server = createServer(app);

/// Initialize Socket.IO
initializeSocket(server);
initializeThreadSocket(server);

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`.green.bold));

// ✅ Catch Unhandled Rejections and Exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message.red.bold);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
});
