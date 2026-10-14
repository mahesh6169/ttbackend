import asyncHandler from 'express-async-handler';
import Event from '../../models/eventModel.js';
import Reservation from '../../models/reservationModel.js';
import { 
  validateSeatSelection,
  // createSeatReservations, // REMOVED - deprecated, use reservation system instead
  validateUserSeatReservations,
  assignSeatsToTicket,
  releaseUserSeatReservations,
  getUserSeatReservations,
  checkSeatAvailability,
  getSeatDetails,
  bulkUpdateSeatStatus
} from '../../utils/events/seatHelpers.js';
import { cleanupExpiredReservations } from './reservationController.js';
import { getIO } from '../../socket/index.js';

// @desc    Get seat availability for an event
// @route   GET /api/events/:eventId/seats
// @access  Public
export const getSeatAvailability = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // NOTE: We don't run cleanup here because users are actively selecting seats
    // Cleanup is already triggered when entering tickets page and before payment
    
    // Emit cleanup event to all users in the room
    try {
      const io = getIO();
      io.to(`event_${eventId}`).emit('seat:cleanup_completed', {
        eventId,
        timestamp: new Date()
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }
    
    const event = await Event.findById(eventId).select('seatingLayout isPaid');
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (!event.isPaid) {
      return res.status(400).json({
        success: false,
        message: 'This event does not have seat selection'
      });
    }

    res.status(200).json({
      success: true,
      seatingLayout: event.seatingLayout
    });

  } catch (error) {
    console.error('Error fetching seat availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch seat availability'
    });
  }
});

// REMOVED: reserveSeats function - DEPRECATED
// This endpoint is no longer used. The route is commented out in eventRoutes.js
// The new reservation system flow:
// 1. Create reservation via POST /api/events/:eventId/reservation
// 2. Add seats via PUT /api/events/:eventId/reservation/:id/seats
// Frontend code needs to be updated to use the new endpoints

// @desc    Release seat reservations (OLD - REMOVING)
// @route   DELETE /api/events/:eventId/seats/reserve-old
// @access  Private
export const releaseReservations = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds, sessionId } = req.body; // seatIds is optional - if not provided, releases all user's seats
    const userId = req.user._id;

    // Release seat reservations
    const releaseResult = await releaseUserSeatReservations(eventId, userId, seatIds, sessionId);

    if (releaseResult.count === 0) {
      
      return res.status(200).json({
        success: true,
        releasedSeats: [],
        count: 0,
        message: 'No seat reservations found to release (already released or expired)'
      });
    }

    try {
      const io = getIO();
      releaseResult.releasedSeats.forEach(seatId => {
        io.to(`event_${eventId}`).emit('seat:status_changed', {
          seatId,
          status: 'available',
          userId: null,
          reservedBy: null,
          reservedUntil: null,
          timestamp: new Date(),
          operationType: 'release'
        });
      });
      
      // Notify the user that their seats were released
      io.to(`user_${userId}`).emit('seat:reservation_released', {
        eventId,
        releasedSeats: releaseResult.releasedSeats,
        timestamp: new Date()
      });
    } catch (socketError) {
      console.log('Socket emit failed:', socketError.message);
    }

    res.status(200).json({
      success: true,
      releasedSeats: releaseResult.releasedSeats,
      count: releaseResult.count,
      message: `Released ${releaseResult.count} seat reservation(s) successfully`
    });

  } catch (error) {
    console.error('Error releasing reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to release reservations'
    });
  }
});

