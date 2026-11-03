import express from 'express';
import { getPublicSettings } from '../controllers/platformSettingController.js';

const router = express.Router();

// Public site switches for the frontend menus (admin update lives in adminRoutes.js).
router.get('/', getPublicSettings);

export default router;
