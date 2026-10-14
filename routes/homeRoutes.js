import express from 'express';
import {
  getHomeListings,
  getHomeEvents,
  getHomeDemoEvents,
  getHomeThreads,
} from '../controllers/homeController.js';

const router = express.Router();

router.get('/listings', getHomeListings);
router.get('/events', getHomeEvents);
router.get('/demo-events', getHomeDemoEvents);
router.get('/threads', getHomeThreads);

export default router;
