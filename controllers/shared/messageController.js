import { config } from 'dotenv';
config(); // Load .env from backend/ before anything else
import mongoose from 'mongoose';
import Message from '../../models/messageModel.js';
import User from '../../models/userModel.js';

import { getIO } from '../../socket/index.js';
import { getResourceModel } from '../../utils/getResourceModel.js';
import { encryptMessage, decryptMessage } from '../../utils/chat/encryption.js';
import { sendNewMessageNotificationEmail } from '../../utils/notifications/chat/chatNotificationEmail.js';

export const sendMessage = async (req, res) => {
  const { resourceType, resourceId, participantId, message, createdAt, replyTo } = req.body;
  const userId = req.user.id;

  console.log("Incoming message body:", req.body);

  try {
    // ✅ Validate required fields
    if (!resourceType || !resourceId || !participantId || !message) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // ✅ Check if resource exists
    const Model = getResourceModel(resourceType);
    const resource = await Model.findById(resourceId);
    if (!resource) {
      return res.status(404).json({ message: `${resourceType} not found.` });
    }

    const ownerId = resource.postedBy.toString();
    const isOwner = userId === ownerId;
    const resolvedParticipantId = isOwner ? participantId : userId;

    // ✅ Prevent self-messaging
    if (resolvedParticipantId === ownerId) {
      return res.status(400).json({ 
        message: "You cannot send a message to yourself on your own listing.",
        errorType: "SELF_MESSAGE_NOT_ALLOWED"
      });
    }

    const senderRole = isOwner ? "owner" : "participant";
    const recipientId = isOwner ? participantId : ownerId;
    
    const encryptedMessage = encryptMessage(message);

    // ✅ Save the message FIRST (priority)
    const newMessage = await Message.create({
      relatedTo: resourceType,
      [resourceType]: resourceId,
      owner: ownerId,
      participant: resolvedParticipantId,
      senderRole,
      message: encryptedMessage,
      createdAt: createdAt || undefined,
      readBy: null,
      replyTo: replyTo || null,
    });

    // Populate replyTo if it exists
    if (newMessage.replyTo) {
      await newMessage.populate({
        path: 'replyTo',
        select: 'message senderRole deletedAt owner participant'
      });
    }
    
// Create a decrypted copy for Socket.IO
const decryptedMessage = {
  ...newMessage.toObject(),
  message, // Overwrite encrypted with plaintext
  canDelete: true, // New messages can be deleted by the sender
  isDeleted: false,
};

// If there's a replyTo, decrypt and format it
if (decryptedMessage.replyTo && decryptedMessage.replyTo.message) {
  decryptedMessage.replyTo = {
    _id: decryptedMessage.replyTo._id,
    message: decryptedMessage.replyTo.deletedAt ? '[Message deleted]' : decryptMessage(decryptedMessage.replyTo.message),
    senderRole: decryptedMessage.replyTo.senderRole,
    deletedAt: decryptedMessage.replyTo.deletedAt,
    owner: decryptedMessage.replyTo.owner,
    participant: decryptedMessage.replyTo.participant
  };
}

// ✅ Emit via Socket.IO (real-time update) with decrypted message
const io = getIO();

// Emit via Socket.IO
io.to(recipientId).emit("newMessage", decryptedMessage);
io.to(userId).emit("messageSent", decryptedMessage);  

// ✅ Immediately respond success (non-blocking)
res.status(201).json({
  message: "Message sent",
  data: {
    ...decryptedMessage,
    canDelete: true,
    isDeleted: false,
  },
});

    // 🟡 Email notification logic (run in the background)
    
    const recipientUser = await User.findById(recipientId);
    // Use 0 minutes for development, 30 minutes for production
    const NOTIFY_COOLDOWN_MINUTES = process.env.NODE_ENV === 'development' ? 0 : 30;

    const shouldSendChatNotification = (user) => {
      if (!user.chatNotifiedAt) return true;
      const now = Date.now();
      const lastNotified = new Date(user.chatNotifiedAt).getTime();
      const diffMinutes = (now - lastNotified) / (1000 * 60);
      return diffMinutes >= NOTIFY_COOLDOWN_MINUTES;
    };

    if (shouldSendChatNotification(recipientUser)) {
      try {
        // Pass event date only for recurring events
        const eventDate = resourceType === 'event' && resource.recurrence?.isRecurring && resource.dateTime
          ? resource.dateTime
          : null;
        // Use dealTitle for deals, title for others
        const resourceTitle = resourceType === 'deal' ? resource.dealTitle : resource.title;
        await sendNewMessageNotificationEmail(recipientUser, resourceType, resourceTitle, message, eventDate);
        recipientUser.chatNotifiedAt = new Date();
        await recipientUser.save();
      } catch (emailError) {
        console.error('❌ Notification email failed:', emailError.message);
        // Do NOT block anything here; email is non-critical
      }
    }

  } catch (error) {
    console.error("❌ Error in sendMessage controller:", error);
    return res.status(500).json({ message: "Error sending message." });
  }
};

