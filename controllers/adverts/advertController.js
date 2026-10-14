import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose'; 
import Advert from '../../models/advertModel.js'; // Import Advert model
import User from '../../models/userModel.js'; // Import User model
import Message from '../../models/messageModel.js';
import bcrypt from 'bcryptjs'; // For password comparison
import cloudinary from '../../utils/cloudinary.js'; // Import Cloudinary config
import jwt from 'jsonwebtoken';
import {getUtcNow} from '../../utils/timeHelpers.js'; // Import UTC time helper function
import { addAdvertNotification, updateAdvertNotification, deleteAdvertNotification, renewAdvertNotification } from '../../utils/notifications/adverts/sendAdvertNotifications.js'; // Import notification function
import { notifyMatchingProviders } from '../../utils/notifications/adverts/wantedAdNotifications.js'; // Wanted ad notifications
import { sendSuccess, sendValidationError, sendError } from '../../utils/response/responseUtil.js';
import { 
  validateAdvertData,
  parseAndValidateAddress,
  getValidationRules
} from '../../utils/validators/advertValidator.js';
import { COMMUNITY_VALUES } from '../../utils/constants/communities.js';
import { getCategoryExpiryDays } from '../../utils/constants/expiryConfig.js';
import { generateSlug, ensureUniqueSlug } from '../../utils/helpers/shared/generateSlug.js';

const CURATOR_EMAILS = (process.env.CURATOR_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// @desc    Create an advert (validates user or creates guest user)
// @route   POST /api/adverts/addAdvert
// @access  Public
// Refactored addAdvert controller with proper handling of all model fields
export const addAdvert = asyncHandler(async (req, res) => {
  console.log("🔹 Received advert request with body:", req.body);
  console.log("🔹 Files received:", req.files || 'none');

  // Extract all fields from request body
  const {
    title,
    category,
    subcategory,
    description,
    adType,
    condition,
    fields,
    pricing,
    address,
    status,
    communities,
    isNationwide,
    contactInfo,
    notifyOnWanted
  } = req.body;

  const userRole = req.user?.role || 'user';
  const rules = getValidationRules(userRole);

  /* ----------- Parse complex fields first ----------- */
  let parsedFields = {};
  let parsedPricing = [];
  let parsedCommunities = [];
  let parsedContactInfo = null;

  try {
    // Parse fields (category-specific data)
    parsedFields = fields ? (typeof fields === 'string' ? JSON.parse(fields) : fields) : {};

    // Parse pricing array
    parsedPricing = pricing ? (typeof pricing === 'string' ? JSON.parse(pricing) : pricing) : [];

    // Parse communities array
    parsedCommunities = communities ? (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];

    // Parse contactInfo object
    parsedContactInfo = contactInfo ? (typeof contactInfo === 'string' ? JSON.parse(contactInfo) : contactInfo) : null;
  } catch (error) {
    return sendError(res, 'Invalid JSON format for fields, pricing, communities or contactInfo', error, 400);
  }

  // Validate communities
  if (parsedCommunities.length > 0) {
    const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
    if (invalidCommunities.length > 0) {
      return sendValidationError(res, [`Invalid communities: ${invalidCommunities.join(', ')}`]);
    }
  }

  /* -------------------- Validation -------------------- */
  const validation = validateAdvertData(
    {
      title,
      category,
      subcategory,
      description,
      adType,
      fields: parsedFields,
      pricing: parsedPricing,
      address,
      status
    },
    userRole,
    subcategory, // Pass subcategory for subcategory-specific validations (pricing, etc.)
    false
  );
  
  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  /* -------------------- Address Parsing -------------------- */
  let parsedAddress;
  try {
    parsedAddress = parseAndValidateAddress(address);
  } catch (error) {
    return sendError(res, error.message, error, 400);
  }

  /* -------------------- Image Upload -------------------- */
  const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";
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

  if (validFiles.length > rules.maxImages) {
    return sendValidationError(res, [`Maximum ${rules.maxImages} images allowed`]);
  }

  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const invalidTypeImage = validFiles.find((file) => !ALLOWED_IMAGE_TYPES.includes(file.mimetype));
  if (invalidTypeImage) {
    return sendValidationError(res, [`${invalidTypeImage.originalname}: Only JPEG, PNG, and WebP formats are allowed`]);
  }

  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  const oversizedImage = validFiles.find((file) => file.size > MAX_IMAGE_SIZE);
  if (oversizedImage) {
    return sendValidationError(res, [`${oversizedImage.originalname}: File size must be under 10MB`]);
  }

  // Upload images to Cloudinary if provided
  if (validFiles.length > 0) {
    try {
      for (const file of validFiles) {
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
          {
            folder: `${folderName}/listings`,
            transformation: [{ fetch_format: "auto", quality: "auto:good" }],
          }
        );
        imagesDetails.push({
          url: result.secure_url,
          publicId: result.public_id,
          originalFilename: file.originalname
        });
      }
    } catch (error) {
      console.error("Cloudinary Upload Error:", error.message);
      return sendError(res, "Image upload failed", error);
    }
  }
  // If no images provided, imagesDetails remains empty array

  /* -------------------- Expiry Calculation -------------------- */
  const categoryExpiryDays = getCategoryExpiryDays(subcategory);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + categoryExpiryDays);

  /* -------------------- Advert Creation -------------------- */
  try {
    // Create the advert data object matching the schema
    const advertData = {
      title: title.trim(),
      category: category.trim(),
      subcategory: subcategory.trim(),
      description: description?.trim(),
      adType: adType || 'offered',
      condition: condition || null,
      fields: parsedFields,
      pricing: parsedPricing,
      images: imagesDetails,
      address: parsedAddress,
      postedBy: req.user._id,
      status: status || 'active',
      communities: parsedCommunities,
      expiresAt,
      featured: {
        isActive: false,
        expiresAt: null
      },
      notifications: {
        first: null,
        second: null,
        deleteEligible: null
      },
      isNationwide: isNationwide === true || isNationwide === 'true',
      contactInfo: parsedContactInfo || undefined,
      // Auto-set when creator's email is in the CURATOR_EMAILS allowlist
      isCuratedListing: !!req.user?.email && CURATOR_EMAILS.includes(req.user.email.toLowerCase()),
      // Notification opt-in (only relevant for offered ads in service categories)
      notifyOnWanted: notifyOnWanted === true || notifyOnWanted === 'true'
    };

    // Generate slug for SEO
    const baseSlug = generateSlug(title);
    advertData.slug = await ensureUniqueSlug(Advert, baseSlug);

    // Create the advert in the database
    const advert = await Advert.create(advertData);
    await Advert.populate(advert, 'postedBy', 'name email');

    // Send notification if needed
    try {
      await addAdvertNotification({ type: 'created', advert });
    } catch (notifyErr) {
      console.warn("⚠️ Email notification failed:", notifyErr.message);
    }

    // Notify matching providers for wanted ads (non-blocking)
    if (advert.adType === 'wanted') {
      notifyMatchingProviders(advert).catch(err =>
        console.error('⚠️ Wanted ad notification failed:', err.message)
      );
    }

    return sendSuccess(res, "Advert created successfully", { advert }, 201);
  } catch (error) {
    console.error("❌ Error creating advert:", error);
    return sendError(res, "Failed to create advert", error);
  }
});

