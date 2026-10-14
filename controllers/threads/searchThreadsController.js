// controllers/threads/searchThreadsController.js

import asyncHandler from 'express-async-handler';
import Thread from '../../models/threadModel.js';
import { sendSuccess, sendValidationError, sendError } from '../../utils/response/responseUtil.js';

// @desc    Universal filter endpoint for threads
// @route   GET /api/threads/search
// @access  Public
export const searchThreads = asyncHandler(async (req, res) => {
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
    
    // 2. Category filter
    if (parsedFilters.categories && parsedFilters.categories.length > 0) {
      pipeline.push({
        $match: {
          category: { $in: parsedFilters.categories }
        }
      });
    }
    
    // 3. Communities filter
    // Threads with NO community selected are considered "for all" and always shown
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
    
    // 4. State filter (Australian states)
    if (parsedFilters.state) {
      pipeline.push({
        $match: {
          'suburb.state': parsedFilters.state
        }
      });
    }
    
    // 5. Search text (if provided)
    // Use $text search for better performance when no location filter
    // Fall back to regex when location is used (since $geoNear must be first in pipeline)
    if (parsedFilters.searchText) {
      if (parsedFilters.location?.coordinates) {
        // Location filter is active, use regex (slower but compatible with $geoNear)
        pipeline.push({
          $match: {
            $or: [
              { title: { $regex: parsedFilters.searchText, $options: 'i' } },
              { question: { $regex: parsedFilters.searchText, $options: 'i' } }
            ]
          }
        });
      } else {
        // No location filter, use $text search (faster, uses text index)
        pipeline.push({
          $match: {
            $text: { $search: parsedFilters.searchText }
          }
        });
        // Add text score for relevance sorting
        pipeline.push({
          $addFields: {
            textScore: { $meta: 'textScore' }
          }
        });
      }
    }
    
    // 6. Lookup thread messages for comment count and recent activity
    pipeline.push({
      $lookup: {
        from: 'threadmessages',
        localField: '_id',
        foreignField: 'thread',
        as: 'messages'
      }
    });
    
    // 7. Add fields for metrics
    pipeline.push({
      $addFields: {
        commentCount: { $size: '$messages' },
        hasComments: { $gt: [{ $size: '$messages' }, 0] },
        lastMessageAt: {
          $cond: {
            if: { $gt: [{ $size: '$messages' }, 0] },
            then: { $max: '$messages.createdAt' },
            else: '$createdAt'  // If no messages, use thread creation date
          }
        }
      }
    });
    
    // 8. Sorting - Enhanced with thread-specific options
    const sortOptions = {};
    let sortBy = parsedFilters.sortBy || 'newest';

    // When searching with text (no location), default to relevance sorting
    const usingTextSearch = parsedFilters.searchText && !parsedFilters.location?.coordinates;
    if (usingTextSearch && sortBy === 'newest') {
      sortBy = 'relevance'; // Auto-switch to relevance when searching
    }

    switch (sortBy) {
      case 'relevance':
        // Sort by text search relevance (only works with $text search)
        if (usingTextSearch) {
          sortOptions.textScore = -1; // Highest relevance first
          sortOptions.createdAt = -1; // Secondary sort by newest
        } else {
          // Fall back to newest if not using text search
          sortOptions.createdAt = -1;
        }
        break;

      case 'oldest':
        sortOptions.createdAt = 1; // Ascending order - oldest threads first
        break;

      case 'most_comments':
        sortOptions.commentCount = -1; // Most commented first
        sortOptions.createdAt = -1; // Secondary sort by newest
        break;

      case 'recent_activity':
        sortOptions.lastMessageAt = -1; // Sort by most recent activity (thread or comment)
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
        sortOptions.createdAt = -1; // Descending order - newest threads first
    }

    // Apply sort to pipeline
    pipeline.push({ $sort: sortOptions });
    
    // 7. Pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });
    
    // 8. Populate owner info
    pipeline.push({
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'ownerData'
      }
    });
    
    pipeline.push({
      $addFields: {
        ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
      }
    });
    
    // 9. Clean up results (FIXED: only include fields we want)
    pipeline.push({
      $project: {
        title: 1,
        question: 1,
        category: 1,
        createdAt: 1,
        updatedAt: 1,
        suburb: 1,
        commentCount: 1,
        hasComments: 1,
        lastMessageAt: 1,
        distance: 1,
        owner: 1,
        ownerName: 1,
        isCuratedThread: 1,
        images: 1,
        participants: 1,
        'ownerData.name': 1,
        'ownerData.avatar': 1,
        'ownerData._id': 1
        // Removed exclusions: messages: 0
        // Removed exclusions: 'ownerData.password': 0, etc.
      }
    });
    
    // Execute main pipeline
    const threads = await Thread.aggregate(pipeline);
    
    // Get total count with same filters (excluding pagination)
    const countPipeline = pipeline.filter(stage => 
      !('$skip' in stage || '$limit' in stage || '$project' in stage || '$lookup' in stage || '$addFields' in stage || '$sort' in stage)
    );
    
    countPipeline.push({ $count: 'totalCount' });
    
    const countResult = await Thread.aggregate(countPipeline);
    const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
    
    // Calculate metadata
    const totalPages = Math.ceil(totalCount / limit);
    
    return sendSuccess(res, 'Threads retrieved successfully', {
      threads,
      meta: {
        currentPage: page,
        totalPages,
        totalRecords: totalCount,
        itemsPerPage: limit,
      },
      appliedFilters: parsedFilters
    });
    
  } catch (error) {
    console.error('Error in searchThreads:', error);
    return sendError(res, 'Failed to fetch threads', error);
  }
});