// Fetch Messages API
export const fetchMessages = async (req, res) => {
  const { resourceType, resourceId, otherUserId } = req.query;
  const userId = req.user.id;

  try {
    const Model = getResourceModel(resourceType);
    // Select different fields based on resource type
    let selectFields = 'title images postedBy';
    if (resourceType === 'event') {
      selectFields = 'title images postedBy eventCode dateTime timeZone recurrence';
    } else if (resourceType === 'deal') {
      selectFields = 'dealTitle images postedBy partnerstoreId';
    }
    
    const resource = await Model.findById(resourceId).select(selectFields);
    if (!resource) {
      return res.status(404).json({ message: `${resourceType} not found.` });
    }

    const ownerId = resource.postedBy.toString();
    const resolvedParticipantId = userId === ownerId ? otherUserId : userId;

    const messages = await Message.find({
      relatedTo: resourceType,
      [resourceType]: resourceId,
      owner: ownerId,
      participant: resolvedParticipantId,
    })
      .populate({
        path: 'replyTo',
        select: 'message senderRole deletedAt'
      })
      .sort({ createdAt: 1 })
      .lean();

      const sanitizedMessages = messages.map((msg) => {
        const isSentByMe =
          (msg.senderRole === 'owner' && msg.owner.toString() === userId) ||
          (msg.senderRole === 'participant' && msg.participant.toString() === userId);
      
        // Decrypt the message!
        const decryptedMessage = decryptMessage(msg.message);
        
        // Handle reply data
        let replyData = null;
        if (msg.replyTo) {
          replyData = {
            _id: msg.replyTo._id,
            message: msg.replyTo.deletedAt ? '[Message deleted]' : decryptMessage(msg.replyTo.message),
            senderRole: msg.replyTo.senderRole,
            isDeleted: !!msg.replyTo.deletedAt
          };
        }
      
        return {
          ...msg,
          message: msg.deletedAt ? '[Message deleted]' : decryptedMessage,
          isRead: msg.readBy?.toString() === (isSentByMe ? otherUserId : userId),
          replyTo: replyData,
          isDeleted: !!msg.deletedAt,
          canDelete: isSentByMe && !msg.deletedAt, // Only sender can delete their own messages
        };
      });
      

    // ✅ Fetch user details safely with fallback
    const owner = await User.findById(ownerId).select('name email');
    const participant = await User.findById(resolvedParticipantId).select('name email');

    const ownerDetails = owner
      ? { id: owner._id, name: owner.name }
      : { id: ownerId, name: '[Former Member]' };

    const participantDetails = participant
      ? { id: participant._id, name: participant.name }
      : { id: resolvedParticipantId, name: '[Former Member]' };

    // Build resource data with type-specific fields
    const resourceData = {
      id: resource._id,
      title: resourceType === 'deal' ? resource.dealTitle : resource.title,
      image: resource.images?.[0]?.url || null,
    };

    // Add event-specific fields if it's an event
    if (resourceType === 'event') {
      resourceData.eventCode = resource.eventCode;
      resourceData.dateTime = resource.dateTime;
      resourceData.timeZone = resource.timeZone;
      resourceData.recurrence = resource.recurrence;
    }

    // Add deal-specific fields if it's a deal
    if (resourceType === 'deal') {
      resourceData.partnerstoreId = resource.partnerstoreId;
    }
    
    return res.status(200).json({
      messages: sanitizedMessages,
      resourceType,
      [resourceType]: resourceData,
      participants: {
        owner: ownerDetails,
        participant: participantDetails,
      },
    });
  } catch (err) {
    console.error('Error in fetchMessages:', err);
    return res.status(500).json({ message: 'Failed to fetch messages.' });
  }
};


