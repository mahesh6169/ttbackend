// searchEventController.js - NO TIMEZONE CONVERSION (Frontend handles all timezone logic)

import asyncHandler from 'express-async-handler';
import Event from '../../models/eventModel.js';
import { startOfDay, startOfMonth, addMonths, parse, format } from 'date-fns';

// Helper function to get date range - NO TIMEZONE CONVERSION
const getDateRange = (month) => {
  let monthStart, monthEnd;
  const today = new Date();
  const currentMonth = format(today, 'yyyy-MM');
  
  if (!month || month === "") {
    // No month specified - show all future events from today
    monthStart = startOfDay(today);
    
    // Set end date far in the future
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 100);
    monthEnd = farFuture;
  } else {
    try {
      const parsedMonth = parse(month, 'yyyy-MM', new Date());
      
      // If selected month is the current month, start from today
      if (month === currentMonth) {
        monthStart = startOfDay(today);
      } else {
        // For future months, use start of month
        // For past months, skip past events by using today's date
        const monthBeginning = startOfMonth(parsedMonth);
        monthStart = monthBeginning < today ? startOfDay(today) : monthBeginning;
      }
      
      monthEnd = startOfMonth(addMonths(parsedMonth, 1));
    } catch (err) {
      throw new Error('Invalid month format. Expected YYYY-MM.');
    }
  }

  return { monthStart, monthEnd };
};

// @desc    Universal filter endpoint for events
// @route   GET /api/events/search
// @access  Public
export const searchEvents = asyncHandler(async (req, res) => {
  try {
    const { filters = {}, pagination = {} } = req.query;
    
    // Parse filters if they come as string
    const parsedFilters = typeof filters === 'string' ? JSON.parse(filters) : filters;
    const parsedPagination = typeof pagination === 'string' ? JSON.parse(pagination) : pagination;
    
    // Extract pagination parameters
    const page = parseInt(parsedPagination.page, 10) || 1;
    const limit = parseInt(parsedPagination.limit, 10) || 12;
    
    // Build aggregation pipeline dynamically
    const pipeline = [];

    // 1. Geospatial filter (if location provided)
    if (parsedFilters.location?.coordinates) {
      const { coordinates, radius = 60 } = parsedFilters.location;
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
          category: { $in: parsedFilters.categories.map(cat => new RegExp(cat, 'i')) }
        }
      });
    } else if (parsedFilters.category) {
      // Single category filter (for backwards compatibility)
      pipeline.push({
        $match: { category: { $regex: parsedFilters.category, $options: 'i' } }
      });
    }
    
    // 3. Communities filter
    // Events with NO community selected are considered "for all" and always shown
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
          'address.state': parsedFilters.state
        }
      });
    }

    // 5. Event type filter (free/paid)
    if (parsedFilters.eventType) {
      pipeline.push({
        $match: {
          isPaid: parsedFilters.eventType === 'paid'
        }
      });
    }

    // 6. Search text filter
    if (parsedFilters.searchText && parsedFilters.searchText.trim() !== '') {
      const searchText = parsedFilters.searchText.trim();
      pipeline.push({
        $match: {
          $or: [
            { title: { $regex: searchText, $options: 'i' } },
            { description: { $regex: searchText, $options: 'i' } },
            { venue: { $regex: searchText, $options: 'i' } },
            { category: { $regex: searchText, $options: 'i' } },
            { 'address.suburb': { $regex: searchText, $options: 'i' } },
            { 'organiser.name': { $regex: searchText, $options: 'i' } }
          ]
        }
      });
    }

    // 7. Date/Month filter - SIMPLE DATE COMPARISON
    try {
      const { monthStart, monthEnd } = getDateRange(parsedFilters.month);
      
      console.log(`🔍 Searching events between ${monthStart.toISOString()} and ${monthEnd.toISOString()}`);
      
      // Simple date range filter - no timezone conversion needed
      pipeline.push({
        $match: {
          dateTime: { $gte: monthStart, $lt: monthEnd }
        }
      });
      
      // Filter only events that are live (goLive: true) and not organiser-cancelled (events-past-events.md)
      // or moderation-blocked (events-delete-retention.md D5)
      pipeline.push({
        $match: {
          goLive: true,
          deletedByOrganiser: { $ne: true },
          isBlocked: { $ne: true }
        }
      });

      // Exclude demo events from main listing
      pipeline.push({
        $match: {
          demo: { $ne: true }
        }
      });
      
      // Sort logic
      if (parsedFilters.sortBy === 'distance' && parsedFilters.location?.coordinates) {
        // If sorting by distance, $geoNear has already handled sorting
      } else {
        // Default to sorting by date
        pipeline.push({ $sort: { dateTime: 1 } });
      }
      
      // Execute pipeline
      const events = await Event.aggregate(pipeline);
      
      console.log(`🔍 Found ${events.length} events (including stored recurring instances)`);
      
      // Use events directly - no processing needed since instances are stored in DB
      const processedEvents = events;
      
      // Manual pagination
      const skip = (page - 1) * limit;
      const paginatedEvents = processedEvents.slice(skip, skip + limit);
      
      // Calculate metadata
      const totalCount = processedEvents.length;
      const totalPages = Math.ceil(totalCount / limit);
      
      return res.status(200).json({
        success: true,
        message: 'Events retrieved successfully',
        events: paginatedEvents,
        meta: {
          currentPage: page,
          totalPages,
          totalRecords: totalCount,
          itemsPerPage: limit,
        },
        appliedFilters: parsedFilters
      });
      
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    
  } catch (error) {
    console.error('Error in searchEvents:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message,
    });
  }
});

