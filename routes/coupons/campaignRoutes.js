import express from 'express';
import authAdminMiddleware from '../../middlewares/authAdminMiddleware.js';
import optionalAuthMiddleware from '../../middlewares/optionalAuthMiddleware.js';
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  getCampaignByIdPublic,
  getCampaignBySlug,
  updateCampaign,
  deleteCampaign,
  getSitemapCampaigns
} from '../../controllers/coupons/campaignController.js';

const router = express.Router();

// Admin routes
router.post('/admin/stores/:storeId/campaigns', authAdminMiddleware, createCampaign);
router.get('/admin/stores/:storeId/campaigns', authAdminMiddleware, getCampaigns);
router.get('/admin/campaigns/:id', authAdminMiddleware, getCampaignById);
router.put('/admin/campaigns/:id', authAdminMiddleware, updateCampaign);
router.delete('/admin/campaigns/:id', authAdminMiddleware, deleteCampaign);
router.get('/admin/campaigns', authAdminMiddleware, getCampaigns);

// Public routes (with optional auth to check user status)
router.get('/coupons/stores/:storeId/campaigns', optionalAuthMiddleware, getCampaigns);
router.get('/coupons/campaigns/sitemap', getSitemapCampaigns);
router.get('/coupons/campaigns/slug/:slug', optionalAuthMiddleware, getCampaignBySlug);
router.get('/coupons/campaigns/:id', optionalAuthMiddleware, getCampaignByIdPublic);

export default router;
