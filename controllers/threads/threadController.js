import asyncHandler from 'express-async-handler';
import Thread from '../../models/threadModel.js';
import ThreadMessage from '../../models/threadMessageModel.js';
import User from '../../models/userModel.js';
import { getIO } from '../../socket/index.js';
import cloudinary from '../../utils/cloudinary.js';
import { determineThreadRecipients, shouldSendThreadNotification } from '../../utils/notifications/threads/threadNotificationHelpers.js';
import { sendThreadNotificationEmail } from '../../utils/notifications/threads/threadNotificationEmail.js';
import {
  addThreadNotification,
  updateThreadNotification,
  deleteThreadNotification,
} from '../../utils/notifications/threads/sendThreadNotifications.js';
import { COMMUNITY_VALUES } from '../../utils/constants/communities.js';
import { sanitizeThreadHtml, threadTextLength } from '../../utils/helpers/shared/sanitize.js';
import { refreshFrontendCache } from '../../utils/refreshFrontendCache.js';

// Shared cap: the visible text of a thread description may not exceed this (HTML wrapping excluded).
const THREAD_TEXT_LIMIT = 15000;

const CURATOR_EMAILS = (process.env.CURATOR_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);


// Helper function to generate optimized image URLs
const generateOptimizedImageUrls = (images) => {
  const FALLBACK_URL = process.env.FALLBACK_THREAD_IMAGE_URL;
  const FALLBACK_PUBLIC_ID = process.env.FALLBACK_THREAD_IMAGE_PUBLIC_ID;
  
  if (!images || images.length === 0) return images;
  
  return images.map(image => {
    const isFallbackImage = image.publicId === FALLBACK_PUBLIC_ID || image.url === FALLBACK_URL;
    
    if (isFallbackImage) {
      // For fallback images, use the same URL for all sizes
      return {
        ...image,
        url: FALLBACK_URL,
        optimizedUrls: {
          mobile: FALLBACK_URL,
          desktop: FALLBACK_URL,
          fullscreen: FALLBACK_URL
        }
      };
    } else if (image.publicId && !isFallbackImage) {
      // For regular images, construct optimized URLs
      return {
        ...image,
        optimizedUrls: {
          // Grid view thumbnails with c_fill
          mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_320,h_160,c_fill/${image.publicId}`,
          desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_448,h_224,c_fill/${image.publicId}`,
          // Detail view with c_fit
          mobileDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,h_200,c_fit/${image.publicId}`,
          desktopDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,h_400,c_fit/${image.publicId}`,
          fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
        },
        ogImageUrl: `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${image.publicId}`
      };
    } else {
      // If no publicId and not a fallback, return image as-is
      return {
        ...image,
        optimizedUrls: null,
        ogImageUrl: null
      };
    }
  });
};


