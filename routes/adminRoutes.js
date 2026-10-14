import express from 'express';
import { multerMiddleware } from '../middlewares/multerConfig.js';
import {
  adminLogin,
  adminLogout,
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  validateAdmin,
} from '../controllers/admin/users/manageUserController.js';

import {
  getAdverts,
  getAdvertById,
  deleteAdvert,
  getManageAdverts,
  sendReminderEmail,
  adminRenewAdvert,
} from '../controllers/admin/adverts/manageAdvertController.js';

import {
  getManageEvents,
  getPurgeQueue,
  getPastCurationList,
  setPastFeatured,
  sendEventReminderEmail,
  deleteEventById,
  blockEventById,
  getPaidEventsList,
  getEventPlatformFee,
  updateEventPlatformFee,
} from '../controllers/admin/events/manageEventController.js';

import {
  getManageThreads,
  deleteThreadById,
} from '../controllers/admin/threads/manageThreadController.js';

// Daily Deals Controllers
import {
  createDailyDeal,
  getDailyDeals,
  getDailyDealById,
  updateDailyDeal,
  deleteDailyDeal,
  getPartnersDropdown,
} from '../controllers/admin/dailydeals/dailyDealController.js';

import {
  createPartnerStore,
  getPartnerStores,
  getPartnerStoreById,
  updatePartnerStore,
  deletePartnerStore,
} from '../controllers/admin/dailydeals/partnerStoreController.js';

import authAdminMiddleware from '../middlewares/authAdminMiddleware.js';

// Banner Ad Controllers
import {
  // Business management
  getBusinesses,
  getBusinessById,
  createBusiness,
  updateBusiness,
  deleteBusiness,
  // Placement management
  getPlacements,
  getPlacementById,
  createPlacement,
  updatePlacement,
  deletePlacement,
  // Ad management
  getAds,
  getAdById,
  createAd,
  updateAd,
  deleteAd,
  // Metrics
  getMetrics,
  getMetricsByBusiness,
  getMetricsByPlacement,
  checkExpiredAds,
  // Image upload
  uploadBannerImages,
  deleteBannerImage
} from '../controllers/bannerAds/adminController.js';

const router = express.Router();

// ✅ Admin authentication routes
router.post('/login', adminLogin);
router.get('/validate', authAdminMiddleware, validateAdmin);
router.post('/logout', authAdminMiddleware, adminLogout);

// ✅ User management routes (Admin Only)
router.post('/users', authAdminMiddleware, createUser);
router.get('/users', authAdminMiddleware, getUsers);
router.get('/users/:id', authAdminMiddleware, getUserById);
router.put('/users/:id', authAdminMiddleware, updateUser);
router.delete('/users/:id', authAdminMiddleware, deleteUser);

// ✅ Advert management routes (Admin Only)
router.get('/adverts', authAdminMiddleware, getAdverts);
router.get('/adverts/byid/:id', authAdminMiddleware, getAdvertById);
router.delete('/adverts/byid/:id', authAdminMiddleware, deleteAdvert);
router.get('/adverts/manage', authAdminMiddleware, getManageAdverts);
router.post('/adverts/remind/:id', authAdminMiddleware, sendReminderEmail);
router.put('/adverts/:id/renew', authAdminMiddleware, adminRenewAdvert);

// ✅ Event management routes (Admin Only)
router.get('/events/manage', authAdminMiddleware, getManageEvents);
router.get('/events/purge-queue', authAdminMiddleware, getPurgeQueue);
router.get('/events/past-curation', authAdminMiddleware, getPastCurationList);
router.patch('/events/:id/past-featured', authAdminMiddleware, setPastFeatured);
router.post('/events/remind/:id', authAdminMiddleware, sendEventReminderEmail);
router.delete('/events/byid/:id', authAdminMiddleware, deleteEventById);
router.patch('/events/:id/block', authAdminMiddleware, blockEventById);

// ✅ Platform fee management routes (Admin Only)
router.get('/events/paid-events-list', authAdminMiddleware, getPaidEventsList);
router.get('/events/:eventId/platform-fee', authAdminMiddleware, getEventPlatformFee);
router.put('/events/:eventId/platform-fee', authAdminMiddleware, updateEventPlatformFee);

// ✅ Thread management routes (Admin Only)
router.get('/threads/manage', authAdminMiddleware, getManageThreads);
router.delete('/threads/byid/:id', authAdminMiddleware, deleteThreadById);

// ✅ Banner Ad management routes (Admin Only)

// Business management
router.get('/bannerAds/businesses', authAdminMiddleware, getBusinesses);
router.get('/bannerAds/businesses/:id', authAdminMiddleware, getBusinessById);
router.post('/bannerAds/businesses', authAdminMiddleware, createBusiness);
router.put('/bannerAds/businesses/:id', authAdminMiddleware, updateBusiness);
router.delete('/bannerAds/businesses/:id', authAdminMiddleware, deleteBusiness);

// Placement management
router.get('/bannerAds/placements', authAdminMiddleware, getPlacements);
router.get('/bannerAds/placements/:id', authAdminMiddleware, getPlacementById);
router.post('/bannerAds/placements', authAdminMiddleware, createPlacement);
router.put('/bannerAds/placements/:id', authAdminMiddleware, updatePlacement);
router.delete('/bannerAds/placements/:id', authAdminMiddleware, deletePlacement);

// Ad management
router.get('/bannerAds/ads', authAdminMiddleware, getAds);
router.get('/bannerAds/ads/:id', authAdminMiddleware, getAdById);
router.post('/bannerAds/ads', authAdminMiddleware, multerMiddleware, createAd);
router.put('/bannerAds/ads/:id', authAdminMiddleware, multerMiddleware, updateAd);
router.delete('/bannerAds/ads/:id', authAdminMiddleware, deleteAd);

// Metrics
router.get('/bannerAds/metrics', authAdminMiddleware, getMetrics);
router.get('/bannerAds/metrics/business/:businessId', authAdminMiddleware, getMetricsByBusiness);
router.get('/bannerAds/metrics/placement/:placementId', authAdminMiddleware, getMetricsByPlacement);
// Check expired ads
router.post('/bannerAds/check-expired', authAdminMiddleware, checkExpiredAds);

// Image uploads
router.post('/bannerAds/upload-images', authAdminMiddleware, multerMiddleware, uploadBannerImages);
router.post('/bannerAds/delete-image', authAdminMiddleware, deleteBannerImage);

// ✅ Partner Store management routes (Admin Only) - specific routes before :id
router.get('/dailydeals/partners-dropdown', authAdminMiddleware, getPartnersDropdown);
router.post('/dailydeals/partners', authAdminMiddleware, multerMiddleware, createPartnerStore);
router.get('/dailydeals/partners', authAdminMiddleware, getPartnerStores);
router.get('/dailydeals/partners/:id', authAdminMiddleware, getPartnerStoreById);
router.put('/dailydeals/partners/:id', authAdminMiddleware, multerMiddleware, updatePartnerStore);
router.delete('/dailydeals/partners/:id', authAdminMiddleware, deletePartnerStore);

// ✅ Daily Deals management routes (Admin Only)
router.post('/dailydeals', authAdminMiddleware, multerMiddleware, createDailyDeal);
router.get('/dailydeals', authAdminMiddleware, getDailyDeals);
router.get('/dailydeals/:id', authAdminMiddleware, getDailyDealById);
router.put('/dailydeals/:id', authAdminMiddleware, multerMiddleware, updateDailyDeal);
router.delete('/dailydeals/:id', authAdminMiddleware, deleteDailyDeal);

export default router;
