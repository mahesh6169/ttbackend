import asyncHandler from 'express-async-handler';
import DailyDeal from '../../models/dailydeals/dailyDeal.js';
import PartnerStore from '../../models/dailydeals/partnerStore.js';
import { generateSlug, ensureUniqueSlug } from '../../utils/helpers/shared/generateSlug.js';
import { uploadDealImages, deleteDealImages, updateDealImages } from '../../utils/dailydeals/dealImageHelpers.js';
import { stripHtml } from '../../utils/helpers/shared/sanitize.js';
import { addDealNotification, updateDealNotification, deleteDealNotification } from '../../utils/notifications/dailydeals/sendDealNotifications.js';
import { getCategories } from '../../utils/dailydeals/categoryMappings.js';

const CURATOR_EMAILS = (process.env.CURATOR_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ============== PUBLIC ROUTES ==============

// @desc    Browse public deals with filters
// @route   GET /api/dailydeals
// @access  Public
export const browseDeals = asyncHandler(async (req, res) => {
  const {
    category,
    subcategory,
    state,
    lat,
    lng,
    radius,
    day,
    searchText,
    partnerstoreId,
    sortBy = 'newest',
    page = 1,
    limit = 20
  } = req.query;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;
  const now = new Date();

  // Start of today for endDate comparison (deals valid until end of their end date)
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Base filter for active deals within date range.
  // isOnline: { $ne: false } hides only deliberately-Offline deals; deals with the
  // field missing (existing/user-created) count as Online. Direct-link endpoints do
  // NOT apply this, so an Offline deal stays previewable via its URL.
  const baseFilter = {
    isActive: true,
    isOnline: { $ne: false },
    startDate: { $lte: now },
    endDate: { $gte: startOfToday }  // Deal valid until end of its end date
  };

  // Day filter
  if (day) {
    baseFilter.$or = [
      { validDays: { $size: 0 } }, // Empty validDays = every day
      { validDays: day.toLowerCase() }
    ];
  }

  // Search text - search by store name and category mapping only
  // Deals are found through their stores, not by title/description
  // Minimum 3 characters required for search (safety check)
  if (searchText && searchText.trim().length >= 3) {
    const trimmedSearch = searchText.trim();

    // 1. Find stores by business name using $text
    const storesByName = await PartnerStore.find(
      { $text: { $search: trimmedSearch }, isActive: true }
    ).select('_id');

    // 2. Get mapped categories and find stores by parent category OR subcategory
    const mappedCategories = getCategories(trimmedSearch);
    const storesByCategory = mappedCategories.length > 0
      ? await PartnerStore.find({
          $or: [
            { category: { $in: mappedCategories } },
            { subcategory: { $in: mappedCategories } }
          ],
          isActive: true
        }).select('_id')
      : [];

    // 3. Combine partner IDs (deduplicated)
    const allPartnerIds = [
      ...storesByName.map(s => s._id.toString()),
      ...storesByCategory.map(s => s._id.toString())
    ];
    const searchPartnerIds = [...new Set(allPartnerIds)];

    // 4. Filter deals by matching stores only
    if (searchPartnerIds.length > 0) {
      baseFilter.partnerstoreId = { $in: searchPartnerIds };
    } else {
      // No matching stores found - return empty results
      baseFilter._id = { $in: [] };
    }
  }

  // Partner filter
  if (partnerstoreId) {
    baseFilter.partnerstoreId = partnerstoreId;
  }

  // Check if geo filtering is requested
  const hasGeoFilter = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

  let deals = [];
  let totalCount = 0;

  if (hasGeoFilter) {
    // Geo-based search - need to find partner stores near location first
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const maxDistance = (parseFloat(radius) || 10) * 1000;

    // Build partner filter
    const partnerGeoQuery = {
      isActive: true,
      'address.location': {
        $near: {
          $geometry: { type: 'Point', coordinates: [longitude, latitude] },
          $maxDistance: maxDistance
        }
      }
    };

    if (category) {
      const categories = category.split(',');
      partnerGeoQuery.category = { $in: categories };
    }

    if (subcategory) {
      const subcategories = subcategory.split(',');
      partnerGeoQuery.subcategory = { $in: subcategories };
    }

    if (state) {
      partnerGeoQuery.$or = [
        { 'address.state': state },
        { isNationwide: true }
      ];
    }

    // Get partner IDs within radius
    const nearbyPartners = await PartnerStore.find(partnerGeoQuery).select('_id');
    const nearbyPartnerIds = nearbyPartners.map(p => p._id);

    // Also get nationwide partners
    const nationwideFilter = { isActive: true, isNationwide: true };
    if (category) {
      const categories = category.split(',');
      nationwideFilter.category = { $in: categories };
    }
    if (subcategory) {
      const subcategories = subcategory.split(',');
      nationwideFilter.subcategory = { $in: subcategories };
    }
    const nationwidePartners = await PartnerStore.find(nationwideFilter).select('_id');
    const nationwidePartnerIds = nationwidePartners.map(p => p._id);

    // Combine partner IDs
    const allPartnerIds = [...new Set([...nearbyPartnerIds.map(String), ...nationwidePartnerIds.map(String)])];

    baseFilter.partnerstoreId = { $in: allPartnerIds };

    totalCount = await DailyDeal.countDocuments(baseFilter);

    // Sort: featured first, then by date
    const sortOptions = getFeaturedSort(sortBy);

    deals = await DailyDeal.find(baseFilter)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNum)
      .populate('partnerstoreId', 'businessName category subcategory logo address isNationwide');

  } else {
    // No geo filter

    // Category filter (via partner)
    if (category || subcategory || state) {
      const partnerFilter = { isActive: true };

      if (category) {
        const categories = category.split(',');
        partnerFilter.category = { $in: categories };
      }

      if (subcategory) {
        const subcategories = subcategory.split(',');
        partnerFilter.subcategory = { $in: subcategories };
      }

      if (state) {
        partnerFilter.$or = [
          { 'address.state': state },
          { isNationwide: true }
        ];
      }

      const matchingPartners = await PartnerStore.find(partnerFilter).select('_id');
      baseFilter.partnerstoreId = { $in: matchingPartners.map(p => p._id) };
    }

    totalCount = await DailyDeal.countDocuments(baseFilter);

    const sortOptions = getFeaturedSort(sortBy);

    deals = await DailyDeal.find(baseFilter)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNum)
      .populate('partnerstoreId', 'businessName category subcategory logo address isNationwide');
  }

  res.status(200).json({
    success: true,
    deals,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum
  });
});