// Update Advert Function 
// Update Advert Function 
export const updateAdvert = asyncHandler(async (req, res) => {
  const advertId = req.params.id;
  console.log("🔄 Updating Advert:", advertId);
  console.log("📝 Request Body:", req.body);
  console.log("🖼️ Request Files:", req.files);

  // Find the advert and verify it exists
  const advert = await Advert.findById(advertId).populate('postedBy', 'email');
  if (!advert) {
    return sendError(res, "Advert not found", null, 404);
  }

  // Check authorization
  const userRole = req.user?.role || 'user';
  if (userRole !== 'admin' && !advert.postedBy._id.equals(req.user._id)) {
    return sendError(res, "Not authorized to update this advert", null, 403);
  }

  const rules = getValidationRules(userRole);
  
  // Extract fields from request
  const {
    title,
    category = advert.category, // Use existing category if not provided
    subcategory = advert.subcategory, // Use existing subcategory if not provided
    description,
    adType,
    condition,
    fields,
    pricing,
    address,
    status,
    communities,
    isNationwide,
    contactInfo,
    notifyOnWanted
  } = req.body;

  /* ----------- Parse complex fields first ----------- */
  let parsedFields = {};
  let parsedPricing = [];
  let parsedCommunities = [];
  let parsedContactInfo = null;

  try {
    // Parse fields (category-specific data)
    parsedFields = fields ? (typeof fields === 'string' ? JSON.parse(fields) : fields) : {};

    // Parse pricing array
    parsedPricing = pricing ? (typeof pricing === 'string' ? JSON.parse(pricing) : pricing) : [];

    // Parse communities array
    parsedCommunities = communities ? (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];

    // Parse contactInfo object
    parsedContactInfo = contactInfo ? (typeof contactInfo === 'string' ? JSON.parse(contactInfo) : contactInfo) : null;
  } catch (error) {
    return sendError(res, 'Invalid JSON format for fields, pricing, communities or contactInfo', error, 400);
  }

  // Validate communities
  if (parsedCommunities.length > 0) {
    const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
    if (invalidCommunities.length > 0) {
      return sendValidationError(res, [`Invalid communities: ${invalidCommunities.join(', ')}`]);
    }
  }

  /* -------------------- Validation -------------------- */
  // Only run title rules when the title actually changed — avoids rejecting a
  // legacy title that predates the T1 rules on an unrelated edit.
  const titleChanged = title !== undefined && title.trim() !== (advert.title || '').trim();

  const validation = validateAdvertData(
    {
      title: titleChanged ? title : undefined,
      category,
      subcategory,
      description,
      adType,
      fields: parsedFields,
      pricing: parsedPricing,
      address,
      status
    },
    userRole,
    subcategory, // Pass subcategory for subcategory-specific validations
    true      // This is an update operation
  );
  
  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  /* -------------------- Address Parsing (if provided) -------------------- */
  let parsedAddress;
  if (address) {
    try {
      parsedAddress = parseAndValidateAddress(address);
    } catch (error) {
      return sendError(res, error.message, error, 400);
    }
  }

  /* -------------------- Image Processing -------------------- */
  const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";

  // Process existing images
  let keepImages = [];
  if (req.body.existingImages) {
    const existingImagesData = Array.isArray(req.body.existingImages)
      ? req.body.existingImages
      : [req.body.existingImages];
      
    keepImages = existingImagesData.map((item) => {
      try {
        if (typeof item === 'object' && item !== null) {
          return item;
        }
        if (typeof item === 'string') {
          if (item.startsWith('{') || item.startsWith('[')) {
            return JSON.parse(item);
          }
          return { url: item };
        }
        return null;
      } catch (error) {
        console.error('Error parsing existing image:', error, 'Item:', item);
        return null;
      }
    }).filter(Boolean);
  }

  // Check for new images
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

  // Identify images to remove
  const removedImages = advert.images.filter(
    (dbImg) =>
      !keepImages.some((kImg) => kImg.publicId === dbImg.publicId)
  );

  // Delete removed images from Cloudinary
  try {
    for (const img of removedImages) {
      if (img.publicId) {
        await cloudinary.uploader.destroy(img.publicId);
        console.log(`🗑️ Deleted image: ${img.publicId}`);
      } else {
        console.log(`ℹ️ Skipping deletion - missing publicId: ${img.publicId || 'no publicId'}`);
      }
    }
  } catch (err) {
    console.error("❌ Cloudinary Deletion Error:", err.message);
    return sendError(res, "Failed to delete images", err);
  }

  // Check maximum image limit
  if (keepImages.length + validFiles.length > rules.maxImages) {
    return sendValidationError(res, [`Maximum ${rules.maxImages} images allowed`]);
  }

  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const invalidTypeImage = validFiles.find((file) => !ALLOWED_IMAGE_TYPES.includes(file.mimetype));
  if (invalidTypeImage) {
    return sendValidationError(res, [`${invalidTypeImage.originalname}: Only JPEG, PNG, and WebP formats are allowed`]);
  }

  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  const oversizedImage = validFiles.find((file) => file.size > MAX_IMAGE_SIZE);
  if (oversizedImage) {
    return sendValidationError(res, [`${oversizedImage.originalname}: File size must be under 10MB`]);
  }

  // Upload new images
  let newImages = [];
  if (validFiles.length > 0) {
    try {
      for (const file of validFiles) {
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
          {
            folder: `${folderName}/listings`,
            transformation: [{ fetch_format: "auto", quality: "auto:good" }],
          }
        );
        newImages.push({
          url: result.secure_url,
          publicId: result.public_id,
          originalFilename: file.originalname
        });
      }
    } catch (error) {
      return sendError(res, "Image upload failed", error);
    }
  }

  // Filter out any image objects that don't have a valid .url (and ideally .publicId)
keepImages = keepImages.filter(
  img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
);
newImages = newImages.filter(
  img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
);

  /* -------------------- Prepare Update Data -------------------- */
  // Create updates object
  const updates = {};
  
  if (title !== undefined) updates.title = title.trim();
  if (category !== undefined) updates.category = category.trim();
  if (subcategory !== undefined) updates.subcategory = subcategory.trim();
  if (description !== undefined) updates.description = description.trim();
  if (adType !== undefined) updates.adType = adType;
  if (condition !== undefined) updates.condition = condition;
  
  // Status can only be changed by admin
  if (status !== undefined) {
    if (userRole === 'admin') {
      updates.status = status;
    } else if (status !== advert.status) {
      return sendError(res, "Only admins can change advert status", null, 403);
    }
  }
  
  // Update nested fields
  if (Object.keys(parsedFields).length > 0) {
    updates.fields = parsedFields;
  }
  
  if (parsedPricing.length > 0) {
    updates.pricing = parsedPricing;
  }
  
  if (parsedAddress) {
    updates.address = {
      ...advert.address,
      ...parsedAddress,
    };
  }
  
  // Update communities - explicitly set to empty array if provided as empty
  if (communities !== undefined) {
    updates.communities = parsedCommunities;
  }
  
  // Update isNationwide flag
  if (isNationwide !== undefined) {
    updates.isNationwide = isNationwide === true || isNationwide === 'true';
  }

  // Update contactInfo
  if (contactInfo !== undefined) {
    updates.contactInfo = parsedContactInfo;
  }

  // Update notifyOnWanted
  if (notifyOnWanted !== undefined) {
    updates.notifyOnWanted = notifyOnWanted === true || notifyOnWanted === 'true';
  }

  // Update images
  const updatedImages = [...keepImages, ...newImages];
  const validImages = updatedImages.filter(
    img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
  );
  
  // Set images to valid images array (can be empty)
  updates.images = validImages;

  /* -------------------- Save Updates -------------------- */
  try {
    // Apply all updates at once
    Object.assign(advert, updates);
    
    // Save the updated advert
    const updatedAdvert = await advert.save();
    console.log("✅ Advert Updated:", updatedAdvert);

    // Send notification
    try {
      await updateAdvertNotification({ type: 'updated', advert: updatedAdvert });
    } catch (notifyErr) {
      console.warn("⚠️ Update notification email failed:", notifyErr.message);
    }

    return sendSuccess(res, "Advert updated successfully", { advert: updatedAdvert });
  } catch (error) {
    console.error("❌ Error updating advert:", error);
    return sendError(res, "Failed to update advert", error);
  }
});


