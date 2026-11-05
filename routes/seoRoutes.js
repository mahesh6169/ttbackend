import express from 'express';
import { getSitemapSummary } from '../controllers/seo/sitemapSummaryController.js';

const router = express.Router();

// Mounted at /api/sitemap (app.js).
router.get('/summary', getSitemapSummary);

export default router;
