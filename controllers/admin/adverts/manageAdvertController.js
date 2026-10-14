import asyncHandler from 'express-async-handler';
import Advert from '../../../models/advertModel.js';
import User from '../../../models/userModel.js';
import Message from '../../../models/messageModel.js';
import cloudinary from '../../../utils/cloudinary.js'; // Import Cloudinary config
import { sendAdvertReminder14, sendAdvertReminder7 } from '../../../utils/notifications/adverts/sendAdvertReminders.js';
import { addAdvertNotification, updateAdvertNotification, deleteAdvertNotification, renewAdvertNotification } from '../../../utils/notifications/adverts/sendAdvertNotifications.js';
import { getCategoryExpiryDays } from '../../../utils/constants/expiryConfig.js';

// @desc    Get all adverts (optional: with pagination).
// @route   GET /api/admin/adverts
// @access  Private (Admin only).
export const getAdverts = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const adverts = await Advert.find({})
    .skip(skip)
    .limit(limit);

  const totalAdverts = await Advert.countDocuments();

  res.status(200).json({
    success: true,
    adverts,
    currentPage: page,
    totalPages: Math.ceil(totalAdverts / limit),
    totalAdverts,
  });
});

// @desc    Get advert by ID
// @route   GET /api/admin/adverts/:id
// @access  Private (Admin only)
export const getAdvertById = asyncHandler(async (req, res) => {
  const advert = await Advert.findById(req.params.id);

  if (!advert) {
    return res.status(404).json({ message: 'Advert not found' });
  }

  res.status(200).json({
    success: true,
    advert,
  });
});

// @desc    Delete advert by ID (Admin)
// @route   DELETE /api/admin/adverts/:id
// @access  Private (Admin only)
export const deleteAdvert = asyncHandler(async (req, res) => {
  const advertId = req.params.id;

  console.log(`Admin Delete Advert: ${advertId}`);

  // 1️⃣ Find the advert by ID
  const advert = await Advert.findById(advertId).populate('postedBy', 'email');
  if (!advert) {
    return res.status(404).json({ success: false, message: 'Advert not found' });
  }

  const FALLBACK_PUBLIC_ID =
    process.env.FALLBACK_ADVERT_IMAGE_PUBLIC_ID || "tagtelugudev/assets/No_Image_Available_mq5h6q";

  // 2️⃣ Delete images from Cloudinary (except fallback)
  if (advert.images && advert.images.length > 0) {
    try {
      for (const image of advert.images) {
        if (image.publicId && image.publicId !== FALLBACK_PUBLIC_ID) {
          await cloudinary.uploader.destroy(image.publicId);
        } else {
          console.log(`ℹ️ Skipping fallback image: ${image.publicId}`);
        }
      }
    } catch (error) {
      console.error('❌ Cloudinary Deletion Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete images from Cloudinary',
        error: error?.message || error.toString(),
      });
    }
  }

  // 3️⃣ Delete all related conversations/messages
  try {
    const messageDeleteResult = await Message.deleteMany({
      relatedTo: 'advert',
      advert: advertId,
    });

    console.log(`💬 Deleted ${messageDeleteResult.deletedCount} related advert messages`);
  } catch (err) {
    console.error('❌ Error deleting related messages:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete related messages',
    });
  }

  // 4️⃣ Remove advert from all users' wishlists
  try {
    const wishlistUpdateResult = await User.updateMany(
      { wishlist: advertId },
      { $pull: { wishlist: advertId } }
    );
    console.log(`❤️ Removed advert from ${wishlistUpdateResult.modifiedCount} user wishlists`);
  } catch (err) {
    console.error('❌ Error removing advert from wishlists:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to remove advert from wishlists',
    });
  }

  // 5️⃣ Delete advert from DB
  try {
    const deleteResult = await Advert.deleteOne({ _id: advertId });

    if (deleteResult.deletedCount === 0) {
      return res.status(500).json({ success: false, message: 'Failed to delete advert from database' });
    }

    // 6️⃣ Send notification about deletion by admin
    try {
      await deleteAdvertNotification({ type: 'deletedByAdmin', advert });
    } catch (notifyErr) {
      console.warn("⚠️ Email deletion notification failed:", notifyErr.message);
      // Continue with success response even if notification fails
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Advert, images, wishlist entries, and related conversations deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Error deleting advert from DB:', error);
    return res.status(500).json({ success: false, message: 'Server error while deleting advert' });
  }
});