// Create a Thread
export const createThread = asyncHandler(async (req, res) => {
  let { title, question, category, suburb, communities, author } = req.body;
  const userId = req.user?.id;

  console.log('🧵 === CREATE THREAD REQUEST ===');
  console.log('👤 User ID:', userId);
  console.log('📝 Title:', title);
  console.log('❓ Question:', question?.substring(0, 50) + '...');
  console.log('🏷️ Category:', category);
  console.log('🏘️ Communities:', communities);
  console.log('📍 Suburb (raw):', typeof suburb, suburb);
  console.log('🖼️ Images count:', req.files?.length || 0);

  if (!userId) {
    console.log('❌ User not authenticated');
    return res.status(401).json({ message: "Unauthorized: User not authenticated" });
  }

  if (!title || !question || !category) {
    console.log('❌ Missing required fields:', { title: !!title, question: !!question, category: !!category });
    return res.status(400).json({ message: "Title, question, and category are required." });
  }

  // Rich-text wall: enforce the visible-text cap on what the client sent, then sanitise to the
  // allowlist before anything is stored. A crafted request that bypasses the toolbar comes out clean.
  if (threadTextLength(question) > THREAD_TEXT_LIMIT) {
    return res.status(400).json({ message: `Description must be ${THREAD_TEXT_LIMIT} characters or less.` });
  }
  question = sanitizeThreadHtml(question);

  // Parse and validate communities
  let parsedCommunities = [];
  if (communities) {
    try {
      parsedCommunities = typeof communities === 'string' ? JSON.parse(communities) : communities;
    } catch (error) {
      return res.status(400).json({ message: 'Invalid JSON format for communities' });
    }
    
    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        return res.status(400).json({ 
          message: `Invalid communities: ${invalidCommunities.join(', ')}` 
        });
      }
    }
  }

  // Parse author data if provided
  let parsedAuthor = null;
  if (author) {
    try {
      parsedAuthor = typeof author === 'string' ? JSON.parse(author) : author;
      
      // Validate aboutMyself length
      if (parsedAuthor.aboutMyself && parsedAuthor.aboutMyself.length > 500) {
        return res.status(400).json({ message: 'About Myself must be 500 characters or less' });
      }
    } catch (error) {
      return res.status(400).json({ message: 'Invalid JSON format for author data' });
    }
  }

  // ✅ Parse suburb if sent as string
  if (typeof suburb === 'string') {
    console.log('📍 Parsing suburb from string...');
    try {
      suburb = JSON.parse(suburb);
      console.log('📍 Suburb parsed successfully:', suburb);
    } catch (err) {
      console.log('❌ Failed to parse suburb:', err.message);
      return res.status(400).json({ message: "Invalid suburb data format" });
    }
  }

  // ✅ Validate suburb - postal code is now optional
  const { name: suburbName, state, postalCode, location } = suburb || {};
  console.log('📍 Suburb validation:', {
    suburbName,
    state,
    postalCode: postalCode || '(empty)',
    hasCoordinates: !!location?.coordinates,
    coordinatesLength: location?.coordinates?.length
  });
  
  if (!suburbName || !state || !Array.isArray(location?.coordinates) || location.coordinates.length !== 2) {
    console.log('❌ Suburb validation failed');
    return res.status(400).json({ message: 'Invalid or missing suburb data' });
  }

  const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';
  let imagesDetails = [];

  // Handle both old array format and new fields format from multer
  let fileArray = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      fileArray = req.files;
    } else if (req.files.images) {
      // When using .fields(), images are in req.files.images
      fileArray = req.files.images;
    }
  }
  const validFiles = fileArray.filter(file => file && file.size > 0);

  // Validate image types and sizes
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const maxSize = 10 * 1024 * 1024; // 10MB per image
  const maxImages = 10; // Maximum number of images allowed

  // Check maximum image limit
  if (validFiles.length > maxImages) {
    return res.status(400).json({ message: `Maximum ${maxImages} images allowed` });
  }

  // Validate each image
  for (let i = 0; i < validFiles.length; i++) {
    const file = validFiles[i];
    
    // Check file type
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        message: `Image ${i + 1}: Only JPEG, PNG, and WebP formats are allowed`
      });
    }
    
    // Check file size
    if (file.size > maxSize) {
      return res.status(400).json({ 
        message: `Image ${i + 1}: File size must be under 10MB`
      });
    }
  }

  if (validFiles.length > 0) {
    try {
      for (const file of validFiles) {
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
          {
            folder: `${folderName}/threads`,
            transformation: [
              { 
                fetch_format: 'auto', 
                quality: 'auto:good',
                width: 1200,
                height: 1200,
                crop: 'limit'
              }
            ],
          }
        );
        imagesDetails.push({ url: result.secure_url, publicId: result.public_id, originalFilename: file.originalname });
      }
    } catch (error) {
      return res.status(500).json({ message: "Image upload failed: " + error.message });
    }
  }
  // If no images provided, imagesDetails remains empty array

  console.log('🔨 Creating thread with data:', {
    title,
    category,
    owner: userId,
    imagesCount: imagesDetails.length,
    suburb: {
      name: suburb.name,
      state: suburb.state,
      postalCode: suburb.postalCode || '(empty)'
    },
    communities: parsedCommunities
  });

  const thread = await Thread.create({
    title,
    question,
    category,
    owner: userId,
    participants: [userId],
    images: imagesDetails,
    suburb: suburb,
    communities: parsedCommunities,
    author: parsedAuthor,
    // ✅ Curated thread flag (auto-set when creator's email is in CURATOR_EMAILS)
    isCuratedThread: !!req.user?.email && CURATOR_EMAILS.includes(req.user.email.toLowerCase()),
  });

  console.log('✅ Thread created successfully:', {
    id: thread._id,
    title: thread.title,
    category: thread.category,
    suburb: thread.suburb.name + ', ' + thread.suburb.state
  });
  
  // Send notfication email to the thread owne
  await thread.populate('owner', 'email');
  try {
    await addThreadNotification({ type: 'created', thread });
    console.log('📧 Thread creation notification sent');
  } catch (notifyErr) {
    console.warn('⚠️ Thread creation notification failed:', notifyErr.message);
  }

  res.status(201).json(thread);
});



