import express from 'express';
import { startOnboarding, getAccountStatus, stripeWebhook,  testWebhook } from '../controllers/stripe/stripeController.js';
import authMiddleware from '../middlewares/authMiddleware.js';


const router = express.Router();

// POST /api/stripe/onboard - Start Stripe Connect Express onboarding
router.post('/onboard', authMiddleware, startOnboarding);
router.get('/account-status', authMiddleware, getAccountStatus);

// Webhook route is registered in server.js before body parsing middleware
// router.post('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Webhook testing
router.get('/webhook-test', testWebhook);

export default router;
