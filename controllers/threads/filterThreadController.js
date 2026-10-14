import asyncHandler from 'express-async-handler';
import Thread from '../../models/threadModel.js';

// Helper function for pagination parameters - extracted from filterController.js pattern
const getPagination = (page = 1, limit = 10) => {
  const pageNumber = parseInt(page, 10);
  const limitNumber = parseInt(limit, 10);
  const skip = (pageNumber - 1) * limitNumber;
  return { pageNumber, limitNumber, skip };
};

// @desc    Get all threads with optional filters (category, location, proximity)
export const getThreadsAll = asyncHandler(async (req, res) => {
  const { category, location, proximity = 10, page = 1, limit = 10 } = req.query;
  const { pageNumber, limitNumber, skip } = getPagination(page, limit);

  const pipeline = [];

  // ✅ Location-based filtering with proximity (if location provided)
  if (location) {
    const [longitude, latitude] = location.split(',').map(Number);
    if (isNaN(longitude) || isNaN(latitude)) {
      return res.status(400).json({ success: false, message: 'Invalid location format.' });
    }
    pipeline.push({
      $geoNear: {
        near: { type: 'Point', coordinates: [longitude, latitude] },
        distanceField: 'distance',
        maxDistance: proximity * 1000,
        distanceMultiplier: 0.001, // Convert to kilometers
        spherical: true,
        query: {}, // Additional filters could go here
      },
    });
  }

  // ✅ Category filtering (if provided)
  if (category) {
    pipeline.push({
      $match: { category },
    });
  }

  // ✅ Common pipeline stages
  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limitNumber },
    {
      $lookup: {
        from: 'threadmessages',
        localField: '_id',
        foreignField: 'thread',
        as: 'messages',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'ownerData'
      }
    },
    {
      $addFields: {
        commentCount: { $size: '$messages' },
        commented: { $gt: [{ $size: '$messages' }, 0] },
        ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
      },
    },
    {
      $project: {
        messages: 0, // Don't send full messages array
        ownerData: 0, // Don't send full owner data
      },
    }
  );

  try {
    const threads = await Thread.aggregate(pipeline);

    // ✅ Total count for pagination (removing skip & limit)
    const totalCountPipeline = pipeline.filter(stage => !('$skip' in stage || '$limit' in stage));
    totalCountPipeline.push({ $count: 'totalCount' });
    const totalCountResult = await Thread.aggregate(totalCountPipeline);
    const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

    res.status(200).json({
      success: true,
      threads,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
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

// @desc    Get threads by category (supports single or multiple categories)
// @route   GET /api/threads/categories
// @access  Public
export const getThreadsByCategory = asyncHandler(async (req, res) => {
  const { categories, page = 1, limit = 10 } = req.query;
  const { pageNumber, limitNumber, skip } = getPagination(page, limit);

  // Handle categories (optional, could be array or string)
  let categoryArray = null;
  if (categories && categories.length > 0) {
    if (Array.isArray(categories)) {
      categoryArray = categories;
    } else if (typeof categories === 'string' && categories.includes(',')) {
      categoryArray = categories.split(',').map((c) => c.trim());
    } else {
      categoryArray = [categories];
    }
  }

  // Build the pipeline
  const pipeline = [
    ...(categoryArray ? [{ $match: { category: { $in: categoryArray } } }] : []),
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limitNumber },
    {
      $lookup: {
        from: 'threadmessages',
        localField: '_id',
        foreignField: 'thread',
        as: 'messages',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'ownerData'
      }
    },
    {
      $addFields: {
        commentCount: { $size: '$messages' },
        commented: { $gt: [{ $size: '$messages' }, 0] },
        ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
      },
    },
    {
      $project: {
        messages: 0, // Don't send full messages array
        ownerData: 0,
      },
    },
  ];

  try {
    const threads = await Thread.aggregate(pipeline);

    // Count pipeline for pagination
    const totalCountResult = await Thread.aggregate([
      ...(categoryArray ? [{ $match: { category: { $in: categoryArray } } }] : []),
      { $count: 'totalCount' },
    ]);
    const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

    res.status(200).json({
      success: true,
      threads,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
        itemsPerPage: limitNumber,
      },
    });
  } catch (error) {
    console.error('Error fetching threads by category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch threads by category',
      error: error.message,
    });
  }
});