// Fetch All Threads
export const getThreads = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;

  const pageNumber = parseInt(page, 10);
  const limitNumber = parseInt(limit, 10);
  const skip = (pageNumber - 1) * limitNumber;

  try {
    const pipeline = [
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNumber },

      // Join messages to get comment count
      {
        $lookup: {
          from: 'threadmessages',
          localField: '_id',
          foreignField: 'thread',
          as: 'messages',
        },
      },
      {
        $addFields: {
          commentCount: { $size: '$messages' },
          commented: { $gt: [{ $size: '$messages' }, 0] },
        },
      },
      {
        $project: {
          messages: 0, // exclude full message content
        },
      },
      // Populate owner details (as you're doing via populate)
      {
        $lookup: {
          from: 'users',
          localField: 'owner',
          foreignField: '_id',
          as: 'owner',
        },
      },
      {
        $unwind: {
          path: '$owner',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          'owner.password': 0, // hide sensitive fields if any
        },
      },
    ];

    const threads = await Thread.aggregate(pipeline);

    // Generate optimized image URLs
    const threadsWithOptimizedImages = threads.map(thread => {
      if (thread.images && thread.images.length > 0) {
        thread.images = generateOptimizedImageUrls(thread.images);
      }
      return thread;
    });

    const totalItems = await Thread.countDocuments();
    const totalPages = Math.ceil(totalItems / limitNumber);

    return res.status(200).json({
      success: true,
      threads: threadsWithOptimizedImages,
      meta: {
        totalItems,
        currentPage: pageNumber,
        totalPages,
        itemsPerPage: limitNumber,
      },
    });
  } catch (error) {
    console.error('Error fetching threads:', error);
    res.status(500).json({ message: 'Failed to fetch threads' });
  }
});


// Fetch User's Threads
export const getUserThreads = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const threads = await Thread.find({ owner: userId }).populate('owner', 'name').lean();
  
  // Generate optimized image URLs
  const threadsWithOptimizedImages = threads.map(thread => {
    if (thread.images && thread.images.length > 0) {
      thread.images = generateOptimizedImageUrls(thread.images);
    }
    return thread;
  });
  
  res.status(200).json(threadsWithOptimizedImages);
});

// Fetch Thread Messages
export const getThreadMessages = asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const messages = await ThreadMessage.find({ thread: threadId })
    .populate('sender', 'name')
    .populate({
      path: 'replyTo',
      select: 'message sender',
      populate: {
        path: 'sender',
        select: 'name'
      }
    });
  res.status(200).json(messages);
});