// @desc    Admin - Get all adverts for renewal management
// @route   GET /api/admin/adverts/manage
// @access  Admin only
// @desc    Admin - Get all adverts for renewal management
// @route   GET /api/admin/adverts/manage
// @access  Admin only
export const getManageAdverts = asyncHandler(async (req, res) => {
  console.log('[BACKEND] getManageAdverts called');
  console.log('[BACKEND] Request query:', req.query);
  console.log('[BACKEND] User:', req.user?.email);
  
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const now = new Date();
  console.log('[BACKEND] Pagination:', { page, limit, skip });

  try {
    const total = await Advert.countDocuments();
    console.log('[BACKEND] Total adverts in DB:', total);

    const adverts = await Advert.find({})
      .populate('postedBy', 'name email')
      .sort({ expiresAt: 1 }) // Updated to use expiresAt instead of willExpire
      .skip(skip)
      .limit(limit);
    
    console.log('[BACKEND] Found adverts:', adverts.length);

    const enrichedAdverts = adverts.map((advert) => {
      console.log(`🔍 ${advert.title} - expiresAt:`, advert.expiresAt);
      const expiryTime = new Date(advert.expiresAt).getTime();
      const daysLeft = Math.floor((expiryTime - now.getTime()) / (1000 * 60 * 60 * 24));

      // Check if notifications have been sent using the new structure
      const sentReminder14 = advert.notifications?.first !== null;
      const sentReminder7 = advert.notifications?.second !== null;

      let renewalStatus = 'valid';

      if (daysLeft <= 7 && daysLeft >= 0 && !sentReminder7) {
        renewalStatus = 'notify2'; // Send 7-day reminder
      } else if (daysLeft <= 14 && daysLeft > 7 && !sentReminder14) {
        renewalStatus = 'notify1'; // Send 14-day reminder
      } else if (daysLeft <= 14 && daysLeft > 7 && sentReminder14 && !sentReminder7) {
        renewalStatus = 'pendingNotification2'; // Sent 14-day but not 7-day
      } else if (daysLeft < 0) {
        renewalStatus = 'expired';
      }

      return {
        _id: advert._id,
        title: advert.title,
        email: advert.postedBy?.email || 'N/A',
        daysLeft,
        renewalStatus,
        expiresAt: advert.expiresAt, // Updated field name
      };
    });

    console.log('[BACKEND] Sending response with:', {
      advertCount: enrichedAdverts.length,
      page,
      totalPages: Math.ceil(total / limit)
    });
    
    return res.status(200).json({
      success: true,
      adverts: enrichedAdverts,
      meta: {
        totalItems: total,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching manage adverts:", error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch manage adverts',
      error: error.message,
    });
  }
});



// @desc    Admin - Send reminder email for advert renewal
export const sendReminderEmail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type } = req.query;

  const advert = await Advert.findById(id).populate('postedBy', 'email');

  if (!advert || !advert.postedBy?.email) {
    return res.status(404).json({ success: false, message: 'Advert or user not found' });
  }

  try {
    if (type === '14') {
      await sendAdvertReminder14(advert);
      advert.notifications.first = new Date();
    } else if (type === '7') {
      await sendAdvertReminder7(advert);
      const deleteEligibleDate = new Date(advert.expiresAt);
      deleteEligibleDate.setDate(deleteEligibleDate.getDate() + 7);
      advert.notifications.deleteEligible = deleteEligibleDate;
      advert.notifications.second = new Date();
    } else {
      return res.status(400).json({ success: false, message: 'Invalid reminder type' });
    }

    const updatedAdvert = await advert.save();

    return res.status(200).json({ 
      success: true, 
      message: `Reminder (${type}d) sent successfully`,
      advert: updatedAdvert // Return the updated advert
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update advert after sending reminder',
      error: error.message
    });
  }
});


// @desc    Admin - Renew an advert (override - no ownership/time restrictions)
// @route   PUT /api/admin/adverts/:id/renew
// @access  Admin only
export const adminRenewAdvert = asyncHandler(async (req, res) => {
  const advertId = req.params.id;

  try {
    const advert = await Advert.findById(advertId).populate('postedBy', 'email');

    if (!advert) {
      return res.status(404).json({ success: false, message: 'Advert not found' });
    }

    // Get subcategory-specific expiry days (expiry config is keyed by subcategory)
    const categoryExpiryDays = getCategoryExpiryDays(advert.subcategory);
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + categoryExpiryDays);

    // Update advert
    advert.expiresAt = newExpiresAt;
    advert.status = 'active';

    // Reset notification flags
    if (advert.notifications) {
      advert.notifications.first = null;
      advert.notifications.second = null;
      advert.notifications.deleteEligible = null;
    }

    await advert.save();

    // Send renewal notification email
    try {
      await renewAdvertNotification({ type: 'renewed', advert });
    } catch (notifyErr) {
      console.warn('⚠️ Renewal email notification failed:', notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Advert renewed successfully for ${categoryExpiryDays} days`,
      advert,
    });
  } catch (error) {
    console.error('❌ Error renewing advert (admin):', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error while renewing advert',
      error: error.message,
    });
  }
});

