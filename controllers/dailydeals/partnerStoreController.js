import asyncHandler from 'express-async-handler';
import PartnerStore from '../../models/dailydeals/partnerStore.js';
import DailyDeal from '../../models/dailydeals/dailyDeal.js';
import { generatePartnerStoreIdentifier } from '../../utils/dailydeals/partnerStoreIdentifierGenerator.js';
import { handleLogoUpload, handleLogoUpdate, deleteLogoFromCloudinary } from '../../utils/dailydeals/partnerStoreImageHelpers.js';
import { stripHtml } from '../../utils/helpers/shared/sanitize.js';
import { isValidCategoryCombo } from '../../utils/dailydeals/dealCategories.js';

// ============== USER ROUTES (authMiddleware) ==============

// @desc    Get user's stores
// @route   GET /api/user/partnerstores
// @access  Private
export const fetchMyStores = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const userId = req.user.id || req.user._id;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter = { createdBy: userId };

  const totalCount = await PartnerStore.countDocuments(filter);

  const stores = await PartnerStore.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum);

  res.status(200).json({
    success: true,
    stores,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum
  });
});

// @desc    Get single store by ID (user - for edit form)
// @route   GET /api/user/partnerstores/:id
// @access  Private
export const getMyStoreById = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const storeId = req.params.id;

  const store = await PartnerStore.findById(storeId);

  if (!store) {
    res.status(404);
    throw new Error('Store not found');
  }

  // Verify ownership
  if (store.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only view your own stores');
  }

  res.status(200).json({
    success: true,
    store
  });
});

// @desc    Add store (user)
// @route   POST /api/user/partnerstores
// @access  Private
export const addStore = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;

  const {
    businessName,
    category,
    subcategory,
    address,
    contactInfo,
    description,
    isNationwide
  } = req.body;

  // Validate required fields
  if (!businessName || !category || !subcategory) {
    res.status(400);
    throw new Error('Business name, category and subcategory are required');
  }

  // Reject a category/subcategory pair that isn't in the taxonomy
  if (!isValidCategoryCombo(category, subcategory)) {
    res.status(400);
    throw new Error('Invalid category or subcategory');
  }

  // Parse address
  let parsedAddress;
  try {
    parsedAddress = typeof address === 'string' ? JSON.parse(address) : address;

    // Validate coordinates for non-nationwide stores
    const isNationwideVal = isNationwide === 'true' || isNationwide === true;
    if (!isNationwideVal && (!parsedAddress?.location?.coordinates || parsedAddress.location.coordinates.length !== 2)) {
      res.status(400);
      throw new Error('Valid address with coordinates is required for location-specific stores');
    }

    // Validate state is present
    if (!parsedAddress?.state) {
      res.status(400);
      throw new Error('State is required in address');
    }
  } catch (error) {
    res.status(400);
    throw new Error('Invalid address format: ' + error.message);
  }

  // Parse contact info
  let parsedContactInfo = {};
  try {
    if (contactInfo) {
      parsedContactInfo = typeof contactInfo === 'string' ? JSON.parse(contactInfo) : contactInfo;
    }
  } catch (error) {
    res.status(400);
    throw new Error('Invalid contact info format');
  }

  // Generate unique partner store identifier
  const partnerstoreId = await generatePartnerStoreIdentifier();

  // Handle logo upload
  let logoUrl = null;
  try {
    logoUrl = await handleLogoUpload(req);
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }

  // Create partner store
  const partnerStore = await PartnerStore.create({
    partnerstoreId,
    businessName,
    category,
    subcategory,
    address: parsedAddress,
    contactInfo: parsedContactInfo,
    logo: logoUrl,
    description: stripHtml(description || ''),
    isActive: true,
    isNationwide: isNationwide === 'true' || isNationwide === true,
    createdBy: userId
  });

  console.log(`✅ User store created: ${partnerStore.businessName} by user ${userId}`);

  res.status(201).json({
    success: true,
    store: partnerStore
  });
});

// @desc    Update store (user)
// @route   PUT /api/user/partnerstores/:id
// @access  Private
export const updateStore = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const storeId = req.params.id;

  const partnerStore = await PartnerStore.findById(storeId);

  if (!partnerStore) {
    res.status(404);
    throw new Error('Store not found');
  }

  // Verify ownership
  if (partnerStore.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only edit your own stores');
  }

  const {
    businessName,
    category,
    subcategory,
    address,
    contactInfo,
    description,
    isNationwide
  } = req.body;

  // Parse address if provided
  let parsedAddress = partnerStore.address;
  if (address) {
    try {
      parsedAddress = typeof address === 'string' ? JSON.parse(address) : address;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid address format');
    }
  }

  // Parse contact info if provided
  let parsedContactInfo = partnerStore.contactInfo;
  if (contactInfo) {
    try {
      parsedContactInfo = typeof contactInfo === 'string' ? JSON.parse(contactInfo) : contactInfo;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid contact info format');
    }
  }

  // Handle logo update
  let updatedLogo = partnerStore.logo;
  try {
    updatedLogo = await handleLogoUpdate(req, partnerStore.logo);
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }

  // Reject an invalid category/subcategory combo (validate the resulting pair)
  const nextCategory = category || partnerStore.category;
  const nextSubcategory = subcategory || partnerStore.subcategory;
  if (!isValidCategoryCombo(nextCategory, nextSubcategory)) {
    res.status(400);
    throw new Error('Invalid category or subcategory');
  }

  // Update fields (user cannot change isActive - admin only)
  partnerStore.businessName = businessName || partnerStore.businessName;
  partnerStore.category = category || partnerStore.category;
  partnerStore.subcategory = subcategory || partnerStore.subcategory;
  partnerStore.address = parsedAddress;
  partnerStore.contactInfo = parsedContactInfo;
  partnerStore.logo = updatedLogo;
  partnerStore.description = description !== undefined ? stripHtml(description) : partnerStore.description;

  if (isNationwide !== undefined) {
    partnerStore.isNationwide = isNationwide === 'true' || isNationwide === true;
  }

  await partnerStore.save();

  console.log(`✅ User store updated: ${partnerStore.businessName} by user ${userId}`);

  res.status(200).json({
    success: true,
    store: partnerStore
  });
});

// @desc    Delete store (user)
// @route   DELETE /api/user/partnerstores/:id
// @access  Private
export const deleteStore = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const storeId = req.params.id;

  const partnerStore = await PartnerStore.findById(storeId);

  if (!partnerStore) {
    res.status(404);
    throw new Error('Store not found');
  }

  // Verify ownership
  if (partnerStore.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only delete your own stores');
  }

  // Check for deals (any deals, not just active)
  const dealsCount = await DailyDeal.countDocuments({
    partnerstoreId: partnerStore._id
  });

  if (dealsCount > 0) {
    res.status(400);
    throw new Error('Delete deal(s) before removing this business');
  }

  // Delete logo from Cloudinary
  await deleteLogoFromCloudinary(partnerStore.logo);

  // Delete the partner store
  await PartnerStore.findByIdAndDelete(storeId);

  console.log(`🗑️ User store deleted: ${partnerStore.businessName} by user ${userId}`);

  res.status(200).json({
    success: true,
    message: 'Store deleted successfully'
  });
});
