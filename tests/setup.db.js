// Runs after the test framework is set up (jest setupFilesAfterEnv). Owns the test DB lifecycle
// and a non-listening socket server so suites stay isolated and getIO() never throws.
import mongoose from 'mongoose';
import { createServer } from 'http';
import app from '../app.js';
import { initializeSocket } from '../socket/index.js';

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  // Attach Socket.IO to a server we never listen on: controllers that emit via getIO() work,
  // but no port is opened and no real-time connection is expected in API tests.
  const httpServer = createServer(app);
  initializeSocket(httpServer);
});

afterEach(async () => {
  // Order-independent suites: clear every collection between tests.
  const { collections } = mongoose.connection;
  for (const name of Object.keys(collections)) {
    await collections[name].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.connection.close();
});
