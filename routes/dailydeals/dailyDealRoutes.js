import express from 'express';
import authMiddleware from '../../middlewares/authMiddleware.js';
import { multerMiddleware } from '../../middlewares/multerConfig.js';
import {
  // Public routes
  browseDeals,
  getDealBySlug,
  getPublicDealById,
  getFilterOptions,
  getSitemapDeals,
  // User routes
  fetchMyDeals,
  getMyStoresDropdown,
  addDeal,
  updateDeal,
  deleteDeal,
  getMyDealById
} from '../../controllers/dailydeals/dailyDealController.js';

const router = express.Router();

// ============== PUBLIC ROUTES ==============
// NOTE: /dailydeals/sitemap and the other literal paths MUST precede the
// /dailydeals/:slug catch-all, or Express matches "sitemap" as a slug.
router.get('/dailydeals/sitemap', getSitemapDeals);
router.get('/dailydeals/filter-options', getFilterOptions);
router.get('/dailydeals/view/:id', getPublicDealById);
router.get('/dailydeals/:slug', getDealBySlug);
router.get('/dailydeals', browseDeals);

// ============== USER ROUTES (authMiddleware) ==============
router.get('/user/dailydeals/mystores-dropdown', authMiddleware, getMyStoresDropdown);
router.get('/user/dailydeals', authMiddleware, fetchMyDeals);
router.get('/user/dailydeals/:id', authMiddleware, getMyDealById);
router.post('/user/dailydeals', authMiddleware, multerMiddleware, addDeal);
router.put('/user/dailydeals/:id', authMiddleware, multerMiddleware, updateDeal);
router.delete('/user/dailydeals/:id', authMiddleware, deleteDeal);

export default router;
