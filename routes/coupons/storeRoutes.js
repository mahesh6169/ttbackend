import express from 'express';
import authMiddleware from '../../middlewares/authMiddleware.js';
import authAdminMiddleware from '../../middlewares/authAdminMiddleware.js';
import { multerMiddleware } from '../../middlewares/multerConfig.js';
import {
  createStore,
  getStores,
  getStoreById,
  getStoreByIdentifier,
  updateStore,
  deleteStore,
  getFilterOptions
} from '../../controllers/coupons/storeController.js';

const router = express.Router();

// Admin routes
router.post('/admin/stores', authAdminMiddleware, multerMiddleware, createStore);
router.get('/admin/stores', authAdminMiddleware, getStores);
router.get('/admin/stores/:id', authAdminMiddleware, getStoreById);
router.put('/admin/stores/:id', authAdminMiddleware, multerMiddleware, updateStore);
router.delete('/admin/stores/:id', authAdminMiddleware, deleteStore);

// Public routes
router.get('/coupons/filter-options', getFilterOptions);
router.get('/coupons/stores', getStores);
router.get('/coupons/stores/lookup/:storeIdentifier', getStoreByIdentifier);
router.get('/coupons/stores/:storeId', getStoreById);

export default router;