// @desc    Get filter options (categories)
// @route   GET /api/events/filter-options
// @access  Public
export const getFilterOptions = asyncHandler(async (req, res) => {
  try {
    // Get distinct categories
    const categories = await Event.distinct('category', { 
      dateTime: { $gte: new Date() } 
    });
    
    return res.status(200).json({
      success: true,
      message: 'Filter options retrieved successfully',
      categories: categories.sort()
    });
  } catch (error) {
    console.error('Error in getFilterOptions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch filter options',
      error: error.message,
    });
  }
});

// @desc    Search demo events only (demo: true)
// @route   GET /api/events/demo
// @access  Public
export const searchDemoEvents = asyncHandler(async (req, res) => {
  try {
    const { filters = {}, pagination = {} } = req.query;

    // Parse filters if they come as string
    const parsedFilters = typeof filters === 'string' ? JSON.parse(filters) : filters;
    const parsedPagination = typeof pagination === 'string' ? JSON.parse(pagination) : pagination;

    // Extract pagination parameters
    const page = parseInt(parsedPagination.page, 10) || 1;
    const limit = parseInt(parsedPagination.limit, 10) || 12;

    // Build aggregation pipeline dynamically
    const pipeline = [];

    // 1. Geospatial filter (if location provided)
    if (parsedFilters.location?.coordinates) {
      const { coordinates, radius = 60 } = parsedFilters.location;
      const [longitude, latitude] = coordinates;

      if (!isNaN(longitude) && !isNaN(latitude)) {
        pipeline.push({
          $geoNear: {
            near: { type: 'Point', coordinates: [longitude, latitude] },
            distanceField: 'distance',
            maxDistance: radius * 1000,
            spherical: true,
          },
        });
      }
    }

    // 2. Category filter
    if (parsedFilters.categories && parsedFilters.categories.length > 0) {
      pipeline.push({
        $match: {
          category: { $in: parsedFilters.categories.map(cat => new RegExp(cat, 'i')) }
        }
      });
    }

    // 3. Communities filter
    // Events with NO community selected are considered "for all" and always shown
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

    // 4. State filter
    if (parsedFilters.state) {
      pipeline.push({
        $match: {
          'address.state': parsedFilters.state
        }
      });
    }

    // 5. Search text filter
    if (parsedFilters.searchText && parsedFilters.searchText.trim() !== '') {
      const searchText = parsedFilters.searchText.trim();
      pipeline.push({
        $match: {
          $or: [
            { title: { $regex: searchText, $options: 'i' } },
            { description: { $regex: searchText, $options: 'i' } },
            { venue: { $regex: searchText, $options: 'i' } },
            { category: { $regex: searchText, $options: 'i' } },
            { 'address.suburb': { $regex: searchText, $options: 'i' } }
          ]
        }
      });
    }

    // 6. Date filter - show all future demo events
    const today = new Date();
    pipeline.push({
      $match: {
        dateTime: { $gte: today }
      }
    });

    // 7. DEMO FILTER - only demo events
    pipeline.push({
      $match: {
        demo: true
      }
    });

    // Sort by date
    if (parsedFilters.sortBy === 'distance' && parsedFilters.location?.coordinates) {
      // $geoNear handles sorting
    } else {
      pipeline.push({ $sort: { dateTime: 1 } });
    }

    // Execute pipeline
    const events = await Event.aggregate(pipeline);

    console.log(`🎭 Found ${events.length} demo events`);

    // Manual pagination
    const skip = (page - 1) * limit;
    const paginatedEvents = events.slice(skip, skip + limit);

    // Calculate metadata
    const totalCount = events.length;
    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json({
      success: true,
      message: 'Demo events retrieved successfully',
      events: paginatedEvents,
      meta: {
        currentPage: page,
        totalPages,
        totalRecords: totalCount,
        itemsPerPage: limit,
      },
      appliedFilters: parsedFilters
    });

  } catch (error) {
    console.error('Error in searchDemoEvents:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch demo events',
      error: error.message,
    });
  }
});

export default {
  searchEvents,
  getFilterOptions,
  searchDemoEvents
};