// Get Conversations API
export const getConversations = async (req, res) => {
  const userId = req.user.id;
  

  try {
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { owner: new mongoose.Types.ObjectId(userId) },
            { participant: new mongoose.Types.ObjectId(userId) },
          ],
          deletedBy: { $ne: new mongoose.Types.ObjectId(userId) }, // ✅ Only include if NOT deleted by current user
        },
      },
      {
        $group: {
          _id: {
            relatedTo: "$relatedTo",
            resourceId: {
              $switch: {
                branches: [
                  { case: { $eq: ["$relatedTo", "advert"] }, then: "$advert" },
                  { case: { $eq: ["$relatedTo", "event"] }, then: "$event" },
                  { case: { $eq: ["$relatedTo", "deal"] }, then: "$deal" },
                ],
                default: null
              }
            },
            owner: "$owner",
            participant: "$participant",
          },
          lastMessage: { $last: "$$ROOT" },
          lastMessageTime: { $last: "$createdAt" }, // Add timestamp for sorting
        },
      },
      {
        $sort: { lastMessageTime: -1 } // Sort by most recent message first
      }
    ]);

    const results = [];

    for (const conv of conversations) {
      const { relatedTo, resourceId, owner, participant } = conv._id;

      const Model = getResourceModel(relatedTo);
      if (!Model) {
        console.error(`No model found for relatedTo: ${relatedTo}`);
        continue;
      }

      // Select different fields based on resource type
      let selectFields = "title images";
      if (relatedTo === 'event') {
        selectFields = "title images eventCode dateTime timeZone recurrence";
      } else if (relatedTo === 'deal') {
        selectFields = "dealTitle images partnerstoreId";
      }
      
      const resource = await Model.findById(resourceId).select(selectFields);
      if (!resource) {
        console.warn(`Resource ${relatedTo} with ID ${resourceId} not found`);
        continue;
      }

      const otherUserId = userId === owner.toString() ? participant : owner;
      const otherUser = await User.findById(otherUserId).select("name email");

      const otherUserDetails = otherUser
        ? { id: otherUser._id, name: otherUser.name, email: otherUser.email }
        : { id: otherUserId, name: '[Former Member]', email: '' }; // ✅ Graceful fallback for deleted users

        

      const conversationData = {
        resourceType: relatedTo,
        resourceId,
        title: relatedTo === 'deal' ? resource.dealTitle : resource.title,
        image: resource.images?.[0]?.url || null,
        lastMessage: {
          text: decryptMessage(conv.lastMessage.message),
          createdAt: conv.lastMessage.createdAt,
          senderRole: conv.lastMessage.senderRole,
        },
        otherUser: otherUserDetails,
        ownerId: owner.toString(), // Add owner ID to help frontend determine user's role
      };

      // Add event-specific fields if it's an event
      if (relatedTo === 'event') {
        conversationData.eventCode = resource.eventCode;
        conversationData.dateTime = resource.dateTime;
        conversationData.timeZone = resource.timeZone;
        conversationData.recurrence = resource.recurrence;
      }

      // Add deal-specific fields if it's a deal
      if (relatedTo === 'deal' && resource.partnerstoreId) {
        const PartnerStore = (await import('../../models/dailydeals/partnerStore.js')).default;
        const store = await PartnerStore.findById(resource.partnerstoreId).select('businessName');
        conversationData.businessName = store?.businessName || null;
      }
      
      results.push(conversationData);
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error("Error in getConversations:", err);
    return res.status(500).json({ message: "Failed to get conversations." });
  }
};



