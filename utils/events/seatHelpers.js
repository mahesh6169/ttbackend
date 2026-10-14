import Event from '../../models/eventModel.js';
import Reservation from '../../models/reservationModel.js';
import mongoose from 'mongoose';
import { getIO } from '../../socket/index.js';

/**
 * Validate seat selection
 * @param {String} eventId - Event ID
 * @param {Array} seatIds - Array of seat IDs like ["A-1", "B-3"]
 * @param {String} ticketTypeId - Ticket type ID
 * @returns {Object} { isValid: boolean, error?: string }
 */
export const validateSeatSelection = async (eventId, seatIds, ticketTypeId) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return { isValid: false, error: 'Event not found' };
    }

    if (!event.isPaid) {
      return { isValid: false, error: 'This event does not support seat selection' };
    }

    if (!event.seatingLayout || event.seatingLayout.length === 0) {
      return { isValid: false, error: 'No seating layout configured for this event' };
    }

    // Check each seat
    for (const seatId of seatIds) {
      let seatFound = false;
      
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        
        if (seat) {
          seatFound = true;
          
          // Check seat availability
          if (seat.status !== 'available') {
            return { 
              isValid: false, 
              error: `Seat ${seatId} is not available` 
            };
          }

          // Check if seat is reserved by someone else
          if (seat.reservedBy && seat.reservedUntil > new Date()) {
            return { 
              isValid: false, 
              error: `Seat ${seatId} is already reserved` 
            };
          }

          // Check ticket type compatibility (if specified)
          if (ticketTypeId && seat.ticketTypeId && seat.ticketTypeId !== ticketTypeId) {
            return { 
              isValid: false, 
              error: `Seat ${seatId} is not available for the selected ticket type` 
            };
          }
          
          break;
        }
      }

      if (!seatFound) {
        return { 
          isValid: false, 
          error: `Seat ${seatId} does not exist` 
        };
      }
    }

    return { isValid: true };

  } catch (error) {
    console.error('❌ Error validating seat selection:', error);
    return { isValid: false, error: 'Seat validation failed' };
  }
};

// REMOVED: createSeatReservations function - DEPRECATED
// This function is no longer used. The new reservation system flow:
// 1. Create reservation via POST /api/events/:eventId/reservation (creates reservation with 5 min expiry)
// 2. Add seats via PUT /api/events/:eventId/reservation/:id/seats (seats inherit reservation expiry)
// This ensures all seats share the same expiration timer as the reservation

/**
 * Validate user's seat reservations before payment
 * @param {String} eventId - Event ID
 * @param {Array} seatIds - Array of seat IDs to validate
 * @param {String} userId - User ID
 * @param {String} sessionId - Session ID (optional)
 * @returns {Object} { isValid: boolean, error?: string, seats?: Array }
 */
export const validateUserSeatReservations = async (eventId, seatIds, userId, sessionId = null) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return { isValid: false, error: 'Event not found' };
    }

    const validSeats = [];
    const now = new Date();

    // Check each seat
    for (const seatId of seatIds) {
      let seatValid = false;
      
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        if (seat) {
          // Check ownership
          if (seat.reservedBy?.toString() !== userId.toString()) {
            return { 
              isValid: false, 
              error: `Seat ${seatId} is not reserved by this user` 
            };
          }

          // Check if reservation hasn't expired
          if (seat.reservedUntil <= now) {
            return { 
              isValid: false, 
              error: `Reservation for seat ${seatId} has expired` 
            };
          }

          // Check status
          if (seat.status !== 'selected') {
            return { 
              isValid: false, 
              error: `Seat ${seatId} is not in selected state` 
            };
          }

          // Check session if provided
          if (sessionId && seat.sessionId !== sessionId) {
            return { 
              isValid: false, 
              error: `Seat ${seatId} belongs to different session` 
            };
          }

          validSeats.push({
            seatId: seat.seatId,
            row: seat.row,  
            seatNumber: seat.seatNumber,
            ticketTypeId: seat.ticketTypeId
          });
          seatValid = true;
          break;
        }
      }

      if (!seatValid) {
        return { 
          isValid: false, 
          error: `Seat ${seatId} not found or invalid` 
        };
      }
    }

    return { 
      isValid: true, 
      seats: validSeats 
    };

  } catch (error) {
    console.error('❌ Error validating user seat reservations:', error);
    return { isValid: false, error: 'Reservation validation failed' };
  }
};

/**
 * Assign seats to ticket after successful payment
 * @param {String} eventId - Event ID
 * @param {Array} seatIds - Array of seat IDs to assign
 * @param {Object} ticket - Ticket document
 * @returns {Array} Array of assigned seat objects
 */
