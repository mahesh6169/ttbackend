import express from 'express';
import * as threadController from '../controllers/threads/threadController.js';
import authMiddleware from '../middlewares/authMiddleware.js';
import { multerMiddleware } from '../middlewares/multerConfig.js';
import * as filterThreadController from '../controllers/threads/filterThreadController.js';
import * as searchThreadsController from '../controllers/threads/searchThreadsController.js';
const router = express.Router();




router.post('/create', authMiddleware, multerMiddleware, threadController.createThread);
router.get('/', threadController.getThreads);
router.get('/sitemap', threadController.getSitemapThreads);
//router.get('/categories', threadController.getThreadsByCategory);
//router.get('/categories',filterThreadController.getThreadsByCategory);
router.get('/public/:threadId', threadController.getThreadByIdPublic); // Public endpoint for meta tags
router.get('/:threadId/messages', threadController.getThreadMessages);
router.post('/send', authMiddleware, threadController.sendMessage);
router.post('/message/:messageId/like', threadController.likeMessage);
router.post('/message/:messageId/unlike',  threadController.unlikeMessage);
router.delete('/message/:messageId', authMiddleware, threadController.deleteMessage);
router.delete('/thread/:threadId', authMiddleware, threadController.deleteThread);
router.get('/user', authMiddleware, threadController.getUserThreads);

// ✅ Updated Edit Route with Cloudinary Cleanup Support
router.get('/thread/:threadId', authMiddleware, threadController.getThreadById);
router.put('/update/:threadId', authMiddleware, multerMiddleware, threadController.updateThread);


// 🟢 Search Routes (Public) - Matching pattern from advertRoutes.js
router.get('/search', searchThreadsController.searchThreads); // Search mode (universal search)
router.get('/filter-options', searchThreadsController.getFilterOptions); // Get filter options (universal search)
router.get('/recent-activity', searchThreadsController.getRecentActivity); // Recent activity mode (universal search)

// 🟢 Filter Routes (Public) - Matching pattern from advertRoutes.js
router.get('/filters/all', filterThreadController.getThreadsAll);               // All mode
router.get('/filters/categories', filterThreadController.getThreadsByCategory); // Categories mode (multi-category)
router.get('/filters/cities', filterThreadController.getThreadsByCity);         // Cities mode (location-based)
router.get('/filters/customcategories', filterThreadController.getThreadsCustomCategory); // Custom categories mode

export default router;