// Delete Conversation API
export const deleteConversation = async (req, res) => {
  const { resourceType, resourceId, otherUserId } = req.body;
  const userId = req.user.id;

  try {
    const Model = getResourceModel(resourceType);
    const resource = await Model.findById(resourceId);
    if (!resource) {
      return res.status(404).json({ message: `${resourceType} not found.` });
    }

    const ownerId = resource.postedBy.toString();
    const participantId = userId === ownerId ? otherUserId : userId;

    const messages = await Message.find({
      relatedTo: resourceType,
      [resourceType]: resourceId,
      owner: ownerId,
      participant: participantId,
    });

    if (messages.length === 0) {
      return res.status(404).json({ message: 'No conversation found to delete.' });
    }

    await Message.updateMany(
      {
        relatedTo: resourceType,
        [resourceType]: resourceId,
        owner: ownerId,
        participant: participantId,
      },
      { $addToSet: { deletedBy: userId } }
    );

    const updatedMessages = await Message.find({
      relatedTo: resourceType,
      [resourceType]: resourceId,
      owner: ownerId,
      participant: participantId,
    });

    const allDeleted = updatedMessages.every(
      (msg) => msg.deletedBy.includes(ownerId) && msg.deletedBy.includes(participantId)
    );

    if (allDeleted) {
      await Message.deleteMany({
        relatedTo: resourceType,
        [resourceType]: resourceId,
        owner: ownerId,
        participant: participantId,
      });
      return res.status(200).json({ message: 'Conversation fully deleted.' });
    }

    return res.status(200).json({ message: 'Conversation deleted for you.' });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to delete conversation.' });
  }
};

// Delete Single Message API (Soft Delete)
export const deleteMessage = async (req, res) => {
  const { messageId } = req.params;
  const userId = req.user.id;

  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    // Check if user is the sender
    const isSender = 
      (message.senderRole === 'owner' && message.owner.toString() === userId) ||
      (message.senderRole === 'participant' && message.participant.toString() === userId);

    if (!isSender) {
      return res.status(403).json({ message: 'You can only delete your own messages.' });
    }

    // Check if already deleted
    if (message.deletedAt) {
      return res.status(400).json({ message: 'Message already deleted.' });
    }

    // Soft delete
    message.deletedAt = new Date();
    message.deletedBy.push(userId);
    await message.save();

    // Emit socket event for real-time update
    const io = getIO();
    const recipientId = message.senderRole === 'owner' 
      ? message.participant.toString() 
      : message.owner.toString();
      
    io.to(recipientId).emit('messageDeleted', {
      messageId,
      resourceType: message.relatedTo,
      resourceId: message[message.relatedTo].toString()
    });
    
    // Also emit to the sender for consistency
    io.to(userId).emit('messageDeleted', {
      messageId,
      resourceType: message.relatedTo,
      resourceId: message[message.relatedTo].toString()
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Message deleted successfully.',
      messageId 
    });
  } catch (err) {
    console.error('Error deleting message:', err);
    return res.status(500).json({ message: 'Failed to delete message.' });
  }
};

// Get unread message count for authenticated user
export const getUnreadCount = async (req, res) => {
  const userId = req.user.id;
  
  try {
    const unreadCount = await Message.countDocuments({
      $or: [
        // Messages where I'm owner and participant sent it
        { owner: userId, senderRole: 'participant', readBy: null },
        // Messages where I'm participant and owner sent it  
        { participant: userId, senderRole: 'owner', readBy: null }
      ],
      deletedBy: { $ne: userId }, // Not deleted by me
      deletedAt: null // Not soft deleted
    });

    return res.status(200).json({ 
      success: true,
      unreadCount 
    });
  } catch (err) {
    console.error('Error getting unread count:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Failed to get unread count.' 
    });
  }
};