// Send Message
export const sendMessage = asyncHandler(async (req, res) => {
  const { threadId, message, createdAt, replyTo } = req.body;
  const userId = req.user.id;

  if (!threadId || !message) {
    return res.status(400).json({ message: "Thread ID and message are required." });
  }

  const sender = await User.findById(userId).select("name");
  if (!sender) return res.status(404).json({ message: "Sender not found." });

  const threadMessage = await ThreadMessage.create({
    thread: threadId,
    sender: userId,
    message,
    replyTo: replyTo || null,
    createdAt: createdAt || undefined, // 🟢 Now this works
  });

  await Thread.findByIdAndUpdate(threadId, {
    $addToSet: { participants: userId },
  });

  // Populate the replyTo field if it exists
  let populatedMessage = threadMessage;
  if (replyTo) {
    populatedMessage = await ThreadMessage.findById(threadMessage._id)
      .populate('sender', 'name')
      .populate({
        path: 'replyTo',
        select: 'message sender',
        populate: {
          path: 'sender',
          select: 'name'
        }
      });
  }

  const messageWithSender = {
    ...populatedMessage.toObject(),
    sender: { _id: sender._id, name: sender.name },
  };

  const io = getIO();
  io.to(threadId).emit('newThreadMessage', messageWithSender);

  res.status(201).json(messageWithSender);

  // 🚀 Tail-end: Notification logic (non-blocking)
  try {
    const thread = await Thread.findById(threadId).select('title participants');
    const recipients = await determineThreadRecipients(thread, userId);

    for (const recipient of recipients) {
      if (shouldSendThreadNotification(recipient, thread._id)) {
        try {
          await sendThreadNotificationEmail(recipient, thread.title, thread._id, message);
          // Update per-thread notification timestamp
          if (!recipient.threadNotifyAtByThread) {
            recipient.threadNotifyAtByThread = new Map();
          }
          recipient.threadNotifyAtByThread.set(thread._id.toString(), new Date());
          recipient.threadNotifiedAt = new Date(); // Keep global timestamp for backward compatibility
          await recipient.save();
        } catch (emailError) {
          console.error(`❌ Email notification failed for ${recipient.email}:`, emailError.message);
        }
      }
    }
  } catch (notifyError) {
    console.error('❌ Notification logic error:', notifyError.message);
  }

});


// Like a Message
export const likeMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const message = await ThreadMessage.findById(messageId);
  if (!message) return res.status(404).json({ message: "Message not found" });

  message.likes += 1;
  await message.save();

  res.status(200).json({ message: "Liked successfully", likes: message.likes, dislikes: message.dislikes });
});

// Unlike a Message
export const unlikeMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const message = await ThreadMessage.findById(messageId);
  if (!message) return res.status(404).json({ message: "Message not found" });

  message.dislikes += 1;
  await message.save();

  res.status(200).json({ message: "Disliked successfully", likes: message.likes, dislikes: message.dislikes });
});

// Delete a Message (Soft Delete)
export const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const userId = req.user.id;

  // Find the message
  const message = await ThreadMessage.findById(messageId);
  if (!message) {
    return res.status(404).json({ message: "Message not found" });
  }

  // Check if user owns the message
  if (message.sender.toString() !== userId) {
    return res.status(403).json({ message: "Unauthorized to delete this message" });
  }

  // Check if already deleted
  if (message.deletedAt) {
    return res.status(400).json({ message: "Message already deleted" });
  }

  // Soft delete the message
  message.deletedAt = new Date();
  message.deletedBy = userId;
  await message.save();

  // Emit socket event for real-time update
  const io = getIO();
  io.to(message.thread.toString()).emit('messageDeleted', {
    messageId: message._id,
    threadId: message.thread,
    deletedAt: message.deletedAt,
    deletedBy: message.deletedBy
  });

  res.status(200).json({ 
    message: "Message deleted successfully",
    messageId: message._id
  });
});