// Helper function for sorting with featured deals first
const getFeaturedSort = (sortBy) => {
  if (sortBy === 'ending') {
    return { endDate: 1 };
  }
  if (sortBy === 'oldest') {
    return { createdAt: 1 };
  }
  // Default: newest first
  return { createdAt: -1 };
};

// @desc    Get single deal by slug
// @route   GET /api/dailydeals/:slug
// @access  Public
export const getDealBySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;

  // Try to find by slug first
  let deal = await DailyDeal.findOne({ slug, isActive: true })
    .populate('partnerstoreId', 'businessName category subcategory logo address contactInfo description isNationwide')
    .populate('postedBy', '_id name');

  // Fallback to ObjectId if slug not found
  if (!deal && slug.match(/^[0-9a-fA-F]{24}$/)) {
    deal = await DailyDeal.findOne({ _id: slug, isActive: true })
      .populate('partnerstoreId', 'businessName category subcategory logo address contactInfo description isNationwide')
      .populate('postedBy', '_id name');
  }

  if (!deal) {
    res.status(404);
    throw new Error('Deal not found');
  }

  res.status(200).json({
    success: true,
    deal
  });
});

// @desc    Get single deal by ID (public view)
// @route   GET /api/dailydeals/view/:id
// @access  Public
export const getPublicDealById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const deal = await DailyDeal.findOne({ _id: id, isActive: true })
    .populate('partnerstoreId', 'businessName category subcategory logo address contactInfo description isNationwide')
    .populate('postedBy', '_id name');

  if (!deal) {
    res.status(404);
    throw new Error('Deal not found');
  }

  // Convert to plain object so we can add computed properties (ogImageUrl)
  const dealObj = deal.toObject();

  // Add ogImageUrl for OG meta tags (social media sharing)
  // Only use optimized URL, skip raw images (frontend handles fallback)
  if (dealObj.images && dealObj.images.length > 0) {
    dealObj.images = dealObj.images.map(image => {
      if (image.publicId) {
        return {
          ...image,
          ogImageUrl: `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${image.publicId}`
        };
      }
      return image;
    });

    dealObj.ogImageUrl = dealObj.images[0].ogImageUrl || null;
  }

  res.status(200).json({
    success: true,
    deal: dealObj
  });
});

