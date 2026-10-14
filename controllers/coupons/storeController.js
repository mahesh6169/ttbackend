import asyncHandler from 'express-async-handler';
import Store from '../../models/coupons/store.js';
import Campaign from '../../models/coupons/campaign.js';
import CouponCode from '../../models/coupons/couponCode.js';
import { generateStoreIdentifier } from '../../utils/coupons/storeIdentifierGenerator.js';
import { handleLogoUpload, handleLogoUpdate } from '../../utils/coupons/storeImageHelpers.js';

// @desc    Create new store (admin only)
// @route   POST /api/admin/stores
// @access  Private/Admin
export const createStore = asyncHandler(async (req, res) => {
  console.log('🔹 Creating new store:', req.body);

  const {
    storeName,
    category,
    subcategory,
    address,
    contactInfo,
    description,
    isNationwide
  } = req.body;

  // Validate required fields
  if (!storeName || !category || !subcategory) {
    res.status(400);
    throw new Error('Store name, category and subcategory are required');
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

  // Generate unique store identifier
  const storeIdentifier = await generateStoreIdentifier();

  // Handle logo upload
  let logoUrl = null;
  try {
    logoUrl = await handleLogoUpload(req);
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }

  // Create store
  const store = await Store.create({
    storeIdentifier,
    storeName,
    category,
    subcategory,
    address: parsedAddress,
    contactInfo: parsedContactInfo,
    logo: logoUrl,
    description: description || '',
    isActive: true,
    isNationwide: isNationwide === 'true' || isNationwide === true,
    createdBy: req.user.id || req.user._id
  });

  console.log(`✅ Store created: ${store.storeName} (${store.storeIdentifier})`);

  res.status(201).json({
    success: true,
    store
  });
});

// @desc    Get all stores with filters and pagination
// @route   GET /api/admin/stores OR /api/coupons/stores
// @access  Public (filtered) or Admin (all)
export const getStores = asyncHandler(async (req, res) => {
  const { category, subcategory, state, isActive, searchText, lat, lng, radius, page = 1, limit = 20 } = req.query;
  const isAdmin = req.user?.role === 'admin';

  // Calculate pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Check if geo filtering is requested
  const hasGeoFilter = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

  if (hasGeoFilter) {
    // Use aggregation pipeline with $geoNear for location-based search
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const maxDistance = (parseFloat(radius) || 10) * 1000; // Convert km to meters

    const pipeline = [];

    // 1. Geo filter - find stores near the location
    pipeline.push({
      $geoNear: {
        near: { type: 'Point', coordinates: [longitude, latitude] },
        distanceField: 'distance',
        maxDistance: maxDistance,
        spherical: true,
        query: { isActive: true } // Only active stores
      }
    });

    // 2. Category filter
    if (category) {
      const categories = category.split(',');
      pipeline.push({ $match: { category: { $in: categories } } });
    }
    if (subcategory) {
      pipeline.push({ $match: { subcategory: { $in: subcategory.split(',') } } });
    }

    // 3. State filter (include nationwide stores)
    if (state) {
      pipeline.push({
        $match: {
          $or: [
            { 'address.state': state },
            { isNationwide: true }
          ]
        }
      });
    }

    // 4. Search text filter
    if (searchText) {
      pipeline.push({
        $match: { storeName: { $regex: searchText, $options: 'i' } }
      });
    }

    // 5. Sort by distance (closest first)
    pipeline.push({ $sort: { distance: 1 } });

    // Get total count for geo query
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Store.aggregate(countPipeline);
    const geoCount = countResult[0]?.total || 0;

    // 6. Pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    // Execute geo query
    const geoStores = await Store.aggregate(pipeline);

    // Also get nationwide stores (they should appear regardless of location)
    const nationwideFilter = { isActive: true, isNationwide: true };
    if (category) {
      const categories = category.split(',');
      nationwideFilter.category = { $in: categories };
    }
    if (subcategory) {
      nationwideFilter.subcategory = { $in: subcategory.split(',') };
    }
    if (searchText) {
      nationwideFilter.storeName = { $regex: searchText, $options: 'i' };
    }

    const nationwideStores = await Store.find(nationwideFilter)
      .sort({ createdAt: -1 })
      .lean();

    // Combine: nationwide first, then geo-sorted stores (avoid duplicates)
    const geoStoreIds = new Set(geoStores.map(s => s._id.toString()));
    const uniqueNationwide = nationwideStores.filter(s => !geoStoreIds.has(s._id.toString()));
    const stores = [...uniqueNationwide, ...geoStores];

    const totalCount = geoCount + uniqueNationwide.length;

    res.status(200).json({
      success: true,
      stores,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum),
      currentPage: pageNum
    });

  } else {
    // No geo filter - use simple find query
    const filter = {};

    if (category) {
      const categories = category.split(',');
      filter.category = { $in: categories };
    }
    if (subcategory) {
      filter.subcategory = { $in: subcategory.split(',') };
    }
    if (state) {
      // Include stores in the specified state OR nationwide stores
      filter.$or = [
        { 'address.state': state },
        { isNationwide: true }
      ];
    }
    if (searchText) {
      filter.storeName = { $regex: searchText, $options: 'i' };
    }

    // Non-admin users only see active stores
    if (!isAdmin) {
      filter.isActive = true;
    } else if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    // Get total count
    const totalCount = await Store.countDocuments(filter);

    // Get stores with pagination
    const stores = await Store.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('createdBy', 'firstName lastName email');

    res.status(200).json({
      success: true,
      stores,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum),
      currentPage: pageNum
    });
  }
});