// update a Thread Owned By User
export const updateThread = asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const userId = req.user.id;

  console.log('🔄 === UPDATE THREAD REQUEST ===');
  console.log('🔗 Thread ID:', threadId);
  console.log('👤 User ID:', userId);
  console.log('📝 Title:', req.body.title);
  console.log('❓ Question:', req.body.question?.substring(0, 50) + '...');
  console.log('🏷️ Category:', req.body.category);
  console.log('🏘️ Communities (raw):', req.body.communities);
  console.log('📍 Suburb (raw):', typeof req.body.suburb, req.body.suburb);
  console.log('🖼️ New images count:', req.files?.length || 0);
  console.log('📸 Existing images:', req.body.existingImages);

  const thread = await Thread.findById(threadId);
  if (!thread) {
    console.log('❌ Thread not found:', threadId);
    return res.status(404).json({ message: 'Thread not found' });
  }

  if (thread.owner.toString() !== userId) {
    console.log('❌ Unauthorized edit attempt:', {
      threadOwner: thread.owner.toString(),
      requestUser: userId
    });
    return res.status(403).json({ message: 'Unauthorized to edit this thread' });
  }

  let { title, question, category, suburb, communities, author } = req.body;

  // Rich-text wall on update: cap the visible text and sanitise before the new description is stored.
  // A legacy plain-text description re-sent unchanged has no tags, so it is returned byte-identical.
  if (question !== undefined && question !== null) {
    if (threadTextLength(question) > THREAD_TEXT_LIMIT) {
      return res.status(400).json({ message: `Description must be ${THREAD_TEXT_LIMIT} characters or less.` });
    }
    question = sanitizeThreadHtml(question);
  }

  // Parse and validate communities
  let parsedCommunities = [];
  if (communities) {
    console.log('🏘️ Parsing communities...');
    try {
      parsedCommunities = typeof communities === 'string' ? JSON.parse(communities) : communities;
      console.log('✅ Communities parsed:', parsedCommunities);
    } catch (error) {
      console.log('❌ Failed to parse communities:', error.message);
      return res.status(400).json({ message: 'Invalid JSON format for communities' });
    }
    
    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        console.log('❌ Invalid communities detected:', invalidCommunities);
        return res.status(400).json({ 
          message: `Invalid communities: ${invalidCommunities.join(', ')}` 
        });
      }
    }
  }

  // Parse author data if provided
  let parsedAuthor = null;
  if (author) {
    try {
      parsedAuthor = typeof author === 'string' ? JSON.parse(author) : author;
      
      // Validate aboutMyself length
      if (parsedAuthor.aboutMyself && parsedAuthor.aboutMyself.length > 500) {
        return res.status(400).json({ message: 'About Myself must be 500 characters or less' });
      }
    } catch (error) {
      return res.status(400).json({ message: 'Invalid JSON format for author data' });
    }
  }

  if (typeof suburb === 'string') {
    console.log('📍 Parsing suburb from string...');
    try {
      suburb = JSON.parse(suburb);
      console.log('📍 Suburb parsed successfully:', suburb);
    } catch (err) {
      console.log('❌ Failed to parse suburb:', err.message);
      return res.status(400).json({ message: "Invalid suburb data format" });
    }
  }

  /* -------------------- Parse existingImages -------------------- */
  let keepImages = [];
  if (req.body.existingImages) {
    console.log('📸 Processing existing images...');
    const existingImagesData = Array.isArray(req.body.existingImages)
      ? req.body.existingImages
      : [req.body.existingImages];

    keepImages = existingImagesData.map((item) => JSON.parse(item));
    console.log('📸 Keeping', keepImages.length, 'existing images');
  }

  /* -------------------- Delete removed images -------------------- */
  const removedImages = thread.images.filter(
    (dbImg) =>
      !keepImages.some((kImg) => kImg.publicId === dbImg.publicId)
  );

  if (removedImages.length > 0) {
    console.log('🗑️ Removing', removedImages.length, 'images from Cloudinary');
    try {
      for (const img of removedImages) {
        await cloudinary.uploader.destroy(img.publicId);
        console.log('✅ Deleted image:', img.publicId);
      }
    } catch (err) {
      console.log('❌ Image deletion failed:', err.message);
      return res.status(500).json({
        success: false,
        message: "Image deletion failed: " + (err?.message || "Unknown error"),
      });
    }
  }

  /* -------------------- Upload new images -------------------- */
  const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";
  
  // Handle both old array format and new fields format from multer
  let fileArray = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      fileArray = req.files;
    } else if (req.files.images) {
      // When using .fields(), images are in req.files.images
      fileArray = req.files.images;
    }
  }
  const validFiles = fileArray.filter(file => file && file.size > 0);
  let newImages = [];

  // Validate image types and sizes
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const maxSize = 10 * 1024 * 1024; // 10MB per image
  const maxImages = 10; // Maximum number of images allowed

  // Check total image count (existing + new)
  const totalImages = keepImages.length + validFiles.length;
  if (totalImages > maxImages) {
    return res.status(400).json({ 
      success: false,
      message: `Maximum ${maxImages} images allowed. You have ${keepImages.length} existing and trying to add ${validFiles.length} new images.` 
    });
  }

  // Validate each new image
  for (let i = 0; i < validFiles.length; i++) {
    const file = validFiles[i];
    
    // Check file type
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        success: false,
        message: `Image ${i + 1}: Only JPEG, PNG, and WebP formats are allowed`
      });
    }
    
    // Check file size
    if (file.size > maxSize) {
      return res.status(400).json({ 
        success: false,
        message: `Image ${i + 1}: File size must be under 10MB`
      });
    }
  }

  if (validFiles.length > 0) {
    console.log('📤 Uploading', validFiles.length, 'new images...');
    try {
      for (const file of validFiles) {
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
          {
            folder: `${folderName}/threads`,
            transformation: [
              { 
                fetch_format: "auto", 
                quality: "auto:good",
                width: 1200,
                height: 1200,
                crop: "limit"
              }
            ],
          }
        );
        newImages.push({
          url: result.secure_url,
          publicId: result.public_id,
          originalFilename: file.originalname,
        });
        console.log('✅ Uploaded image:', result.public_id);
      }
    } catch (error) {
      console.log('❌ Image upload failed:', error.message);
      return res.status(500).json({
        success: false,
        message: "Image upload failed: " + (error?.message || "Unknown error"),
      });
    }
  }

  /* -------------------- Combine Images -------------------- */
  thread.images = [...keepImages, ...newImages];

  /* -------------------- Update fields -------------------- */
  thread.title = title || thread.title;
  thread.question = question || thread.question;
  thread.category = category || thread.category;
  thread.communities = communities !== undefined ? parsedCommunities : thread.communities;
  thread.author = author !== undefined ? parsedAuthor : thread.author;

  /* -------------------- Update suburb -------------------- */
  if (suburb) {
    const { name, state, postalCode, location } = suburb;
    console.log('📍 Updating suburb:', {
      name,
      state,
      postalCode: postalCode || '(empty)',
      hasCoordinates: !!location?.coordinates,
      coordinatesLength: location?.coordinates?.length
    });
    
    // Postal code is now optional
    if (name && state && Array.isArray(location?.coordinates) && location.coordinates.length === 2) {
      thread.suburb = {
        name,
        state,
        postalCode: postalCode || '',  // Allow empty postal code
        location: {
          type: 'Point',
          coordinates: location.coordinates
        }
      };
      console.log('✅ Suburb updated successfully');
    } else {
      console.log('⚠️ Skipping suburb update - missing required fields');
    }
  }

  
  // Save the updated thread
  console.log('💾 Saving thread updates...');
  const updatedThread = await thread.save();
  console.log('✅ Thread updated successfully:', {
    id: updatedThread._id,
    title: updatedThread.title,
    category: updatedThread.category,
    suburb: updatedThread.suburb.name + ', ' + updatedThread.suburb.state,
    imagesCount: updatedThread.images.length,
    communities: updatedThread.communities
  });

  // Send notification email to the thread owner
  await thread.populate('owner', 'email');
  try {
    await updateThreadNotification({ type: 'updated', thread });
    console.log('📧 Thread update notification sent');
  } catch (notifyErr) {
    console.warn('⚠️ Thread update notification failed:', notifyErr.message);
  }

  // Fresh share previews straight after the edit
  await refreshFrontendCache(`thread-${updatedThread._id}`);

  console.log('✅ === UPDATE THREAD COMPLETE ===');
  return res.status(200).json({
    message: 'Thread updated successfully',
    thread: updatedThread,
  });
});



