import asyncHandler from 'express-async-handler';
import DailyDeal from '../../../models/dailydeals/dailyDeal.js';
import PartnerStore from '../../../models/dailydeals/partnerStore.js';
import User from '../../../models/userModel.js';
import { generateSlug, ensureUniqueSlug } from '../../../utils/helpers/shared/generateSlug.js';
import { uploadDealImages, deleteDealImages, updateDealImages } from '../../../utils/dailydeals/dealImageHelpers.js';
import { stripHtml } from '../../../utils/helpers/shared/sanitize.js';

const CURATOR_EMAILS = (process.env.CURATOR_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Admin auth tokens carry only { id, role } (no email), so look the creator's
// email up from the DB to decide whether they are a curator.
const isCuratorUser = async (userId) => {
  if (!userId) return false;
  const creator = await User.findById(userId).select('email');
  return !!creator?.email && CURATOR_EMAILS.includes(creator.email.toLowerCase());
};

// @desc    Create new daily deal
// @route   POST /api/admin/dailydeals
// @access  Private/Admin
export const createDailyDeal = asyncHandler(async (req, res) => {
  console.log('🔹 Creating new daily deal:', req.body);

  const {
    partnerstoreId,
    dealTitle,
    description,
    terms,
    dealLink,
    whatsappOrders,
    whatsappNumber,
    validDays,
    startDate,
    endDate,
    featured,
    isActive,
    isOnline
  } = req.body;

  // Validate required fields
  if (!partnerstoreId || !dealTitle || !startDate || !endDate) {
    res.status(400);
    throw new Error('Partner store, deal title, start date, and end date are required');
  }

  // Verify partner store exists
  const partnerStore = await PartnerStore.findById(partnerstoreId);
  if (!partnerStore) {
    res.status(404);
    throw new Error('Partner store not found');
  }

  // Parse validDays
  let parsedValidDays = [];
  if (validDays) {
    try {
      parsedValidDays = typeof validDays === 'string' ? JSON.parse(validDays) : validDays;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid validDays format');
    }
  }

  // Parse featured
  let parsedFeatured = { isActive: false };
  if (featured) {
    try {
      parsedFeatured = typeof featured === 'string' ? JSON.parse(featured) : featured;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid featured format');
    }
  }

  // Generate slug
  const baseSlug = generateSlug(dealTitle);
  const slug = await ensureUniqueSlug(DailyDeal, baseSlug);

  // Upload images
  let images = [];
  try {
    images = await uploadDealImages(req);
  } catch (error) {
    res.status(400);
    throw new Error('Image upload failed: ' + error.message);
  }

  // Create deal
  const dailyDeal = await DailyDeal.create({
    partnerstoreId,
    dealTitle,
    slug,
    description: stripHtml(description || ''),
    terms: stripHtml(terms || ''),
    dealLink: dealLink || '',
    whatsappOrders: whatsappOrders === 'true' || whatsappOrders === true,
    whatsappNumber: whatsappNumber || '',
    validDays: parsedValidDays,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    images,
    featured: parsedFeatured,
    isActive: isActive !== 'false' && isActive !== false,
    isOnline: isOnline !== 'false' && isOnline !== false, // default Online unless explicitly Offline
    postedBy: req.user.id || req.user._id,
    isCuratedDeal: await isCuratorUser(req.user.id || req.user._id)
  });

  // Populate partner store info
  await dailyDeal.populate('partnerstoreId', 'businessName category logo');

  console.log(`✅ Daily deal created: ${dailyDeal.dealTitle} (${dailyDeal.slug})`);

  res.status(201).json({
    success: true,
    dailyDeal
  });
});

// @desc    Get all daily deals with pagination
// @route   GET /api/admin/dailydeals
// @access  Private/Admin
export const getDailyDeals = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, searchText, partnerstoreId, isActive } = req.query;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Build filter
  const filter = {};

  if (searchText) {
    filter.dealTitle = { $regex: searchText, $options: 'i' };
  }

  if (partnerstoreId) {
    filter.partnerstoreId = partnerstoreId;
  }

  if (isActive !== undefined) {
    filter.isActive = isActive === 'true';
  }

  // Get total count
  const totalCount = await DailyDeal.countDocuments(filter);

  // Get deals with pagination
  const dailyDeals = await DailyDeal.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate('partnerstoreId', 'businessName category logo');

  res.status(200).json({
    success: true,
    dailyDeals,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum
  });
});

// @desc    Get single daily deal by ID
// @route   GET /api/admin/dailydeals/:id
// @access  Private/Admin
export const getDailyDealById = asyncHandler(async (req, res) => {
  const dailyDeal = await DailyDeal.findById(req.params.id)
    .populate('partnerstoreId', 'businessName category logo address contactInfo description');

  if (!dailyDeal) {
    res.status(404);
    throw new Error('Daily deal not found');
  }

  res.status(200).json({
    success: true,
    dailyDeal
  });
});