// @desc    Get filter options (categories from active deals)
// @route   GET /api/dailydeals/filter-options
// @access  Public
export const getFilterOptions = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Get partner IDs that have active deals (exclude deliberately-Offline deals so
  // their category doesn't leak into the filter list)
  const activeDeals = await DailyDeal.find({
    isActive: true,
    isOnline: { $ne: false },
    startDate: { $lte: now },
    endDate: { $gte: startOfToday }
  }).select('partnerstoreId');

  const partnerIds = [...new Set(activeDeals.map(d => d.partnerstoreId.toString()))];

  // Get unique categories + subcategories from those partners.
  // Frontend groups subcategories under parents via getParentForSubcategory().
  const partners = await PartnerStore.find({
    _id: { $in: partnerIds },
    isActive: true
  }).select('category subcategory');

  const categories = [...new Set(partners.map(p => p.category).filter(Boolean))].sort();
  const subcategories = [...new Set(partners.map(p => p.subcategory).filter(Boolean))].sort();

  res.status(200).json({
    success: true,
    categories,
    subcategories
  });
});

// @desc    Get active/public deals for the sitemap (id, title, updatedAt)
// @route   GET /api/dailydeals/sitemap
// @access  Public
// Mirrors getSitemapEvents: same active/online/date-range rule as browse, so only
// currently-live, publicly-listed deals are advertised to Google. Title is mapped
// from dealTitle so the frontend can build /deals/{title}-{id} with createSlugUrl.
export const getSitemapDeals = asyncHandler(async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const deals = await DailyDeal.find({
      isActive: true,
      isOnline: { $ne: false },
      startDate: { $lte: now },
      endDate: { $gte: startOfToday }
    })
      .select('dealTitle _id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50000)
      .lean();

    const payload = deals.map(deal => ({
      _id: deal._id,
      title: deal.dealTitle,
      updatedAt: deal.updatedAt
    }));

    return res.status(200).json(payload);
  } catch (error) {
    console.error('Error fetching deals for sitemap:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// ============== USER ROUTES (authMiddleware) ==============

// @desc    Get user's deals
// @route   GET /api/user/dailydeals
// @access  Private
export const fetchMyDeals = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const userId = req.user.id || req.user._id;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Get user's stores first
  const userStores = await PartnerStore.find({ createdBy: userId }).select('_id');
  const storeIds = userStores.map(s => s._id);

  // Get deals belonging to user's stores
  const filter = { partnerstoreId: { $in: storeIds } };

  const totalCount = await DailyDeal.countDocuments(filter);

  const deals = await DailyDeal.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate('partnerstoreId', 'businessName category subcategory logo');

  res.status(200).json({
    success: true,
    deals,
    totalCount,
    totalPages: Math.ceil(totalCount / limitNum),
    currentPage: pageNum
  });
});

// @desc    Get user's stores dropdown (for deal form)
// @route   GET /api/user/dailydeals/mystores-dropdown
// @access  Private
export const getMyStoresDropdown = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;

  const stores = await PartnerStore.find({ createdBy: userId, isActive: true })
    .select('_id businessName category subcategory')
    .sort({ businessName: 1 });

  res.status(200).json({
    success: true,
    stores
  });
});

// @desc    Add deal (user)
// @route   POST /api/user/dailydeals
// @access  Private
export const addDeal = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;

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
    endDate
  } = req.body;

  // Validate required fields
  if (!partnerstoreId || !dealTitle || !startDate || !endDate) {
    res.status(400);
    throw new Error('Partner store, deal title, start date, and end date are required');
  }

  // Verify store exists and belongs to user
  const partnerStore = await PartnerStore.findById(partnerstoreId);
  if (!partnerStore) {
    res.status(404);
    throw new Error('Partner store not found');
  }
  if (partnerStore.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only add deals to your own stores');
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

  // Create deal (featured defaults to false, isActive defaults to true)
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
    featured: { isActive: false },
    isActive: true,
    postedBy: userId,
    isCuratedDeal: !!req.user?.email && CURATOR_EMAILS.includes(req.user.email.toLowerCase())
  });

  await dailyDeal.populate('partnerstoreId', 'businessName category subcategory logo');
  await dailyDeal.populate('postedBy', 'email');

  console.log(`✅ User deal created: ${dailyDeal.dealTitle} by user ${userId}`);

  // Send email notification (non-blocking)
  try {
    addDealNotification({ type: 'created', deal: dailyDeal });
  } catch (notificationError) {
    console.error('Failed to send deal creation notification:', notificationError);
  }

  res.status(201).json({
    success: true,
    deal: dailyDeal
  });
});