// Delete a Thread Owned By User
export const deleteThread = asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const userId = req.user.id;

  const thread = await Thread.findById(threadId);
  if (!thread) {
    return res.status(404).json({ message: "Thread not found" });
  }

  if (thread.owner.toString() !== userId) {
    return res.status(403).json({ message: "Unauthorized to delete this thread" });
  }

  // Delete images from Cloudinary
  for (const image of thread.images) {
    if (image.publicId) {
      try {
        await cloudinary.uploader.destroy(image.publicId);
      } catch (err) {
        console.error(`Error deleting image ${image.publicId}:`, err.message);
      }
    }
  }

  // ✅ Delete associated messages
  await ThreadMessage.deleteMany({ thread: threadId });

  // ✅ Delete the thread itself
  await Thread.findByIdAndDelete(threadId);

  // ✅ Remove threadId from mutedThreads of all users
  await User.updateMany(
    { mutedThreads: threadId },
    { $pull: { mutedThreads: threadId } }
  );

  // Send notfication email to the thread owner
  await thread.populate('owner', 'email');
try {
  await deleteThreadNotification({ type: 'deleted', thread });
} catch (notifyErr) {
  console.warn('⚠️ Thread delete notification failed:', notifyErr.message);
}


  res.status(200).json({ message: "Thread, associated messages, and muted thread references deleted successfully" });
});



