import asyncHandler from 'express-async-handler';
import Thread from '../../../models/threadModel.js';
import ThreadMessage from '../../../models/threadMessageModel.js';
import User from '../../../models/userModel.js';
import { deleteThreadNotification } from '../../../utils/notifications/threads/sendThreadNotifications.js';
import cloudinary from '../../../utils/cloudinary.js';

// @desc    Get all threads for moderation with pagination
// @route   GET /api/admin/threads/manage
// @access  Admin only
export const getManageThreads = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    const total = await Thread.countDocuments();
    
    const threads = await Thread.find({})
      .populate('owner', 'name email')
      .sort({ createdAt: -1 }) // Most recent first
      .skip(skip)
      .limit(limit);

    // Format threads for response
    const formattedThreads = threads.map((thread) => ({
      _id: thread._id,
      title: thread.title,
      authorName: thread.owner?.name || 'Unknown',
      authorEmail: thread.owner?.email || 'N/A',
      createdAt: thread.createdAt
    }));

    return res.status(200).json({
      success: true,
      threads: formattedThreads,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalThreads: total
    });
  } catch (error) {
    console.error('Error fetching threads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch threads',
      error: error.message
    });
  }
});

// @desc    Delete thread by ID (Admin)
// @route   DELETE /api/admin/threads/byid/:id
// @access  Admin only
export const deleteThreadById = asyncHandler(async (req, res) => {
  console.log('🗑️ Admin Delete Thread:', req.params.id);

  try {
    const threadId = req.params.id;

    // Find the thread and populate owner for notification
    const thread = await Thread.findById(threadId).populate('owner', 'email');
    if (!thread) {
      return res.status(404).json({ 
        success: false, 
        message: 'Thread not found' 
      });
    }

    const FALLBACK_PUBLIC_ID =
      process.env.FALLBACK_THREAD_IMAGE_PUBLIC_ID || "tagtelugudev/assets/No_Image_Available_mq5h6q";

    // Delete non-fallback images from Cloudinary
    if (thread.images && thread.images.length > 0) {
      for (const image of thread.images) {
        try {
          if (image.publicId && image.publicId !== FALLBACK_PUBLIC_ID) {
            await cloudinary.uploader.destroy(image.publicId);
            console.log(`🖼️ Deleted thread image: ${image.publicId}`);
          } else if (image.publicId === FALLBACK_PUBLIC_ID) {
            console.log(`ℹ️ Skipping fallback image: ${image.publicId}`);
          }
        } catch (err) {
          console.error(`❌ Error deleting image ${image.publicId}:`, err.message);
          // Continue with deletion even if image deletion fails
        }
      }
    }

    // Delete all associated thread messages
    const messageDeleteResult = await ThreadMessage.deleteMany({ thread: threadId });
    console.log(`💬 Deleted ${messageDeleteResult.deletedCount} thread messages`);

    // Remove threadId from mutedThreads of all users
    const userUpdateResult = await User.updateMany(
      { mutedThreads: threadId },
      { $pull: { mutedThreads: threadId } }
    );
    console.log(`🔕 Removed thread from ${userUpdateResult.modifiedCount} users' muted lists`);

    // Send deletion notification
    try {
      await deleteThreadNotification({ type: 'deletedByAdmin', thread });
    } catch (notifyErr) {
      console.warn("⚠️ Thread deletion notification failed:", notifyErr.message);
      // Continue with deletion even if notification fails
    }

    // Delete the thread
    await Thread.deleteOne({ _id: threadId });

    return res.status(200).json({
      success: true,
      message: 'Thread and all related content deleted successfully'
    });

  } catch (error) {
    console.error('❌ Error deleting thread:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error while deleting thread',
      error: error.message 
    });
  }
});