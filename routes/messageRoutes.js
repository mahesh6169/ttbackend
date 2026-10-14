import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import {
  sendMessage,
  fetchMessages,
  getConversations,
  deleteConversation,
  deleteMessage,
  getUnreadCount,
} from '../controllers/shared/messageController.js';

const router = express.Router();

// ✅ Send message for both adverts and events
router.post('/send', authMiddleware, sendMessage);

// ✅ Fetch messages for a specific conversation
// expects: /fetch?resourceType=advert|event&resourceId=...&otherUserId=...
router.get('/fetch', authMiddleware, fetchMessages);

// ✅ Get all conversations for the current user
router.get('/conversations', authMiddleware, getConversations);

// ✅ Soft delete a conversation
// expects body: { resourceType: "advert" | "event", resourceId, otherUserId }
router.delete('/deleteConversation', authMiddleware, deleteConversation);

// ✅ Soft delete a single message
router.delete('/message/:messageId', authMiddleware, deleteMessage);

// ✅ Get unread message count
router.get('/unread-count', authMiddleware, getUnreadCount);

export default router;
