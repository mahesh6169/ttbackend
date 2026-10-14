import express from 'express';
import { 
  serveAds,
  trackImpression,
  trackClick,
  setState,
  clearState,
  getState
} from '../controllers/bannerAds/servingController.js';
import { optionalAuth } from '../middlewares/optionalAuth.js';

const router = express.Router();

// Public endpoints for ad serving and tracking

// Get ads for a specific placement
// Example: GET /api/bannerAds/serve/H1
router.get('/serve/:placement', optionalAuth, serveAds);

// Track impression for an ad
// Example: POST /api/bannerAds/impression/AD-123456
router.post('/impression/:adId', optionalAuth, trackImpression);

// Track click and redirect
// Example: GET /api/bannerAds/click/AD-123456
router.get('/click/:adId', optionalAuth, trackClick);

// Set user state preference (creates cookie)
// Example: POST /api/bannerAds/setState { state: "NSW" }
router.post('/setState', setState);

// Clear user state preference (removes cookie)
// Example: POST /api/bannerAds/clearState
router.post('/clearState', clearState);

// Get current user state preference
// Example: GET /api/bannerAds/getState
router.get('/getState', optionalAuth, getState);

export default router;