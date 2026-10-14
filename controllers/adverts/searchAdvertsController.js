// controllers/adverts/searchAdvertsController.js

import asyncHandler from 'express-async-handler';
import Advert from '../../models/advertModel.js'; 
import { sendSuccess, sendValidationError, sendError } from '../../utils/response/responseUtil.js';

// @desc    Universal filter endpoint for adverts
// @route   GET /api/adverts/search
// @access  Public
export const searchAdverts = asyncHandler(async (req, res) => {
  try {
    const { filters = {}, pagination = {} } = req.query;
    
    // Parse filters if they come as string
    const parsedFilters = typeof filters === 'string' ? JSON.parse(filters) : filters;
    const parsedPagination = typeof pagination === 'string' ? JSON.parse(pagination) : pagination;
    
    // Extract pagination parameters
    const page = parseInt(parsedPagination.page, 10) || 1;
    const limit = parseInt(parsedPagination.limit, 10) || 12;
    const skip = (page - 1) * limit;
    
    // Build aggregation pipeline dynamically
    const pipeline = [];
    
    // 1. Geospatial filter (if location provided)
    if (parsedFilters.location?.coordinates) {
      const { coordinates, radius = 10 } = parsedFilters.location;
      const [longitude, latitude] = coordinates;
      
      if (!isNaN(longitude) && !isNaN(latitude)) {
        pipeline.push({
          $geoNear: {
            near: { type: 'Point', coordinates: [longitude, latitude] },
            distanceField: 'distance',
            maxDistance: radius * 1000, // Convert km to meters
            spherical: true,
          },
        });
      }
    }
    
    // 2. Category filter (parent category level)
    if (parsedFilters.categories && parsedFilters.categories.length > 0) {
      pipeline.push({
        $match: {
          category: { $in: parsedFilters.categories }
        }
      });
    }

    // 2b. Subcategory filter (more specific level)
    if (parsedFilters.subcategories && parsedFilters.subcategories.length > 0) {
      pipeline.push({
        $match: {
          subcategory: { $in: parsedFilters.subcategories }
        }
      });
    }
    
    // 3. Ad type filter (offered/wanted)
    if (parsedFilters.adType) {
      pipeline.push({
        $match: { adType: parsedFilters.adType }
      });
    }
    
    // 4. State filter (Australian states) with nationwide support
    if (parsedFilters.state) {
      pipeline.push({
        $match: {
          $or: [
            { 'address.state': parsedFilters.state },
            { isNationwide: true }
          ]
        }
      });
    }

    // 5. Communities filter (language/community preference)
    // Listings with NO community selected are considered "for all" and always shown
    if (parsedFilters.communities && parsedFilters.communities.length > 0) {
      pipeline.push({
        $match: {
          $or: [
            { communities: { $in: parsedFilters.communities } },  // Has matching community
            { communities: { $size: 0 } },                         // No community selected (empty array)
            { communities: { $exists: false } },                   // Field doesn't exist
            { communities: null }                                  // Field is null
          ]
        }
      });
    }

    // 6. Search text (if provided)
    if (parsedFilters.searchText) {
      pipeline.push({
        $match: {
          $or: [
            { title: { $regex: parsedFilters.searchText, $options: 'i' } },
            { description: { $regex: parsedFilters.searchText, $options: 'i' } }
          ]
        }
      });
    }
    
    // 7. Status filter (always active)
pipeline.push({
  $match: { status: 'active' }
});

// 8. Sorting - Enhanced with more options and fallbacks
const sortOptions = {};
const sortBy = parsedFilters.sortBy || 'newest';

switch (sortBy) {
  case 'oldest':
    sortOptions.createdAt = 1; // Ascending order - oldest first
    break;
  
  case 'price_low':
    // Add price sorting when you implement price field
    sortOptions.price = 1; // Lowest price first
    sortOptions.createdAt = -1; // Secondary sort by newest
    break;
    
  case 'price_high':
    // Add price sorting when you implement price field
    sortOptions.price = -1; // Highest price first
    sortOptions.createdAt = -1; // Secondary sort by newest
    break;
    
  case 'distance':
    // If using $geoNear, distance is already calculated
    if (parsedFilters.location?.coordinates) {
      sortOptions.distance = 1; // Sort by closest first
      sortOptions.createdAt = -1; // Secondary sort by newest
    } else {
      // Fall back to newest if no location is provided
      sortOptions.createdAt = -1;
    }
    break;
    
  case 'newest':
  default:
    sortOptions.createdAt = -1; // Descending order - newest first
}

// Apply sort to pipeline
pipeline.push({ $sort: sortOptions });
    
    // 8. Pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });
    
    // 9. Populate user info
    pipeline.push({
      $lookup: {
        from: 'users',
        localField: 'postedBy',
        foreignField: '_id',
        as: 'user'
      }
    });
    
    pipeline.push({
      $unwind: {
        path: '$user',
        preserveNullAndEmptyArrays: true
      }
    });
    
    // Clean up user data
    pipeline.push({
      $project: {
        'user.password': 0,
        'user.email': 0,
        'user.phone': 0
      }
    });
    
    // Execute main pipeline
    const adverts = await Advert.aggregate(pipeline);
    
    // Get total count with same filters (excluding pagination)
    const countPipeline = pipeline.filter(stage => 
      !('$skip' in stage || '$limit' in stage)
    );
    countPipeline.push({ $count: 'totalCount' });
    
    const countResult = await Advert.aggregate(countPipeline);
    const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
    
    // Calculate metadata
    const totalPages = Math.ceil(totalCount / limit);
    
    return sendSuccess(res, 'Adverts retrieved successfully', {
      adverts,
      meta: {
        currentPage: page,
        totalPages,
        totalRecords: totalCount,
        itemsPerPage: limit,
      },
      appliedFilters: parsedFilters
    });
    
  } catch (error) {
    console.error('Error in searchAdverts:', error);
    return sendError(res, 'Failed to fetch adverts', error);
  }
});

// @desc    Get filter options (categories and subcategories)
// @route   GET /api/adverts/filter-options
// @access  Public
export const getFilterOptions = asyncHandler(async (req, res) => {
  try {
    // Get distinct parent categories
    const categories = await Advert.distinct('category', { status: 'active' });

    // Get distinct subcategories
    const subcategories = await Advert.distinct('subcategory', { status: 'active' });

    return sendSuccess(res, 'Filter options retrieved successfully', {
      categories: categories.filter(Boolean).sort(),
      subcategories: subcategories.filter(Boolean).sort()
    });
  } catch (error) {
    console.error('Error in getFilterOptions:', error);
    return sendError(res, 'Failed to fetch filter options', error);
  }
});

export default {
  searchAdverts,
  getFilterOptions
};