export const assignSeatsToTicket = async (eventId, seatIds, ticket) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    const assignedSeats = [];

    // Update each seat to booked status
    for (const seatId of seatIds) {
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        if (seat) {
          // Update seat status to booked
          seat.status = 'booked';
          
          // Emit socket event for real-time updates
          try {
            const io = getIO();
            io.to(`event_${eventId}`).emit('seat:status_changed', {
              seatId: seat.seatId,
              status: 'booked',
              userId: null, // No longer held by specific user
              timestamp: new Date()
            });
          } catch (error) {
            console.log('Socket not available:', error.message);
          }

          // Clear reservation data (keep reservedBy for audit trail)
          seat.reservedUntil = null;
          seat.sessionId = null;

          // Collect seat data for ticket
          assignedSeats.push({
            row: seat.row,
            seatNumber: seat.seatNumber,
            seatId: seat.seatId,
            ticketTypeId: seat.ticketTypeId || ticket.ticketType._id
          });

          console.log(`✅ Assigned seat ${seatId} to ticket ${ticket.ticketNumber}`);
          break;
        }
      }
    }

    await event.save();

    console.log(`✅ Assigned ${assignedSeats.length} seats to ticket ${ticket.ticketNumber}`);
    return assignedSeats;

  } catch (error) {
    console.error('❌ Error assigning seats to ticket:', error);
    throw error;
  }
};

// REMOVED: cleanupExpiredReservations function was moved to reservationController.js
// The old implementation here used deprecated 'phase' field and old reservation logic
// All imports have been updated to use the correct version from reservationController.js

/**
 * Release user's seat reservations (manual release)
 * @param {String} eventId - Event ID
 * @param {String} userId - User ID
 * @param {Array} seatIds - Array of seat IDs to release (optional, releases all if not provided)
 * @param {String} sessionId - Session ID (optional)
 * @returns {Object} Release result
 */
export const releaseUserSeatReservations = async (eventId, userId, seatIds = null, sessionId = null) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    const releasedSeats = [];

    for (const row of event.seatingLayout) {
      for (const seat of row.seats) {
        // Check if this seat should be released
           const shouldRelease = 
          seat.status === 'selected' &&
          seat.reservedBy?.toString() === userId.toString() &&
          (seatIds === null || seatIds.includes(seat.seatId)) &&
          // ✅ NEW: More flexible session matching for cleanup scenarios
          (sessionId === null || // Always release if sessionId is null (cleanup mode)
           seat.sessionId === sessionId || // Exact match
           seat.sessionId === null || // Legacy seats without sessionId
           seat.sessionId === undefined || // Handle undefined sessionId
           sessionId === 'cleanup_session' || // Emergency cleanup identifier
           // If reservation expired, allow cleanup regardless of session
           (seat.reservedUntil && seat.reservedUntil <= new Date()));

        if (shouldRelease) {
          seat.status = 'available';
          seat.reservedBy = null;
          seat.reservedUntil = null;
          seat.sessionId = null;
          
          releasedSeats.push(seat.seatId);

          // Emit socket event
          try {
            const io = getIO();
            io.to(`event_${eventId}`).emit('seat:status_changed', {
              seatId: seat.seatId,
              status: 'available',
              userId: null,
              timestamp: new Date()
            });
          } catch (error) {
            console.log('Socket emit failed:', error.message);
          }
        }
      }
    }

   // ✅ TASK 3: Enhanced logging and validation
    if (releasedSeats.length > 0) {
      await event.save();
      console.log(`🪑 Released ${releasedSeats.length} seat reservations for user ${userId}`, {
        releasedSeats,
        sessionId,
        requestedSeats: seatIds
      });
    } else {
      console.log(`ℹ️ No seats found to release for user ${userId}`, {
        sessionId,
        requestedSeats: seatIds,
        totalSeatsInEvent: event.seatingLayout.reduce((total, row) => total + row.seats.length, 0)
      });
    }

    return {
      releasedSeats,
      count: releasedSeats.length
    };

  } catch (error) {
    console.error('❌ Error releasing user seat reservations:', error);
    throw error;
  }
};

/**
 * Check seat availability for multiple seats
 * @param {String} eventId - Event ID
 * @param {Array} seatIds - Array of seat IDs
 * @returns {Object} { available: Array, unavailable: Array }
 */
export const checkSeatAvailability = async (eventId, seatIds) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    const available = [];
    const unavailable = [];
    const now = new Date();

    for (const seatId of seatIds) {
      let isAvailable = false;
      
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        if (seat) {
          if (seat.status === 'available' || 
              (seat.status === 'selected' && seat.reservedUntil <= now)) {
            available.push(seatId);
            isAvailable = true;
          }
          break;
        }
      }

      if (!isAvailable) {
        unavailable.push(seatId);
      }
    }

    return { available, unavailable };

  } catch (error) {
    console.error('❌ Error checking seat availability:', error);
    return { available: [], unavailable: seatIds };
  }
};

