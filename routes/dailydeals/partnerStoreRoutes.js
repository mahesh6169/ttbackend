import express from 'express';
import authMiddleware from '../../middlewares/authMiddleware.js';
import { multerMiddleware } from '../../middlewares/multerConfig.js';
import {
  fetchMyStores,
  getMyStoreById,
  addStore,
  updateStore,
  deleteStore
} from '../../controllers/dailydeals/partnerStoreController.js';

const router = express.Router();

// ============== USER ROUTES (authMiddleware) ==============
router.get('/user/partnerstores', authMiddleware, fetchMyStores);
router.get('/user/partnerstores/:id', authMiddleware, getMyStoreById);
router.post('/user/partnerstores', authMiddleware, multerMiddleware, addStore);
router.put('/user/partnerstores/:id', authMiddleware, multerMiddleware, updateStore);
router.delete('/user/partnerstores/:id', authMiddleware, deleteStore);

export default router;
