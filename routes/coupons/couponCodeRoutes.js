import express from 'express';
import authMiddleware from '../../middlewares/authMiddleware.js';
import { couponRedeemLimiter } from '../../middlewares/couponRateLimit.js';
import {
  generateCode,
  claimGuestCode,
  getMyCodes,
  validateCode,
  redeemCode
} from '../../controllers/coupons/couponCodeController.js';

const router = express.Router();

// Protected routes (authenticated users)
router.post('/coupons/campaigns/:campaignId/generate-code', authMiddleware, generateCode);
router.get('/coupons/my-codes', authMiddleware, getMyCodes);

// Public routes (no auth required) — rate-limited to stop code guessing / claim abuse
router.post('/coupons/claim', couponRedeemLimiter, claimGuestCode);
router.post('/coupons/validate', couponRedeemLimiter, validateCode);
router.post('/coupons/redeem', couponRedeemLimiter, redeemCode);

export default router;