// @desc    Get a single advert by ID
export const getAdvertById = asyncHandler(async (req, res) => {
  const id = req.params.id?.trim();

  // ✅ Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    console.error("❌ Invalid Mongo ID:", id);
    return sendError(res, "Invalid Advert ID", null, 400);
  }

  try {
    const advert = await Advert.findById(id).populate('postedBy', 'name email');

    if (!advert) {
      return sendError(res, "Advert not found", null, 404);
    }

    // Convert to object to modify - use toJSON() to properly handle Map fields
    const advertObj = advert.toJSON();

    // Optimize images before sending
    if (advertObj.images && advertObj.images.length > 0) {
      advertObj.images = advertObj.images.map(image => {
        if (image.publicId) {
          // For regular images, construct optimized URLs
          return {
            ...image,
            optimizedUrls: {
              mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_320,h_160,c_fill/${image.publicId}`,
              desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_448,h_224,c_fill/${image.publicId}`,
              mobileDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,h_200,c_fit/${image.publicId}`,
              desktopDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,h_400,c_fit/${image.publicId}`,
              fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
            },
            ogImageUrl: `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${image.publicId}`
          };
        } else {
          // If no publicId, return image as-is
          return {
            ...image,
            optimizedUrls: null,
            ogImageUrl: null
          };
        }
      });
      
      // Add top-level ogImageUrl for easy access (first image's OG URL)
      // Only use optimized URL, skip raw images (frontend handles fallback)
      advertObj.ogImageUrl = advertObj.images[0].ogImageUrl || null;
    }

    return sendSuccess(res, "Advert fetched successfully", { advert: advertObj });
  } catch (err) {
    console.error("❌ Failed to fetch advert:", err);
    return sendError(res, "Internal Server Error", err);
  }
});