// @desc    Extend reservation time for user's seats
// @route   PUT /api/events/:eventId/seats/extend
// @access  Private
export const extendReservations = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds, sessionId } = req.body;
    const userId = req.user._id;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    const newExpiry = new Date(Date.now() + 30 * 1000); // Extend by 30 seconds
    const extendedSeats = [];

    // Extend reservations for specified seats or all user's seats
    for (const row of event.seatingLayout) {
      for (const seat of row.seats) {
        const shouldExtend = 
          seat.status === 'selected' &&
          seat.reservedBy?.toString() === userId.toString() &&
          (sessionId === null || seat.sessionId === sessionId) &&
          (seatIds === null || seatIds.includes(seat.seatId));

        if (shouldExtend) {
          seat.reservedUntil = newExpiry;
          extendedSeats.push({
            seatId: seat.seatId,
            newExpiry
          });
        }
      }
    }

    if (extendedSeats.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No valid seat reservations found to extend'
      });
    }

    await event.save();

    res.status(200).json({
      success: true,
      message: `Extended ${extendedSeats.length} seat reservation(s) successfully`,
      extendedSeats,
      newExpiry
    });

  } catch (error) {
    console.error('Error extending reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to extend reservations'
    });
  }
});

// @desc    Get user's current reservations
// @route   GET /api/events/reservations/mine
// @access  Private
export const getMyReservations = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.query; // Optional session filter

    const userReservations = await getUserSeatReservations(userId, sessionId);

    res.status(200).json({
      success: true,
      reservations: userReservations,
      count: userReservations.length,
      totalSeats: userReservations.reduce((sum, event) => sum + event.seatCount, 0)
    });

  } catch (error) {
    console.error('Error fetching user reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reservations'
    });
  }
});

// @desc    Get user's current reservations for a specific event
// @route   GET /api/events/:eventId/seats/my-reservations
// @access  Private
export const getMyEventReservations = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user._id;
    
    // Get the event
    const event = await Event.findById(eventId).select('seatingLayout');
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }
    
    // Find user's reserved seats
    const userSeats = [];
    let reservation = null;
    
    for (const row of event.seatingLayout) {
      for (const seat of row.seats || []) {
        if (seat.status === 'selected' && 
            seat.reservedBy?.toString() === userId.toString() &&
            seat.reservedUntil && 
            new Date(seat.reservedUntil) > new Date()) {
          userSeats.push({
            seatId: seat.seatId,
            rowLabel: row.rowLabel,
            seatNumber: seat.seatNumber || seat.number
          });
          
          // Capture reservation details from first seat
          if (!reservation) {
            reservation = {
              eventId: eventId,
              userId: userId,
              sessionId: seat.sessionId,
              reservedUntil: seat.reservedUntil
            };
          }
        }
      }
    }
    
    res.status(200).json({
      success: true,
      reservation: reservation,
      seats: userSeats,
      seatCount: userSeats.length,
      seatIds: userSeats.map(s => s.seatId)
    });

  } catch (error) {
    console.error('Error fetching event reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event reservations'
    });
  }
});

// @desc    Validate seat reservations before payment
// @route   POST /api/events/:eventId/seats/validate-reservations
// @access  Private
export const validateReservationsForPayment = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds, sessionId } = req.body;
    const userId = req.user._id;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Seat IDs are required'
      });
    }

    const validation = await validateUserSeatReservations(eventId, seatIds, userId, sessionId);

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    res.status(200).json({
      success: true,
      message: 'Seat reservations are valid for payment',
      seats: validation.seats,
      seatCount: validation.seats.length
    });

  } catch (error) {
    console.error('Error validating reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate reservations'
    });
  }
});

// @desc    Check availability of specific seats
// @route   POST /api/events/:eventId/seats/check-availability
// @access  Public
export const checkSeatsAvailability = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Seat IDs are required'
      });
    }

    const availability = await checkSeatAvailability(eventId, seatIds);

    res.status(200).json({
      success: true,
      available: availability.available,
      unavailable: availability.unavailable,
      totalChecked: seatIds.length,
      availableCount: availability.available.length,
      unavailableCount: availability.unavailable.length
    });

  } catch (error) {
    console.error('Error checking seat availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check seat availability'
    });
  }
});

