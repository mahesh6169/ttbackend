import asyncHandler from 'express-async-handler';
import PartnerStore from '../../../models/dailydeals/partnerStore.js';
import DailyDeal from '../../../models/dailydeals/dailyDeal.js';
import { generatePartnerStoreIdentifier } from '../../../utils/dailydeals/partnerStoreIdentifierGenerator.js';
import { handleLogoUpload, handleLogoUpdate, deleteLogoFromCloudinary } from '../../../utils/dailydeals/partnerStoreImageHelpers.js';
import { stripHtml } from '../../../utils/helpers/shared/sanitize.js';
import { isValidCategoryCombo } from '../../../utils/dailydeals/dealCategories.js';

// @desc    Create new partner store (admin only)
// @route   POST /api/admin/dailydeals/partners
// @access  Private/Admin
export const createPartnerStore = asyncHandler(async (req, res) => {
  console.log('🔹 Creating new partner store:', req.body);

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
    if (!isNationwide && (!parsedAddress?.location?.coordinates || parsedAddress.location.coordinates.length !== 2)) {
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
    createdBy: req.user.id || req.user._id
  });

  console.log(`✅ Partner store created: ${partnerStore.businessName} (${partnerStore.partnerstoreId})`);

  res.status(201).json({
    success: true,
    partnerStore
  });
});

// @desc    Get single partner store by ID
// @route   GET /api/admin/dailydeals/partners/:id
// @access  Private/Admin
export const getPartnerStoreById = asyncHandler(async (req, res) => {
  const partnerStore = await PartnerStore.findById(req.params.id);

  if (!partnerStore) {
    res.status(404);
    throw new Error('Partner store not found');
  }

  res.status(200).json({
    success: true,
    partnerStore
  });
});

// @desc    Get all partner stores with pagination
// @route   GET /api/admin/dailydeals/partners
// @access  Private/Admin
export const getPartnerStores = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, searchText, isActive } = req.query;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Build filter
  const filter = {};

  if (searchText) {
    filter.businessName = { $regex: searchText, $options: 'i' };
  }

  if (isActive !== undefined) {
    filter.isActive = isActive === 'true';
  }

  // Get total count
  const totalCount = await PartnerStore.countDocuments(filter);

  // Get partner stores with pagination
  const partnerStores = await PartnerStore.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate('createdBy', 'firstName lastName email');

  res.status(200).json({
    success: true,
    partnerStores,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum
  });
});

// @desc    Update partner store
// @route   PUT /api/admin/dailydeals/partners/:id
// @access  Private/Admin
export const updatePartnerStore = asyncHandler(async (req, res) => {
  console.log('🔹 Updating partner store:', req.params.id);

  const partnerStore = await PartnerStore.findById(req.params.id);

  if (!partnerStore) {
    res.status(404);
    throw new Error('Partner store not found');
  }

  const {
    businessName,
    category,
    subcategory,
    address,
    contactInfo,
    description,
    isNationwide,
    isActive
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

  // Update fields
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

  if (isActive !== undefined) {
    partnerStore.isActive = isActive === 'true' || isActive === true;
  }

  await partnerStore.save();

  console.log(`✅ Partner store updated: ${partnerStore.businessName}`);

  res.status(200).json({
    success: true,
    partnerStore
  });
});

// @desc    Delete partner store
// @route   DELETE /api/admin/dailydeals/partners/:id
// @access  Private/Admin
export const deletePartnerStore = asyncHandler(async (req, res) => {
  const partnerStore = await PartnerStore.findById(req.params.id);

  if (!partnerStore) {
    res.status(404);
    throw new Error('Partner store not found');
  }

  // Check for any deals attached to this business
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
  await PartnerStore.findByIdAndDelete(req.params.id);

  console.log(`🗑️ Partner store deleted: ${partnerStore.businessName}`);

  res.status(200).json({
    success: true,
    message: 'Partner store deleted successfully'
  });
});