// Fetch Threads by Category
export const getThreadsByCategory = asyncHandler(async (req, res) => {
  const { category, page = 1, limit = 10 } = req.query;

  try {
    const pipeline = [];

    // Handle category filtering if category is provided
    if (category) {
      pipeline.push({
        $match: { category: { $regex: category, $options: 'i' } }, // Case-insensitive search
      });
    }

    // Add sorting by `createdAt` field in descending order (newest first)
    pipeline.push({
      $sort: { createdAt: -1 },
    });

    // Pagination logic
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const skip = (pageNumber - 1) * limitNumber;

    pipeline.push(
      { $skip: skip },
      { $limit: limitNumber }
    );

    // Fetch threads using aggregation pipeline
    const threads = await Thread.aggregate(pipeline);

    // Generate optimized image URLs
    const threadsWithOptimizedImages = threads.map(thread => {
      if (thread.images && thread.images.length > 0) {
        thread.images = generateOptimizedImageUrls(thread.images);
      }
      return thread;
    });

    // Total count calculation
    const totalCountPipeline = pipeline.filter(stage => !('$skip' in stage || '$limit' in stage)); // Remove pagination stages
    totalCountPipeline.push({ $count: 'totalCount' });
    const totalCountResult = await Thread.aggregate(totalCountPipeline);
    const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

    // Calculate total pages
    const totalPages = Math.ceil(totalCount / limitNumber);

    // Send response
    return res.status(200).json({
      success: true,
      threads: threadsWithOptimizedImages,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        totalPages,
        itemsPerPage: limitNumber,
      },
    });
  } catch (error) {
    console.error('Error fetching threads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch threads',
      error: error.message,
    });
  }
});

// Fetch a single Thread by ID (requires auth)
export const getThreadById = asyncHandler(async (req, res) => {
  const thread = await Thread.findById(req.params.threadId).lean();
  if (!thread) return res.status(404).json({ message: 'Thread not found' });
  
  // Generate optimized image URLs
  if (thread.images && thread.images.length > 0) {
    thread.images = generateOptimizedImageUrls(thread.images);
    // Only use optimized URL, skip raw images (frontend handles fallback)
    thread.ogImageUrl = thread.images[0].ogImageUrl || null;
  }

  res.status(200).json(thread);
});

// Fetch a single Thread by ID (public endpoint for meta tags)
export const getThreadByIdPublic = asyncHandler(async (req, res) => {
  const thread = await Thread.findById(req.params.threadId)
    .select('title question category images createdAt updatedAt author owner isCuratedThread suburb')
    .populate('owner', 'name')
    .lean();

  if (!thread) return res.status(404).json({ message: 'Thread not found' });

  // Defensive re-sanitise at the render source: the description is already cleaned on write, but this
  // guarantees the HTML delivered to dangerouslySetInnerHTML has passed the wall again.
  thread.question = sanitizeThreadHtml(thread.question);

  // Generate optimized image URLs
  if (thread.images && thread.images.length > 0) {
    thread.images = generateOptimizedImageUrls(thread.images);
    // Only use optimized URL, skip raw images (frontend handles fallback)
    thread.ogImageUrl = thread.images[0].ogImageUrl || null;
  }

  res.status(200).json({ thread });
});


// Get threads for sitemap
// Slug is generated dynamically by frontend using title + _id
export const getSitemapThreads = asyncHandler(async (req, res) => {
  try {
    const threads = await Thread.find({})
      .select('title _id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50000)
      .lean();

    return res.status(200).json(threads);
  } catch (error) {
    console.error('Error fetching threads for sitemap:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});