// @desc    Get details of a specific seat
// @route   GET /api/events/:eventId/seats/:seatId
// @access  Public
export const getSeatDetail = asyncHandler(async (req, res) => {
  try {
    const { eventId, seatId } = req.params;

    const seatDetails = await getSeatDetails(eventId, seatId);

    if (!seatDetails) {
      return res.status(404).json({
        success: false,
        message: 'Seat not found'
      });
    }

    res.status(200).json({
      success: true,
      seat: seatDetails
    });

  } catch (error) {
    console.error('Error getting seat details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get seat details'
    });
  }
});

// @desc    Bulk update seat statuses (Admin/Organizer only)
// @route   PUT /api/events/:eventId/seats/bulk-update
// @access  Private (Admin/Organizer)
export const bulkUpdateSeats = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatUpdates } = req.body; // Array of {seatId, newStatus, reservedBy?, sessionId?}
    const userId = req.user._id;

    // Verify user owns the event (you may want to add role-based access control)
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (event.postedBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update seats for this event'
      });
    }

    if (!seatUpdates || !Array.isArray(seatUpdates) || seatUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Seat updates are required'
      });
    }

    const updateResult = await bulkUpdateSeatStatus(eventId, seatUpdates);

    // Emit socket events for updated seats
    try {
      const io = getIO();
      updateResult.results.forEach(result => {
        io.to(`event_${eventId}`).emit('seat:status_changed', {
          seatId: result.seatId,
          status: result.newStatus,
          timestamp: new Date()
        });
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }

    res.status(200).json({
      success: true,
      message: `Successfully updated ${updateResult.updatedCount} seat(s)`,
      updatedCount: updateResult.updatedCount,
      results: updateResult.results
    });

  } catch (error) {
    console.error('Error bulk updating seats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update seats'
    });
  }
});

// @desc    Clean up expired reservations manually (Admin/Organizer)
// @route   POST /api/events/:eventId/seats/cleanup
// @access  Private (Admin/Organizer)
export const manualCleanupExpired = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user._id;

    // Verify user owns the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (event.postedBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cleanup seats for this event'
      });
    }

    await cleanupExpiredReservations(eventId);

    res.status(200).json({
      success: true,
      message: 'Expired reservations cleaned up successfully'
    });

  } catch (error) {
    console.error('Error manual cleanup:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cleanup expired reservations'
    });
  }
});

// @desc    Get seat statistics for an event (Admin/Organizer)
// @route   GET /api/events/:eventId/seats/stats
// @access  Private (Admin/Organizer)
export const getSeatStats = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user._id;

    // Verify user owns the event (optional - you might want to make this public)
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (event.postedBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view seat statistics for this event'
      });
    }

    const { getSeatOccupancyStats } = await import('../../utils/events/seatHelpers.js');
    const stats = await getSeatOccupancyStats(eventId);

    res.status(200).json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error getting seat stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get seat statistics'
    });
  }
});

// ===== NEW ENDPOINTS FOR TWO-PHASE SEAT SELECTION =====

// @desc    Hold a single seat temporarily (5 minutes)
// @route   POST /api/events/:eventId/seats/hold
// @access  Private
export const holdSeat = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatId } = req.body;
    const userId = req.user._id;

    if (!seatId) {
      return res.status(400).json({
        success: false,
        message: 'Seat ID is required'
      });
    }

    // Check if seat is available
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Find the seat in the layout
    let seatFound = false;
    let seatDetails = null;
    
    for (const row of event.seatingLayout) {
      const seat = row.seats.find(s => s.seatId === seatId);
      if (seat) {
        seatFound = true;
        seatDetails = seat;
        
        // Check if seat is available
        if (seat.status !== 'available') {
          return res.status(400).json({
            success: false,
            message: 'Seat is not available'
          });
        }
        
        // Update seat status
        seat.status = 'selected';
        seat.reservedBy = userId;
        seat.reservedUntil = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
        seat.sessionId = req.headers['x-session-id'] || null;
        break;
      }
    }

    if (!seatFound) {
      return res.status(404).json({
        success: false,
        message: 'Seat not found'
      });
    }

    await event.save();

    // Don't create a reservation for individual seat holds
    // The actual reservation is managed by the tickets page
    // Seat holds are temporary and tracked only in the event model

    // Emit socket event
    try {
      const io = getIO();
      io.to(`event_${eventId}`).emit('seat:status_changed', {
        eventId,
        seatId,
        status: 'selected',
        reservedBy: userId,
        reservedUntil: seatDetails.reservedUntil,
        operationType: 'hold'
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }

    res.status(200).json({
      success: true,
      seatId,
      status: 'selected',
      reservedUntil: seatDetails.reservedUntil,
      message: 'Seat held successfully'
    });

  } catch (error) {
    console.error('Error holding seat:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to hold seat'
    });
  }
});