// @desc    Get filter options (categories)
// @route   GET /api/threads/filter-options
// @access  Public
export const getFilterOptions = asyncHandler(async (req, res) => {
  try {
    // Get distinct categories
    const categories = await Thread.distinct('category');
    
    return sendSuccess(res, 'Filter options retrieved successfully', {
      categories: categories.sort()
    });
  } catch (error) {
    console.error('Error in getFilterOptions:', error);
    return sendError(res, 'Failed to fetch filter options', error);
  }
});

// @desc    Get threads with recent activity 
// @route   GET /api/threads/recent-activity
// @access  Public
export const getRecentActivity = asyncHandler(async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const limitNum = parseInt(limit, 10);

    // Find threads with recent messages or creation
    const pipeline = [
      // Lookup for messages related to threads
      { 
        $lookup: {
          from: 'threadmessages',
          localField: '_id',
          foreignField: 'thread',
          as: 'messages'
        }
      },
      // Add fields for sorting
      {
        $addFields: {
          lastActivity: {
            $cond: {
              if: { $gt: [{ $size: '$messages' }, 0] },
              then: { $max: '$messages.createdAt' }, 
              else: '$createdAt' // If no messages, use thread creation date
            }
          },
          commentCount: { $size: '$messages' }
        }
      },
      // Sort by the most recent activity
      { $sort: { lastActivity: -1 } },
      // Limit to the requested number
      { $limit: limitNum },
      // Lookup owner information
      {
        $lookup: {
          from: 'users',
          localField: 'owner',
          foreignField: '_id',
          as: 'ownerData'
        }
      },
      // FIXED: only include fields we want
      {
        $project: {
          title: 1,
          question: 1,
          category: 1,
          createdAt: 1,
          updatedAt: 1,
          lastActivity: 1,
          commentCount: 1,
          owner: 1,
          ownerName: { $arrayElemAt: ['$ownerData.name', 0] }
          // Removed exclusions: messages: 0
          // Removed exclusions: 'ownerData': 0
        }
      }
    ];

    const recentThreads = await Thread.aggregate(pipeline);
    
    return sendSuccess(res, 'Recent thread activity retrieved successfully', {
      recentThreads
    });
    
  } catch (error) {
    console.error('Error in getRecentActivity:', error);
    return sendError(res, 'Failed to fetch recent thread activity', error);
  }
});

export default {
  searchThreads,
  getFilterOptions,
  getRecentActivity
};