/**
 * Get seat details [ don not change rowLable to row ]
 * @param {String} eventId - Event ID
 * @param {String} seatId - Seat ID
 * @returns {Object} Seat details
 */
export const getSeatDetails = async (eventId, seatId) => {
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return null;
    }

    for (const row of event.seatingLayout) {
      const seat = row.seats.find(s => s.seatId === seatId);
      if (seat) {
        return {
          ...seat.toObject(),
          rowLabel: row.rowLabel
        };
      }
    }

    return null;

  } catch (error) {
    console.error('❌ Error getting seat details:', error);
    return null;
  }
};

/**
 * Release seats for a specific ticket after refund
 * @param {String} eventId - Event ID
 * @param {Object} ticket - Ticket document with seats
 * @returns {Object} Release result
 */
export const releaseSeatsForTicket = async (eventId, ticket) => {
  try {
    if (!ticket.seats || ticket.seats.length === 0) {
      return { seatsReleased: 0, seatIds: [] };
    }

    const event = await Event.findById(eventId);
    if (!event || !event.seatingLayout) {
      throw new Error('Event or seating layout not found');
    }

    const releasedSeatIds = [];
    let seatsReleased = 0;

    // Release each seat assigned to this ticket
    for (const ticketSeat of ticket.seats) {
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === ticketSeat.seatId);
        if (seat) {
          // Only release if currently booked
          if (seat.status === 'booked') {
            seat.status = 'available';
            seat.reservedBy = null;
            seat.reservedUntil = null;
            seat.sessionId = null;
            
            seatsReleased++;
            releasedSeatIds.push(seat.seatId);

            // Emit socket event
            try {
              const io = getIO();
              io.to(`event_${eventId}`).emit('seat:status_changed', {
                seatId: seat.seatId,
                status: 'available',
                userId: null,
                timestamp: new Date()
              });
            } catch (error) {
              console.log('Socket not available:', error.message);
            }
          }
        }
      }
    }

    await event.save();

    console.log(`🪑 Released ${seatsReleased} seats for ticket ${ticket.ticketNumber}`);
    return {
      seatsReleased,
      seatIds: releasedSeatIds
    };

  } catch (error) {
    console.error('❌ Error releasing seats for ticket:', error);
    throw error;
  }
};

/**
 * Get seat occupancy statistics for an event
 * @param {String} eventId - Event ID
 * @returns {Object} Seat statistics
 */
export const getSeatOccupancyStats = async (eventId) => {
  try {
    const event = await Event.findById(eventId).select('seatingLayout');
    
    if (!event || !event.seatingLayout) {
      return {
        totalSeats: 0,
        availableSeats: 0,
        selectedSeats: 0,
        reservedSeats: 0,
        bookedSeats: 0,
        disabledSeats: 0,
        occupancyRate: 0
      };
    }

    const stats = {
      totalSeats: 0,
      availableSeats: 0,
      selectedSeats: 0,
      reservedSeats: 0,
      bookedSeats: 0,
      disabledSeats: 0
    };

    for (const row of event.seatingLayout) {
      for (const seat of row.seats) {
        stats.totalSeats++;
        switch (seat.status) {
          case 'available':
            stats.availableSeats++;
            break;
          case 'selected':
            stats.selectedSeats++;
            break;
          case 'reserved':
            stats.reservedSeats++;
            break;
          case 'booked':
            stats.bookedSeats++;
            break;
          case 'disabled':
            stats.disabledSeats++;
            break;
        }
      }
    }

    return {
      ...stats,
      occupancyRate: stats.totalSeats > 0 ? 
        ((stats.bookedSeats + stats.reservedSeats) / stats.totalSeats * 100).toFixed(2) : 0
    };

  } catch (error) {
    console.error('❌ Error getting seat occupancy stats:', error);
    return {
      totalSeats: 0,
      availableSeats: 0,
      selectedSeats: 0,
      reservedSeats: 0,
      bookedSeats: 0,
      disabledSeats: 0,
      occupancyRate: 0
    };
  }
};

/**
 * Find tickets by seat IDs
 * @param {String} eventId - Event ID
 * @param {Array} seatIds - Array of seat IDs
 * @returns {Array} Array of tickets occupying those seats
 */
export const findTicketsBySeatIds = async (eventId, seatIds) => {
  try {
    const PaidTicket = (await import('../../models/paidTicket.js')).default;
    
    const tickets = await PaidTicket.find({
      event: eventId,
      'seats.seatId': { $in: seatIds },
      status: { $in: ['confirmed', 'checked-in'] }
    }).populate('user', 'name email');

    return tickets;

  } catch (error) {
    console.error('❌ Error finding tickets by seat IDs:', error);
    return [];
  }
};

