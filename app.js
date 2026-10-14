// Builds and exports the configured Express app WITHOUT starting the HTTP listener,
// connecting the database, or initialising sockets. server.js imports this and adds those.
// This split lets Supertest import the app for tests (standard pattern) while dev/prod
// startup behaviour via server.js stays identical.

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';

// Import Routes
import userRoutes from './routes/userRoutes.js';
import advertRoutes from './routes/advertRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import threadRoutes from './routes/threadRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import stripeRoutes from './routes/stripeRoutes.js';
import bannerAdRoutes from './routes/bannerAdRoutes.js';
import storeRoutes from './routes/coupons/storeRoutes.js';
import campaignRoutes from './routes/coupons/campaignRoutes.js';
import couponCodeRoutes from './routes/coupons/couponCodeRoutes.js';
import analyticsRoutes from './routes/coupons/analyticsRoutes.js';
import homeRoutes from './routes/homeRoutes.js';
import partnerStoreRoutes from './routes/dailydeals/partnerStoreRoutes.js';
import dailyDealRoutes from './routes/dailydeals/dailyDealRoutes.js';

import { stripeWebhook } from './controllers/stripe/stripeController.js';
import { apiKeyAuth } from './middlewares/apiKeyAuth.js';

console.log('📌 Initializing Express App...');

const app = express();

/// ---- REGISTER STRIPE WEBHOOK FIRST (ONLY /webhook, not whole router, raw body) ----
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhook
);
// --- END STRIPE WEBHOOK ---

// Use CORS globally
const allowedOrigins = process.env.FRONTEND_URL.split(',');
app.use(cors({
    origin: allowedOrigins,
    credentials: true,  // Allow credentials (cookies, auth, etc.)
}));

// Middleware
app.use(cookieParser());
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply API Key Auth middleware (after body parsers, before routes)
app.use(apiKeyAuth);

// Home Route
app.get('/', (req, res) => {
    res.status(200).json({ message: 'Welcome to the Support Desk App' });
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/adverts', advertRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/threads', threadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/bannerAds', bannerAdRoutes);
app.use('/api', storeRoutes);
app.use('/api', campaignRoutes);
app.use('/api', couponCodeRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', partnerStoreRoutes);
app.use('/api', dailyDealRoutes);
app.use('/api/home', homeRoutes);

// ✅ Global Error Handler
app.use((err, req, res, next) => {
    console.error(`❌ ERROR: ${err.message}`);
    console.error(err.stack);

    // Use the status code set in the controller, default to 500 if not set
    const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

    res.status(statusCode).json({
        success: false,
        message: err.message || 'Internal Server Error'
    });
});

export default app;
