import express from 'express';
import authAdminMiddleware from '../../middlewares/authAdminMiddleware.js';
import { getCampaignCodes } from '../../controllers/coupons/analyticsController.js';

const router = express.Router();

// Admin routes only
router.get('/admin/campaigns/:campaignId/codes', authAdminMiddleware, getCampaignCodes);

export default router;
