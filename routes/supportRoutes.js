import express from 'express';
import { submitReport, submitContact, submitRemoval } from '../controllers/support/supportController.js';

const router = express.Router();

// Public routes for support forms
router.post('/report', submitReport);
router.post('/contact', submitContact);
router.post('/removal', submitRemoval);

export default router;