// @desc    Update deal (user)
// @route   PUT /api/user/dailydeals/:id
// @access  Private
export const updateDeal = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const dealId = req.params.id;

  const dailyDeal = await DailyDeal.findById(dealId).populate('partnerstoreId');

  if (!dailyDeal) {
    res.status(404);
    throw new Error('Deal not found');
  }

  // Verify ownership
  if (dailyDeal.partnerstoreId.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only edit your own deals');
  }

  const {
    dealTitle,
    description,
    terms,
    dealLink,
    whatsappOrders,
    whatsappNumber,
    validDays,
    startDate,
    endDate,
    keepImages
  } = req.body;

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

  // Update other fields (user cannot change featured or isActive)
  if (description !== undefined) dailyDeal.description = stripHtml(description);
  if (terms !== undefined) dailyDeal.terms = stripHtml(terms);
  if (dealLink !== undefined) dailyDeal.dealLink = dealLink;
  if (whatsappOrders !== undefined) dailyDeal.whatsappOrders = whatsappOrders === 'true' || whatsappOrders === true;
  if (whatsappNumber !== undefined) dailyDeal.whatsappNumber = whatsappNumber;
  if (startDate) dailyDeal.startDate = new Date(startDate);
  if (endDate) dailyDeal.endDate = new Date(endDate);

  await dailyDeal.save();

  await dailyDeal.populate('partnerstoreId', 'businessName category subcategory logo');
  await dailyDeal.populate('postedBy', 'email');

  console.log(`✅ User deal updated: ${dailyDeal.dealTitle} by user ${userId}`);

  // Send email notification (non-blocking)
  try {
    updateDealNotification({ type: 'updated', deal: dailyDeal });
  } catch (notificationError) {
    console.error('Failed to send deal update notification:', notificationError);
  }

  res.status(200).json({
    success: true,
    deal: dailyDeal
  });
});

// @desc    Delete deal (user)
// @route   DELETE /api/user/dailydeals/:id
// @access  Private
export const deleteDeal = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const dealId = req.params.id;

  const dailyDeal = await DailyDeal.findById(dealId)
    .populate('partnerstoreId')
    .populate('postedBy', 'email');

  if (!dailyDeal) {
    res.status(404);
    throw new Error('Deal not found');
  }

  // Verify ownership
  if (dailyDeal.partnerstoreId.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only delete your own deals');
  }

  // Save deal info for notification before deletion
  const dealInfo = {
    dealTitle: dailyDeal.dealTitle,
    postedBy: dailyDeal.postedBy
  };

  // Delete images from Cloudinary
  await deleteDealImages(dailyDeal.images);

  // Delete the deal
  await DailyDeal.findByIdAndDelete(dealId);

  console.log(`🗑️ User deal deleted: ${dailyDeal.dealTitle} by user ${userId}`);

  // Send email notification (non-blocking)
  try {
    deleteDealNotification({ type: 'deleted', deal: dealInfo });
  } catch (notificationError) {
    console.error('Failed to send deal deletion notification:', notificationError);
  }

  res.status(200).json({
    success: true,
    message: 'Deal deleted successfully'
  });
});

// @desc    Get single deal by ID (user - for edit form)
// @route   GET /api/user/dailydeals/:id
// @access  Private
export const getMyDealById = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const dealId = req.params.id;

  const deal = await DailyDeal.findById(dealId)
    .populate('partnerstoreId', 'businessName category logo createdBy');

  if (!deal) {
    res.status(404);
    throw new Error('Deal not found');
  }

  // Verify ownership
  if (deal.partnerstoreId.createdBy.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('You can only view your own deals');
  }

  res.status(200).json({
    success: true,
    deal
  });
});
