import asyncHandler from 'express-async-handler';
import Event from '../../models/eventModel.js';
import { startOfDay, startOfMonth, addMonths, parse, format } from 'date-fns';
import dateFnsTz from 'date-fns-tz';

const { zonedTimeToUtc, utcToZonedTime } = dateFnsTz;

// Pagination helper function (same as filterController.js)
const getPagination = (page = 1, limit = 10) => {
  const pageNumber = parseInt(page, 10);
  const limitNumber = parseInt(limit, 10);
  const skip = (pageNumber - 1) * limitNumber;
  return { pageNumber, limitNumber, skip };
};

// Helper function to expand recurring events
const expandRecurringEvents = (events, monthStart, monthEnd) => {
  const expandedEvents = [];
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  
  // First, create a map of date strings to track which dates already have events
  // This helps us avoid duplication on the same day
  const dateTracker = new Map();
  
  // Add all original events first (non-recurring and parent events)
  for (const event of events) {
    if (event.dateTime >= monthStart && event.dateTime < monthEnd) {
      // Add the original event to our results
      expandedEvents.push(JSON.parse(JSON.stringify(event)));
      
      // Mark this date as having an event (in the event's timezone)
      const eventDate = new Date(event.dateTime);
      const localDate = utcToZonedTime(eventDate, event.timeZone || 'Australia/Sydney');
      const dateString = format(localDate, 'yyyy-MM-dd');
      
      // Store which days have events by their date string
      if (!dateTracker.has(dateString)) {
        dateTracker.set(dateString, []);
      }
      dateTracker.get(dateString).push(event._id.toString());
    }
  }
  
  // Then process recurring instances for all events
  for (const event of events) {
    // Skip if not a recurring event
    if (!event.recurrence?.isRecurring || !Array.isArray(event.recurrence.repeatSchedule)) {
      continue;
    }
    
    const baseEvent = JSON.parse(JSON.stringify(event));
    const repeatSchedule = baseEvent.recurrence.repeatSchedule;
    const recurrenceEndDate = new Date(baseEvent.recurrence.endDate); // End date is now required
    
    // Check each recurrence pattern
    repeatSchedule.forEach(({ day, time }) => {
      const targetWeekday = weekdayMap[day];
      
      // Start from the first date in our range or the event date, whichever is later
      let current = new Date(Math.max(new Date(baseEvent.dateTime), monthStart));
      
      // Process until end date
      while (current <= recurrenceEndDate && current <= monthEnd) {
        // Convert to event's timezone for day-of-week check
        const localCurrent = utcToZonedTime(current, baseEvent.timeZone || 'Australia/Sydney');
        
        // Get date string for tracking (YYYY-MM-DD)
        const dateString = format(localCurrent, 'yyyy-MM-dd');
        
        // Check if day of week matches AND this date doesn't already have the parent event
        if (localCurrent.getDay() === targetWeekday && 
            (!dateTracker.has(dateString) || !dateTracker.get(dateString).includes(baseEvent._id.toString()))) {
          
          // Create occurrence time in the event's timezone
          const [hours, minutes] = time.split(':').map(Number);
          const occurrence = zonedTimeToUtc(
            new Date(
              localCurrent.getFullYear(),
              localCurrent.getMonth(),
              localCurrent.getDate(),
              hours, 
              minutes
            ),
            baseEvent.timeZone || 'Australia/Sydney'
          );
          
          // Only add if within our search range
          if (occurrence >= monthStart && occurrence < monthEnd) {
            // Create recurring instance
            const recurringInstance = {
              ...baseEvent,
              dateTime: occurrence,
              _id: `${baseEvent._id.toString()}_${occurrence.toISOString()}`,
              isRecurringInstance: true,
              parentEventId: baseEvent._id
            };
            
            expandedEvents.push(recurringInstance);
            
            // Mark this date as having this event now
            if (!dateTracker.has(dateString)) {
              dateTracker.set(dateString, []);
            }
            dateTracker.get(dateString).push(baseEvent._id.toString());
          }
        }
        
        // Move to next day
        current.setDate(current.getDate() + 1);
      }
    });
  }
  
  // Sort all events by date
  expandedEvents.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
  
  return expandedEvents;
};