// @desc    Release a single seat hold
// @route   DELETE /api/events/:eventId/seats/hold
// @access  Private
export const releaseSeatHold = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatId } = req.body;
    const userId = req.user._id;

    if (!seatId) {
      return res.status(400).json({
        success: false,
        message: 'Seat ID is required'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Find and update the seat
    let seatReleased = false;
    
    for (const row of event.seatingLayout) {
      const seat = row.seats.find(s => s.seatId === seatId);
      if (seat && seat.reservedBy?.toString() === userId.toString()) {
        seat.status = 'available';
        seat.reservedBy = null;
        seat.reservedUntil = null;
        seat.sessionId = null;
        seatReleased = true;
        break;
      }
    }

    if (!seatReleased) {
      return res.status(404).json({
        success: false,
        message: 'Seat hold not found or not owned by user'
      });
    }

    await event.save();

    // Don't update reservation for individual seat holds
    // The actual reservation is managed by the reservation controller

    // Emit socket event
    try {
      const io = getIO();
      io.to(`event_${eventId}`).emit('seat:status_changed', {
        eventId,
        seatId,
        status: 'available',
        reservedBy: null,
        reservedUntil: null,
        operationType: 'release-hold'
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }

    res.status(200).json({
      success: true,
      seatId,
      message: 'Seat hold released successfully'
    });

  } catch (error) {
    console.error('Error releasing seat hold:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to release seat hold'
    });
  }
});

// @desc    Release group reservation
// @route   DELETE /api/events/:eventId/seats/reserve  
// @access  Private
export const releaseReservation = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds, sessionId } = req.body;
    const userId = req.user._id;

    // Find active reservation
    const reservation = await Reservation.findActiveReservation(eventId, userId);
    
    if (!reservation) {
      return res.status(200).json({
        success: true,
        message: 'No active reservation found',
        releasedSeats: []
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Release seats in event
    const releasedSeats = [];
    for (const seatId of reservation.seatIds) {
      for (const row of event.seatingLayout) {
        const seat = row.seats.find(s => s.seatId === seatId);
        if (seat && seat.reservedBy?.toString() === userId.toString()) {
          seat.status = 'available';
          seat.reservedBy = null;
          seat.reservedUntil = null;
          seat.sessionId = null;
          releasedSeats.push(seatId);
        }
      }
    }

    await event.save();

    // Update reservation
    reservation.phase = 'released';
    await reservation.save();

    // Emit socket events
    try {
      const io = getIO();
      releasedSeats.forEach(seatId => {
        io.to(`event_${eventId}`).emit('seat:status_changed', {
          eventId,
          seatId,
          status: 'available',
          reservedBy: null,
          reservedUntil: null,
          operationType: 'release'
        });
      });

      io.to(`user_${userId}`).emit('seat:reservation_released', {
        eventId,
        releasedSeats,
        timestamp: new Date()
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }

    res.status(200).json({
      success: true,
      releasedSeats,
      count: releasedSeats.length,
      message: 'Reservation released successfully'
    });

  } catch (error) {
    console.error('Error releasing reservation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to release reservation'
    });
  }
});

// @desc    Create group reservation from held seats (10 minutes)
// @route   POST /api/events/:eventId/seats/reserve
// @access  Private
export const createReservation = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { seatIds, ticketTypes } = req.body;
    const userId = req.user._id;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Seat IDs are required'
      });
    }

    if (!ticketTypes || typeof ticketTypes !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Ticket types are required'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Verify all seats are held by the user
    const verifiedSeats = [];
    for (const row of event.seatingLayout) {
      for (const seat of row.seats) {
        if (seatIds.includes(seat.seatId)) {
          if (seat.reservedBy?.toString() !== userId.toString()) {
            return res.status(400).json({
              success: false,
              message: `Seat ${seat.seatId} is not held by you`
            });
          }
          verifiedSeats.push(seat.seatId);
          
          // Extend reservation time to 10 minutes
          seat.reservedUntil = new Date(Date.now() + 10 * 60 * 1000);
        }
      }
    }

    if (verifiedSeats.length !== seatIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Some seats were not found'
      });
    }

    await event.save();

    // Find existing hold and transition to reservation
    let reservation = await Reservation.findOne({
      eventId,
      userId,
      phase: 'hold',
      expiresAt: { $gt: new Date() }
    });

    if (reservation) {
      // Transition to reserved phase
      reservation.phase = 'reserved';
      reservation.seatIds = seatIds;
      reservation.ticketTypes = ticketTypes;
      reservation.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await reservation.save();
    } else {
      // Create new reservation if no hold exists
      reservation = await Reservation.create({
        eventId,
        userId,
        sessionId: req.headers['x-session-id'] || 'web',
        seatIds,
        ticketTypes,
        phase: 'reserved',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        metadata: {
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip
        }
      });
    }

    // Emit socket events
    try {
      const io = getIO();
      
      seatIds.forEach(seatId => {
        io.to(`event_${eventId}`).emit('seat:status_changed', {
          eventId,
          seatId,
          status: 'reserved',
          reservedBy: userId,
          reservedUntil: reservation.expiresAt,
          operationType: 'reserve'
        });
      });

      io.to(`user_${userId}`).emit('seat:reservation_confirmed', {
        eventId,
        reservation: {
          id: reservation._id,
          seatIds: reservation.seatIds,
          expiresAt: reservation.expiresAt,
          ticketTypes: reservation.ticketTypes
        }
      });
    } catch (error) {
      console.log('Socket emit failed:', error.message);
    }

    res.status(200).json({
      success: true,
      reservation: {
        id: reservation._id,
        eventId: reservation.eventId,
        seatIds: reservation.seatIds,
        ticketTypes: reservation.ticketTypes,
        expiresAt: reservation.expiresAt,
        reservedUntil: reservation.expiresAt // for compatibility
      },
      message: 'Reservation created successfully'
    });

  } catch (error) {
    console.error('Error creating reservation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create reservation'
    });
  }
});


// @desc    Get user's active reservations for an event (NEW)
// @route   GET /api/events/:eventId/seats/my-reservations
// @access  Private
export const getMyActiveReservation = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user._id;

    // Find active reservation
    const reservation = await Reservation.findActiveReservation(eventId, userId);

    if (!reservation) {
      return res.status(200).json({
        success: true,
        reservation: null,
        seatIds: [],
        message: 'No active reservation found'
      });
    }

    res.status(200).json({
      success: true,
      reservation: {
        id: reservation._id,
        eventId: reservation.eventId,
        seatIds: reservation.seatIds,
        ticketTypes: reservation.ticketTypes,
        phase: reservation.phase,
        expiresAt: reservation.expiresAt,
        timeRemaining: reservation.timeRemaining
      },
      seatIds: reservation.seatIds // for compatibility
    });

  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reservations'
    });
  }
});