// @desc    Get single store by ObjectId
// @route   GET /api/admin/stores/:id OR /api/coupons/stores/:storeId
// @access  Public
export const getStoreById = asyncHandler(async (req, res) => {
  const store = await Store.findById(req.params.id || req.params.storeId)
    .populate('createdBy', 'firstName lastName email');

  if (!store) {
    res.status(404);
    throw new Error('Store not found');
  }

  res.status(200).json({
    success: true,
    store
  });
});

// @desc    Get store by store identifier (for validation page)
// @route   GET /api/coupons/stores/lookup/:storeIdentifier
// @access  Public
export const getStoreByIdentifier = asyncHandler(async (req, res) => {
  const { storeIdentifier } = req.params;

  const store = await Store.findOne({ 
    storeIdentifier: storeIdentifier.toUpperCase() 
  });

  if (!store) {
    return res.status(404).json({
      success: false,
      message: 'Store ID incorrect - not found'
    });
  }

  res.status(200).json({
    success: true,
    store: {
      _id: store._id,
      storeName: store.storeName,
      storeIdentifier: store.storeIdentifier
    }
  });
});

// @desc    Update store (admin only)
// @route   PUT /api/admin/stores/:id
// @access  Private/Admin
export const updateStore = asyncHandler(async (req, res) => {
  const store = await Store.findById(req.params.id);

  if (!store) {
    res.status(404);
    throw new Error('Store not found');
  }

  const {
    storeName,
    category,
    subcategory,
    address,
    contactInfo,
    description,
    isActive,
    isNationwide
  } = req.body;

  // Parse address if provided
  let parsedAddress;
  if (address) {
    try {
      parsedAddress = typeof address === 'string' ? JSON.parse(address) : address;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid address format');
    }
  }

  // Parse contact info if provided
  let parsedContactInfo;
  if (contactInfo) {
    try {
      parsedContactInfo = typeof contactInfo === 'string' ? JSON.parse(contactInfo) : contactInfo;
    } catch (error) {
      res.status(400);
      throw new Error('Invalid contact info format');
    }
  }

  // Handle logo update
  let logoUrl = store.logo;
  try {
    logoUrl = await handleLogoUpdate(req, store.logo);
  } catch (error) {
    res.status(400);
    throw new Error(error.message);
  }

  // Update fields
  if (storeName) store.storeName = storeName;
  if (category) store.category = category;
  if (subcategory) store.subcategory = subcategory;
  if (parsedAddress) store.address = parsedAddress;
  if (parsedContactInfo) store.contactInfo = parsedContactInfo;
  if (description !== undefined) store.description = description;
  if (logoUrl !== undefined) store.logo = logoUrl;
  if (isActive !== undefined) store.isActive = isActive === 'true' || isActive === true;
  if (isNationwide !== undefined) store.isNationwide = isNationwide === 'true' || isNationwide === true;

  const updatedStore = await store.save();

  console.log(`✅ Store updated: ${updatedStore.storeName} (${updatedStore.storeIdentifier})`);

  res.status(200).json({
    success: true,
    store: updatedStore
  });
});

// @desc    Delete store (admin only)
// @route   DELETE /api/admin/stores/:id
// @access  Private/Admin
export const deleteStore = asyncHandler(async (req, res) => {
  const store = await Store.findById(req.params.id);

  if (!store) {
    res.status(404);
    throw new Error('Store not found');
  }

  // Check if store has active campaigns
  const activeCampaigns = await Campaign.find({
    storeId: store._id,
    isActive: true
  });

  if (activeCampaigns.length > 0) {
    res.status(400);
    throw new Error(`Cannot delete store with ${activeCampaigns.length} active campaign(s). Please deactivate or delete campaigns first.`);
  }

  // Store has only inactive campaigns - safe to delete
  // Cascade delete: Delete all related data
  const deletedCampaigns = await Campaign.deleteMany({ storeId: store._id });
  const deletedCodes = await CouponCode.deleteMany({ storeId: store._id });

  // Delete logo from Cloudinary if exists
  if (store.logo?.publicId) {
    try {
      const cloudinary = (await import('../../utils/cloudinary.js')).default;
      await cloudinary.uploader.destroy(store.logo.publicId);
      console.log(`🗑️ Deleted store logo from Cloudinary: ${store.logo.publicId}`);
    } catch (error) {
      console.error('❌ Failed to delete logo from Cloudinary:', error.message);
    }
  }

  await store.deleteOne();

  console.log(`✅ Store deleted: ${store.storeName} (${store.storeIdentifier})`);
  console.log(`✅ Cascade deleted ${deletedCampaigns.deletedCount} campaign(s)`);
  console.log(`✅ Cascade deleted ${deletedCodes.deletedCount} coupon code(s)`);

  res.status(200).json({
    success: true,
    message: 'Store deleted successfully',
    deletedCampaigns: deletedCampaigns.deletedCount,
    deletedCodes: deletedCodes.deletedCount
  });
});

// @desc    Get filter options (categories from active stores)
// @route   GET /api/coupons/filter-options
// @access  Public
export const getFilterOptions = asyncHandler(async (req, res) => {
  try {
    // Get distinct categories + subcategories from active stores
    const categories = await Store.distinct('category', { isActive: true });
    const subcategories = await Store.distinct('subcategory', { isActive: true });

    res.status(200).json({
      success: true,
      data: {
        categories: categories.sort(),
        subcategories: subcategories.sort()
      }
    });
  } catch (error) {
    console.error('Error in getFilterOptions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch filter options'
    });
  }
});