// Helper function to get date range
// Helper function to get date range
const getDateRange = (month) => {
  let monthStart, monthEnd;
  const today = new Date();
  const currentMonth = format(today, 'yyyy-MM');
  
  if (!month || month === "") {
    // No month specified or empty string - show all future events
    monthStart = zonedTimeToUtc(startOfDay(today, { timeZone: 'Australia/Sydney' }), 'Australia/Sydney');
    
    // Set end date far in the future to include all upcoming events
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 100); // 100 years in the future
    monthEnd = zonedTimeToUtc(farFuture, 'Australia/Sydney');
  } else {
    try {
      const parsedMonth = parse(month, 'yyyy-MM', new Date());
      
      // If selected month is the current month, start from today
      if (month === currentMonth) {
        monthStart = zonedTimeToUtc(startOfDay(today, { timeZone: 'Australia/Sydney' }), 'Australia/Sydney');
      } else {
        // For future months, use start of month
        // For past months, skip past events by using today's date
        const monthBeginning = startOfMonth(parsedMonth);
        monthStart = (monthBeginning < today) 
          ? zonedTimeToUtc(startOfDay(today, { timeZone: 'Australia/Sydney' }), 'Australia/Sydney')
          : zonedTimeToUtc(monthBeginning, 'Australia/Sydney');
      }
      
      monthEnd = zonedTimeToUtc(startOfMonth(addMonths(parsedMonth, 1)), 'Australia/Sydney');
    } catch (err) {
      throw new Error('Invalid month format. Expected YYYY-MM.');
    }
  }

  return { monthStart, monthEnd };
};
// @desc    Get all events with filtering options
// @route   GET /api/filters/events
// @access  Public
export const getAllEvents = asyncHandler(async (req, res) => {
  const { category, location, proximity = 10, page = 1, limit = 10, month } = req.query;
  const { pageNumber, limitNumber } = getPagination(page, limit);

  try {
    const pipeline = [];

    // Location filter
    if (location) {
      const [longitude, latitude] = location.split(',').map(Number);
      if (isNaN(longitude) || isNaN(latitude)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid location format. Expected format: longitude,latitude',
        });
      }

      pipeline.push({
        $geoNear: {
          near: { type: 'Point', coordinates: [longitude, latitude] },
          distanceField: 'distance',
          maxDistance: proximity * 1000,
          spherical: true,
        },
      });
    }

    // Category filter
    if (category) {
      pipeline.push({
        $match: { category: { $regex: category, $options: 'i' } },
      });
    }

    // Date filter
    try {
      const { monthStart, monthEnd } = getDateRange(month);
      
      pipeline.push({
        $match: {
          deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events from upcoming (events-past-events.md)
          isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
          $or: [
            { dateTime: { $gte: monthStart } },
            { 'recurrence.isRecurring': true },
          ],
        },
      });

      // Sort by date
      pipeline.push({ $sort: { dateTime: 1 } });

      // Fetch events
      const events = await Event.aggregate(pipeline);

      // Expand recurring events
      const expandedEvents = expandRecurringEvents(events, monthStart, monthEnd);

      // Apply pagination
      const skip = (pageNumber - 1) * limitNumber;
      const paginated = expandedEvents.slice(skip, skip + limitNumber);

      return res.status(200).json({
        success: true,
        events: paginated,
        meta: {
          totalItems: expandedEvents.length,
          currentPage: pageNumber,
          totalPages: Math.ceil(expandedEvents.length / limitNumber),
          itemsPerPage: limitNumber,
        },
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } catch (error) {
    console.error('Error fetching events:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message,
    });
  }
});