// @desc    Delete an advert
// @route   DELETE /api/adverts/:id
// @access  Public
export const deleteAdvert = asyncHandler(async (req, res) => {
  console.log('🗑️ Delete Advert:', req.params.id);

  try {
    const advertId = req.params.id;

    // 1️⃣ Find the advert by ID
    const advert = await Advert.findById(advertId).populate('postedBy', 'email');
    if (!advert) {
      return res.status(404).json({ success: false, message: 'Advert not found' });
    }

    // 2️⃣ Attempt to delete images from Cloudinary
    if (advert.images && advert.images.length > 0) {
      try {
        for (const image of advert.images) {
          if (image.publicId) {
            await cloudinary.uploader.destroy(image.publicId);
            console.log(`🗑️ Deleted image: ${image.publicId}`);
          } else {
            console.log(`ℹ️ Skipping deletion - missing publicId: ${image.publicId || 'no publicId'}`);
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

    // 5️⃣ Delete advert from database
    const deleteResult = await Advert.deleteOne({ _id: advertId });
    if (deleteResult.deletedCount === 0) {
      return res.status(500).json({ success: false, message: 'Failed to delete advert from database' });
    }

    try {
      await deleteAdvertNotification({ type: 'deleted', advert });
    } catch (notifyErr) {
      console.warn("⚠️ Email deletion notification failed:", notifyErr.message);
    }

    // 6️⃣ Success response
    return res.status(200).json({
      success: true,
      message: 'Advert, images, related conversations, and wishlist entries deleted successfully',
    });

  } catch (error) {
    console.error('❌ Error deleting advert:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while deleting advert',
      error: error?.message || error.toString(),
    });
  }
});


// @desc    Renew an advert (mark as active and update last verified date)
// @route   PUT /api/adverts/:id/renew
// @access  Private
export const renewAdvert = asyncHandler(async (req, res) => {
  const advertId = req.params.id;

  try {
    const advert = await Advert.findById(advertId).populate('postedBy', 'email');

    if (!advert) {
      return res.status(404).json({ success: false, message: 'Advert not found' });
    }

    // Ensure user is the owner
    if (!advert.postedBy._id.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Unauthorized to renew this advert' });
    }

    const now = new Date();
    const expiryTime = new Date(advert.expiresAt).getTime(); // Changed to expiresAt
    const daysLeft = Math.floor((expiryTime - now.getTime()) / (1000 * 60 * 60 * 24));

    // Allow renewal 14 days before expiry or anytime after expired
    if (daysLeft > 14) {
      return res.status(400).json({
        success: false,
        message: 'Renewal is only allowed within 14 days before expiry or after expired.',
      });
    }

    // Extend expiry based on subcategory
    const categoryExpiryDays = getCategoryExpiryDays(advert.subcategory);
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + categoryExpiryDays);

    advert.expiresAt = newExpiresAt; // Changed to expiresAt
    advert.status = 'active'; // Ensure it's marked as active again
    
    // Reset notification flags using the fields from your schema
    if (advert.notifications) {
      advert.notifications.first = null;
      advert.notifications.second = null;
      advert.notifications.deleteEligible = null;
    }

    await advert.save();

    try {
      await renewAdvertNotification({ type: 'renewed', advert });
    } catch (notifyErr) {
      console.warn('⚠️ Renewal email notification failed:', notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Advert renewed successfully',
      advert,
    });
  } catch (error) {
    console.error('❌ Error renewing advert:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error while renewing advert',
      error: error.message,
    });
  }
});

// @desc    Toggle a listing's Live/Offline visibility
// @route   PATCH /api/adverts/:id/toggle-golive
// @access  Private (Listing owner only)
// Public visibility everywhere (search, home, filters) keys off status: 'active',
// so setting status to 'inactive' hides the listing without touching those queries.
export const toggleAdvertGoLive = asyncHandler(async (req, res) => {
  try {
    const advertId = req.params.id;
    const { goLive } = req.body;

    const advert = await Advert.findById(advertId);

    if (!advert) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    // Check if user owns the listing
    if (advert.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Toggle visibility
    advert.status = goLive ? 'active' : 'inactive';
    await advert.save();

    return res.status(200).json({
      success: true,
      message: `Listing is now ${goLive ? 'Live' : 'Offline'}`,
      advert,
    });
  } catch (error) {
    console.error('Error toggling listing visibility:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update listing visibility',
    });
  }
});

export const fetchMyAdverts = asyncHandler(async (req, res) => {
  try {
      const userId = req.user.id;

      // Verify user exists
      const userExists = await User.exists({ _id: userId });
      if (!userExists) {
          console.error(`User not found for ID: ${userId}`);
          return res.status(404).json({ message: 'User not found' });
      }

      // Fetch only adverts associated with this user
      const adverts = await Advert.find({ postedBy: userId })
          .sort({ createdAt: -1 }); // Sort by newest first

      return res.status(200).json({
          success: true,
          count: adverts.length,
          adverts: adverts.length > 0 ? adverts : [],
      });
  } catch (error) {
      console.error('Error in fetchMyAdverts:', error.message);
      return res.status(500).json({ message: 'Internal Server Error' });
  }
});

export const getSitemapAdverts = asyncHandler(async (req, res) => {
  try {
    // Return all adverts regardless of isActive status
    // Frontend slug is generated dynamically using title + _id
    const adverts = await Advert.find({})
      .select('title _id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50000)
      .lean();

    return res.status(200).json(adverts);
  } catch (error) {
    console.error('Error fetching adverts for sitemap:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});
  