/**
 * Bulk seat status update
 * @param {String} eventId - Event ID
 * @param {Array} seatUpdates - Array of {seatId, newStatus, reservedBy?, sessionId?}
 * @returns {Object} Update result
 */
export const bulkUpdateSeatStatus = async (eventId, seatUpdates) => {
  try {
    const event = await Event.findById(eventId);
    if (!event || !event.seatingLayout) {
      throw new Error('Event or seating layout not found');
    }

    let updatedCount = 0;
    const updateResults = [];

    for (const update of seatUpdates) {
      const { seatId, newStatus, reservedBy, sessionId } = update;
      
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        if (seat) {
          const oldStatus = seat.status;
          seat.status = newStatus;
          
          // Handle reservation data based on new status
          if (newStatus === 'available') {
            seat.reservedBy = null;
            seat.reservedUntil = null;
            seat.sessionId = null;
          } else if (newStatus === 'selected' && reservedBy) {
            seat.reservedBy = reservedBy;
            //seat.reservedUntil = new Date(Date.now() + 30 * 1000); // 30 seconds
            seat.reservedUntil = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
            seat.sessionId = sessionId || null;
          } else if (newStatus === 'reserved' && reservedBy) {
            seat.reservedBy = reservedBy;
            seat.reservedUntil = null; // No expiry for organizer reservations
            seat.sessionId = 'organizer-reserved';
          }
          
          updatedCount++;
          updateResults.push({
            seatId,
            oldStatus,
            newStatus,
            row: seat.row,
          });
          break;
        }
      }
    }

    await event.save();

    console.log(`🪑 Bulk updated ${updatedCount} seat statuses`);
    return {
      updatedCount,
      results: updateResults
    };

  } catch (error) {
    console.error('❌ Error in bulk seat status update:', error);
    throw error;
  }
};

/**
 * Get user's current seat reservations
 * @param {String} userId - User ID
 * @param {String} sessionId - Session ID (optional)
 * @returns {Array} Array of user's current reservations
 */
export const getUserSeatReservations = async (userId, sessionId = null) => {
  try {
    // Find events where user has selected seats
    const events = await Event.find({
      'seatingLayout.seats.reservedBy': userId,
      'seatingLayout.seats.status': 'selected'
    }).select('title seatingLayout');

    const userReservations = [];

    for (const event of events) {
      const reservedSeats = [];
      
      for (const row of event.seatingLayout) {
        for (const seat of row.seats) {
          if (seat.reservedBy?.toString() === userId.toString() && 
              seat.status === 'selected' &&
              (sessionId === null || seat.sessionId === sessionId) &&
              seat.reservedUntil > new Date()) {
            
            reservedSeats.push({
              seatId: seat.seatId,
              row: seat.row,
              seatNumber: seat.seatNumber,
              reservedUntil: seat.reservedUntil,
              sessionId: seat.sessionId
            });
          }
        }
      }

      if (reservedSeats.length > 0) {
        userReservations.push({
          eventId: event._id,
          eventTitle: event.title,
          seats: reservedSeats,
          seatCount: reservedSeats.length
        });
      }
    }

    return userReservations;

  } catch (error) {
    console.error('❌ Error getting user seat reservations:', error);
    return [];
  }
};

/**
 * Clean up seats by session ID (for browser session cleanup)
 * @param {String} sessionId - Session ID to clean up
 * @returns {Object} Cleanup result
 */
export const cleanupSeatsBySession = async (sessionId) => {
  try {
    const events = await Event.find({
      'seatingLayout.seats.sessionId': sessionId,
      'seatingLayout.seats.status': 'selected'
    });

    let totalCleaned = 0;

    for (const event of events) {
      let eventCleaned = 0;
      
      for (const row of event.seatingLayout) {
        for (const seat of row.seats) {
          if (seat.sessionId === sessionId && seat.status === 'selected') {
            seat.status = 'available';
            seat.reservedBy = null;
            seat.reservedUntil = null;
            seat.sessionId = null;
            eventCleaned++;
            totalCleaned++;

            // Emit socket event
            try {
              const io = getIO();
              io.to(`event_${event._id}`).emit('seat:status_changed', {
                seatId: seat.seatId,
                status: 'available',
                userId: null,
                timestamp: new Date()
              });
            } catch (error) {
              console.log('Socket emit failed:', error.message);
            }
          }
        }
      }

      if (eventCleaned > 0) {
        await event.save();
        console.log(`🧹 Cleaned up ${eventCleaned} seats for session ${sessionId} in event ${event._id}`);
      }
    }

    console.log(`🧹 Total cleanup: ${totalCleaned} seats for session ${sessionId}`);
    return {
      totalCleaned,
      sessionId
    };

  } catch (error) {
    console.error('❌ Error cleaning up seats by session:', error);
    throw error;
  }
};