// @desc    Get events by category
// @route   GET /api/filters/events/categories
// @access  Public
export const getEventsByCategory = asyncHandler(async (req, res) => {
  const { categories, page = 1, limit = 10, month } = req.query;
  const { pageNumber, limitNumber } = getPagination(page, limit);

  try {
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

    const pipeline = [];

    // Category filter
    if (categoryArray) {
      pipeline.push({
        $match: { category: { $in: categoryArray.map(cat => new RegExp(cat, 'i')) } },
      });
    }

    // Date filter
    try {
      const { monthStart, monthEnd } = getDateRange(month);
      
      pipeline.push({
        $match: {
          deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events from upcoming (events-past-events.md)
          isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
          $or: [
            { dateTime: { $gte: monthStart } },
            { 'recurrence.isRecurring': true },
          ],
        },
      });

      // Sort by date
      pipeline.push({ $sort: { dateTime: 1 } });

      // Fetch events
      const events = await Event.aggregate(pipeline);

      // Expand recurring events
      const expandedEvents = expandRecurringEvents(events, monthStart, monthEnd);

      // Apply pagination
      const skip = (pageNumber - 1) * limitNumber;
      const paginated = expandedEvents.slice(skip, skip + limitNumber);

      return res.status(200).json({
        success: true,
        events: paginated,
        meta: {
          totalItems: expandedEvents.length,
          currentPage: pageNumber,
          totalPages: Math.ceil(expandedEvents.length / limitNumber),
          itemsPerPage: limitNumber,
        },
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } catch (error) {
    console.error('Error fetching events by category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events by category',
      error: error.message,
    });
  }
});

// @desc    Get events by location
// @route   GET /api/filters/events/location
// @access  Public
export const getEventsByLocation = asyncHandler(async (req, res) => {
  const { location, page = 1, limit = 10, month } = req.query;
  const { pageNumber, limitNumber } = getPagination(page, limit);

  try {
    const DEFAULT_PROXIMITY_KM = 60;
    const pipeline = [];

    // If no location provided → fetch ALL events
    if (!location) {
      try {
        const { monthStart, monthEnd } = getDateRange(month);
        
        pipeline.push(
          {
            $match: {
              deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events from upcoming (events-past-events.md)
              isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
              $or: [
                { dateTime: { $gte: monthStart } },
                { 'recurrence.isRecurring': true },
              ],
            },
          },
          { $sort: { dateTime: 1 } }
        );

        // Fetch events
        const events = await Event.aggregate(pipeline);

        // Expand recurring events
        const expandedEvents = expandRecurringEvents(events, monthStart, monthEnd);

        // Apply pagination
        const skip = (pageNumber - 1) * limitNumber;
        const paginated = expandedEvents.slice(skip, skip + limitNumber);

        return res.status(200).json({
          success: true,
          events: paginated,
          meta: {
            totalItems: expandedEvents.length,
            currentPage: pageNumber,
            totalPages: Math.ceil(expandedEvents.length / limitNumber),
            itemsPerPage: limitNumber,
          },
        });
      } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
      }
    }

    // If location is provided → apply geoNear filtering
    const [longitude, latitude] = location.split(',').map(Number);
    if (isNaN(longitude) || isNaN(latitude)) {
      return res.status(400).json({ success: false, message: 'Invalid location format.' });
    }

    const geoNearStage = {
      $geoNear: {
        near: { type: 'Point', coordinates: [longitude, latitude] },
        distanceField: 'distance',
        maxDistance: DEFAULT_PROXIMITY_KM * 1000,
        spherical: true,
      },
    };

    pipeline.push(geoNearStage);

    // Date filter
    try {
      const { monthStart, monthEnd } = getDateRange(month);
      
      pipeline.push({
        $match: {
          deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events from upcoming (events-past-events.md)
          isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
          $or: [
            { dateTime: { $gte: monthStart } },
            { 'recurrence.isRecurring': true },
          ],
        },
      });

      // Sort by date
      pipeline.push({ $sort: { dateTime: 1 } });

      // Fetch events
      const events = await Event.aggregate(pipeline);

      // Expand recurring events
      const expandedEvents = expandRecurringEvents(events, monthStart, monthEnd);

      // Apply pagination
      const skip = (pageNumber - 1) * limitNumber;
      const paginated = expandedEvents.slice(skip, skip + limitNumber);

      return res.status(200).json({
        success: true,
        events: paginated,
        meta: {
          totalItems: expandedEvents.length,
          currentPage: pageNumber,
          totalPages: Math.ceil(expandedEvents.length / limitNumber),
          itemsPerPage: limitNumber,
        },
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } catch (error) {
    console.error('Error fetching events by location:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events by location',
      error: error.message,
    });
  }
});

// @desc    Get events by custom category selection
// @route   GET /api/filters/events/custom-category
// @access  Public
export const getEventsCustomCategory = asyncHandler(async (req, res) => {
  const { categories, page = 1, limit = 10, month } = req.query;
  const { pageNumber, limitNumber } = getPagination(page, limit);

  // Validate: categories must always be provided
  if (!categories) {
    return res.status(400).json({
      success: false,
      message: 'Categories are required.',
    });
  }

  try {
    // Parse categories (comma-separated string or array)
    const selectedCategories = Array.isArray(categories)
      ? categories
      : categories.split(',').map((c) => c.trim());

    const pipeline = [];

    // Category filter
    pipeline.push({
      $match: { category: { $in: selectedCategories.map(cat => new RegExp(cat, 'i')) } },
    });

    // Date filter
    try {
      const { monthStart, monthEnd } = getDateRange(month);
      
      pipeline.push({
        $match: {
          deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events from upcoming (events-past-events.md)
          isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
          $or: [
            { dateTime: { $gte: monthStart } },
            { 'recurrence.isRecurring': true },
          ],
        },
      });

      // Sort by date
      pipeline.push({ $sort: { dateTime: 1 } });

      // Fetch events
      const events = await Event.aggregate(pipeline);

      // Expand recurring events
      const expandedEvents = expandRecurringEvents(events, monthStart, monthEnd);

      // Apply pagination
      const skip = (pageNumber - 1) * limitNumber;
      const paginated = expandedEvents.slice(skip, skip + limitNumber);

      return res.status(200).json({
        success: true,
        events: paginated,
        meta: {
          totalItems: expandedEvents.length,
          currentPage: pageNumber,
          totalPages: Math.ceil(expandedEvents.length / limitNumber),
          itemsPerPage: limitNumber,
        },
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  } catch (error) {
    console.error('Error fetching events by custom category:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events by custom category',
      error: error.message,
    });
  }
});