// @desc    Get threads by proximity to a city/location
// @route   GET /api/threads/city
// @access  Public
export const getThreadsByCity = asyncHandler(async (req, res) => {
  const { location, page = 1, limit = 10 } = req.query;
  const { pageNumber, limitNumber, skip } = getPagination(page, limit);

  const DEFAULT_PROXIMITY_KM = 60;

  let pipeline = [];

  // ✅ If no location provided → fetch ALL threads
  if (!location) {
    pipeline = [
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNumber },
      {
        $lookup: {
          from: 'threadmessages',
          localField: '_id',
          foreignField: 'thread',
          as: 'messages',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'owner',
          foreignField: '_id',
          as: 'ownerData'
        }
      },
      {
        $addFields: {
          commentCount: { $size: '$messages' },
          commented: { $gt: [{ $size: '$messages' }, 0] },
          ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
        },
      },
      {
        $project: {
          messages: 0, // Don't send full messages array
          ownerData: 0,
        },
      },
    ];

    try {
      const threads = await Thread.aggregate(pipeline);
      const totalCountResult = await Thread.aggregate([
        { $count: 'totalCount' },
      ]);
      const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

      return res.status(200).json({
        success: true,
        threads,
        meta: {
          totalItems: totalCount,
          currentPage: pageNumber,
          totalPages: Math.ceil(totalCount / limitNumber),
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
  }

  // ✅ If location is provided → apply geoNear filtering
  const [longitude, latitude] = location.split(',').map(Number);
  if (isNaN(longitude) || isNaN(latitude)) {
    return res.status(400).json({ success: false, message: 'Invalid location format.' });
  }

  const geoNearStage = {
    $geoNear: {
      near: { type: 'Point', coordinates: [longitude, latitude] },
      distanceField: 'distance',
      maxDistance: DEFAULT_PROXIMITY_KM * 1000,
      distanceMultiplier: 0.001, // Convert to kilometers
      spherical: true,
    },
  };

  pipeline = [
    geoNearStage,
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limitNumber },
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
        messages: 0, // Don't send full messages array
      },
    },
  ];

  try {
    const threads = await Thread.aggregate(pipeline);
    const totalCountResult = await Thread.aggregate([
      geoNearStage,
      { $count: 'totalCount' },
    ]);
    const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

    res.status(200).json({
      success: true,
      threads,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
        itemsPerPage: limitNumber,
      },
    });
  } catch (error) {
    console.error('Error fetching threads by city:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch threads by city',
      error: error.message,
    });
  }
});

// @desc    Get threads by custom category selection (requires categories)
// @route   GET /api/threads/custom-category
// @access  Public
export const getThreadsCustomCategory = asyncHandler(async (req, res) => {
  const { categories, page = 1, limit = 10 } = req.query;
  const { pageNumber, limitNumber, skip } = getPagination(page, limit);

  // 🔴 Validate: categories must always be provided
  if (!categories) {
    return res.status(400).json({
      success: false,
      message: 'Categories are required.',
    });
  }

  // 🔥 Parse categories (comma-separated string or array)
  const selectedCategories = Array.isArray(categories)
    ? categories
    : categories.split(',').map((c) => c.trim());

  const pipeline = [
    { $match: { category: { $in: selectedCategories } } },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limitNumber },
    {
      $lookup: {
        from: 'threadmessages',
        localField: '_id',
        foreignField: 'thread',
        as: 'messages',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'ownerData'
      }
    },
    {
      $addFields: {
        commentCount: { $size: '$messages' },
        commented: { $gt: [{ $size: '$messages' }, 0] },
        ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
      },
    },
    {
      $project: {
        messages: 0, // Don't send full messages array
        ownerData: 0,
      },
    },
  ];

  try {
    const threads = await Thread.aggregate(pipeline);
    const totalCountResult = await Thread.aggregate([
      { $match: { category: { $in: selectedCategories } } },
      { $count: 'totalCount' },
    ]);
    const totalCount = totalCountResult.length ? totalCountResult[0].totalCount : 0;

    res.status(200).json({
      success: true,
      threads,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
        itemsPerPage: limitNumber,
      },
    });
  } catch (error) {
    console.error('Error fetching threads by custom category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch threads by custom category',
      error: error.message,
    });
  }
});