// @desc    Update daily deal
// @route   PUT /api/admin/dailydeals/:id
// @access  Private/Admin
export const updateDailyDeal = asyncHandler(async (req, res) => {
  console.log('🔹 Updating daily deal:', req.params.id);

  const dailyDeal = await DailyDeal.findById(req.params.id);

  if (!dailyDeal) {
    res.status(404);
    throw new Error('Daily deal not found');
  }

  const {
    partnerstoreId,
    dealTitle,
    description,
    terms,
    dealLink,
    whatsappOrders,
    whatsappNumber,
    validDays,
    startDate,
    endDate,
    featured,
    isActive,
    isOnline,
    keepImages
  } = req.body;

  // If partner store changed, verify it exists
  if (partnerstoreId && partnerstoreId !== dailyDeal.partnerstoreId.toString()) {
    const partnerStore = await PartnerStore.findById(partnerstoreId);
    if (!partnerStore) {
      res.status(404);
      throw new Error('Partner store not found');
    }
    dailyDeal.partnerstoreId = partnerstoreId;
  }

  // Update slug if title changed
  if (dealTitle && dealTitle !== dailyDeal.dealTitle) {
    const baseSlug = generateSlug(dealTitle);
    dailyDeal.slug = await ensureUniqueSlug(DailyDeal, baseSlug, dailyDeal._id);
    dailyDeal.dealTitle = dealTitle;
  }

  // Parse and update validDays
  if (validDays !== undefined) {
    try {
      dailyDeal.validDays = typeof validDays === 'string' ? JSON.parse(validDays) : validDays;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid validDays format');
    }
  }

  // Parse and update featured
  if (featured !== undefined) {
    try {
      dailyDeal.featured = typeof featured === 'string' ? JSON.parse(featured) : featured;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid featured format');
    }
  }

  // Handle images
  let keepImageIds = [];
  if (keepImages) {
    try {
      keepImageIds = typeof keepImages === 'string' ? JSON.parse(keepImages) : keepImages;
    } catch (error) {
      keepImageIds = [];
    }
  }

  dailyDeal.images = await updateDealImages(req, dailyDeal.images, keepImageIds);

  // Update other fields
  if (description !== undefined) dailyDeal.description = stripHtml(description);
  if (terms !== undefined) dailyDeal.terms = stripHtml(terms);
  if (dealLink !== undefined) dailyDeal.dealLink = dealLink;
  if (whatsappOrders !== undefined) dailyDeal.whatsappOrders = whatsappOrders === 'true' || whatsappOrders === true;
  if (whatsappNumber !== undefined) dailyDeal.whatsappNumber = whatsappNumber;
  if (startDate) dailyDeal.startDate = new Date(startDate);
  if (endDate) dailyDeal.endDate = new Date(endDate);
  if (isActive !== undefined) {
    dailyDeal.isActive = isActive === 'true' || isActive === true;
  }
  if (isOnline !== undefined) {
    dailyDeal.isOnline = isOnline === 'true' || isOnline === true;
  }

  dailyDeal.isCuratedDeal = await isCuratorUser(req.user.id || req.user._id);

  await dailyDeal.save();

  // Populate for response
  await dailyDeal.populate('partnerstoreId', 'businessName category logo');

  console.log(`✅ Daily deal updated: ${dailyDeal.dealTitle}`);

  res.status(200).json({
    success: true,
    dailyDeal
  });
});

// @desc    Delete daily deal
// @route   DELETE /api/admin/dailydeals/:id
// @access  Private/Admin
export const deleteDailyDeal = asyncHandler(async (req, res) => {
  const dailyDeal = await DailyDeal.findById(req.params.id);

  if (!dailyDeal) {
    res.status(404);
    throw new Error('Daily deal not found');
  }

  // Delete images from Cloudinary
  await deleteDealImages(dailyDeal.images);

  // Delete the deal
  await DailyDeal.findByIdAndDelete(req.params.id);

  console.log(`🗑️ Daily deal deleted: ${dailyDeal.dealTitle}`);

  res.status(200).json({
    success: true,
    message: 'Daily deal deleted successfully'
  });
});

// @desc    Get partner stores dropdown list (for deal form)
// @route   GET /api/admin/dailydeals/partners-dropdown
// @access  Private/Admin
export const getPartnersDropdown = asyncHandler(async (req, res) => {
  const partners = await PartnerStore.find({ isActive: true })
    .select('_id businessName address.suburb address.state')
    .sort({ businessName: 1 });

  // Format with location for dropdown display
  const formattedPartners = partners.map(p => ({
    _id: p._id,
    businessName: p.businessName,
    location: p.address?.suburb && p.address?.state ? `${p.address.suburb}, ${p.address.state}` : ''
  }));

  res.status(200).json({
    success: true,
    partners: formattedPartners
  });
});
