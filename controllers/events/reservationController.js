import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Reservation from '../../models/reservationModel.js';
import Event from '../../models/eventModel.js';
import { calculateCurrentTicketsSold, bundleMultipleMessage, lineSubtotalCents, isSalesOpen } from '../../utils/events/ticketHelpers.js';

// @desc    Create or update reservation
// @route   POST /api/events/:eventId/reservation
// @access  Private
export const createOrUpdateReservation = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { tickets } = req.body;
  
  // Check if user is authenticated
  if (!req.user || !req.user._id) {
    return res.status(401).json({
      success: false,
      message: 'User not authenticated'
    });
  }
  
  const userId = req.user._id;
  const sessionId = req.headers['x-session-id'] || req.sessionID || 'web';

  // Validate event exists and is paid
  const event = await Event.findById(eventId).populate('ticketTypes');
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }

  if (!event.isPaid) {
    res.status(400);
    throw new Error('This endpoint is only for paid events');
  }

  // 🚫 Organiser-cancelled (soft-deleted) event: booking is closed (events-past-events.md D4).
  if (event.deletedByOrganiser) {
    res.status(400);
    throw new Error('This event has been cancelled by the organiser and is no longer bookable.');
  }

  // 🚫 Moderation-blocked event: not bookable (events-delete-retention.md D5/AC7).
  if (event.isBlocked) {
    res.status(400);
    throw new Error('This event is no longer available.');
  }

  // Sales cutoff (D3): refuse a new/updated reservation once the event day has passed.
  if (!isSalesOpen(event)) {
    return res.status(400).json({
      success: false,
      message: 'Ticket sales for this event have closed.',
      errorCode: 'SALES_CLOSED',
    });
  }

  // Check for existing active reservation
  let reservation = await Reservation.findActiveReservation(eventId, userId);
  
  // Calculate requested quantity
  const requestedQuantity = tickets.reduce((sum, t) => sum + t.quantity, 0);
  
  // If no tickets requested, skip capacity check (user is clearing their selection)
  if (requestedQuantity > 0) {
    // Clean up expired reservations first
    await cleanupExpiredReservations(eventId);
    
    // Calculate current capacity
    const soldTickets = await calculateCurrentTicketsSold(eventId);
    
    // Count active reservations (excluding current user)
    const bufferTime = new Date(Date.now() + 30000); // 30 sec buffer
    const matchCriteria = {
      eventId: new mongoose.Types.ObjectId(eventId),
      status: 'active',
      expiresAt: { $gt: bufferTime },
      tickets: { $exists: true, $ne: [] },
      userId: { $ne: new mongoose.Types.ObjectId(userId) } // Exclude current user
    };
    
    const pipeline = [
      {
        $match: matchCriteria
      },
      {
        $unwind: {
          path: '$tickets',
          preserveNullAndEmptyArrays: false
        }
      },
      {
        $match: {
          'tickets.quantity': { $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          totalReserved: { $sum: '$tickets.quantity' }
        }
      }
    ];
    
    const result = await Reservation.aggregate(pipeline);
    const activeReservations = result[0]?.totalReserved || 0;
    
    // Get current user's existing reservation quantity
    const currentUserQuantity = reservation ? reservation.tickets.reduce((sum, t) => sum + t.quantity, 0) : 0;
    
    // Calculate available capacity - FIX: use event.capacity not maxAttendees
    const totalCapacity = event.capacity || 0;
    const currentlyUsed = soldTickets + activeReservations;
    const availableCapacity = totalCapacity > 0 ? Math.max(0, totalCapacity - currentlyUsed) : Number.MAX_SAFE_INTEGER;
    
    // Calculate true available (including user's own reservation) - matches frontend display
    const trueAvailable = totalCapacity > 0 ? Math.max(0, totalCapacity - soldTickets - activeReservations - currentUserQuantity) : Number.MAX_SAFE_INTEGER;
    
    // Check if there's enough capacity
    if (totalCapacity > 0 && requestedQuantity > availableCapacity) {
      // Check if it's truly sold out or just temporarily reserved
      const isTrulySoldOut = soldTickets >= totalCapacity;
      const isTemporarilyFull = !isTrulySoldOut && (soldTickets + activeReservations) >= totalCapacity;
      
      let message;
      if (availableCapacity === 0) {
        if (isTrulySoldOut) {
          message = 'Sorry, this event is now sold out.';
        } else if (isTemporarilyFull) {
          message = 'Tickets are currently being purchased by other customers. Please try again in a few minutes.';
        } else {
          message = 'No tickets available at this time.';
        }
      } else {
        // Use trueAvailable to match frontend display
        if (trueAvailable === 0) {
          message = 'No more tickets available. Please reduce your selection.';
        } else {
          message = `Only ${trueAvailable} ticket${trueAvailable === 1 ? '' : 's'} available. Please reduce your selection.`;
        }
      }
      
      return res.status(400).json({
        success: false,
        message,
        isTrulySoldOut,
        isTemporarilyFull
      });
    }
    
    console.log(`🎫 Capacity check passed: ${requestedQuantity} requested, ${availableCapacity} available (${currentlyUsed}/${totalCapacity} used)`);
  }

  // Calculate ticket details and total amount
  const ticketDetails = [];
  let totalAmountCents = 0;

  for (const ticket of tickets) {
    const ticketType = event.ticketTypes.find(
      tt => tt._id.toString() === ticket.ticketTypeId
    );

    if (!ticketType) {
      res.status(400);
      throw new Error(`Invalid ticket type: ${ticket.ticketTypeId}`);
    }

    // Multiples wall: a bundle type can only be reserved in whole packs.
    if (ticket.quantity > 0 && ticketType.bundleSize && ticketType.bundleSize >= 2 &&
        ticket.quantity % ticketType.bundleSize !== 0) {
      res.status(400);
      throw new Error(bundleMultipleMessage(ticketType.name, ticketType.bundleSize));
    }

    if (ticket.quantity > 0) {
      ticketDetails.push({
        ticketTypeId: ticketType._id,
        ticketName: ticketType.name,
        price: ticketType.price,
        quantity: ticket.quantity,
        ...(ticketType.bundleSize && ticketType.bundleSize >= 2 ? { bundleSize: ticketType.bundleSize } : {})
      });
      // A bundle line is packPrice x packs, not price x people (D11).
      totalAmountCents += lineSubtotalCents(ticketType, ticket.quantity);
    }
  }

  const totalAmount = totalAmountCents / 100;

  const reservationData = {
    userId,
    sessionId,
    eventId,
    tickets: ticketDetails,
    totalAmount,
    status: 'active'
  };

  if (reservation) {
    // Update existing reservation - DON'T change expiresAt!
    Object.assign(reservation, reservationData);
    // Keep the original expiresAt time
    await reservation.save();
  } else {
    // Create new reservation - set expiresAt only on creation
    // Use 2 minutes for development, 15 minutes for production
    const RESERVATION_EXPIRY_MS = process.env.NODE_ENV === 'development' 
      ? 2 * 60 * 1000   // 2 minutes for testing
      : 15 * 60 * 1000; // 15 minutes for production
    
    reservationData.expiresAt = new Date(Date.now() + RESERVATION_EXPIRY_MS);
    reservation = await Reservation.create(reservationData);
  }

  res.status(200).json({
    success: true,
    reservationId: reservation._id,
    tickets: reservation.tickets,
    totalAmount: reservation.totalAmount,
    expiresAt: reservation.expiresAt
  });
});

// @desc    Add seats to reservation
// @route   PUT /api/events/:eventId/reservation/:id/seats
// @access  Private
export const addSeatsToReservation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { seatIds } = req.body;
  const userId = req.user._id;

  // Find reservation
  const reservation = await Reservation.findById(id);
  if (!reservation) {
    res.status(404);
    throw new Error('Reservation not found');
  }

  // Verify ownership
  if (reservation.userId.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to update this reservation');
  }

  // Check if reservation is active
  if (!reservation.isActive()) {
    res.status(400);
    throw new Error('Reservation has expired or is not active');
  }

  // Update seats in eventModel
  const event = await Event.findById(reservation.eventId);
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }

  // Clear any previous seats
  if (reservation.seatIds && reservation.seatIds.length > 0) {
    await Event.updateOne(
      { _id: reservation.eventId },
      {
        $set: {
          'seatingLayout.$[].seats.$[seat].status': 'available',
          'seatingLayout.$[].seats.$[seat].reservedBy': null,
          'seatingLayout.$[].seats.$[seat].reservedUntil': null,
          'seatingLayout.$[].seats.$[seat].sessionId': null
        }
      },
      {
        arrayFilters: [
          { 
            'seat.seatId': { $in: reservation.seatIds },
            'seat.status': 'selected' // Only clear seats that were 'selected', not organizer 'reserved'
          }
        ]
      }
    );
  }

  // Update new seats
  if (seatIds && seatIds.length > 0) {
    await Event.updateOne(
      { _id: reservation.eventId },
      {
        $set: {
          'seatingLayout.$[].seats.$[seat].status': 'selected',
          'seatingLayout.$[].seats.$[seat].reservedBy': userId,
          'seatingLayout.$[].seats.$[seat].reservedUntil': reservation.expiresAt,
          'seatingLayout.$[].seats.$[seat].sessionId': reservation.sessionId
        }
      },
      {
        arrayFilters: [
          { 'seat.seatId': { $in: seatIds } }
        ]
      }
    );
  }

  // Update reservation
  reservation.seatIds = seatIds;
  await reservation.save();

  res.status(200).json({
    success: true,
    reservationId: reservation._id,
    seatIds: reservation.seatIds,
    expiresAt: reservation.expiresAt
  });
});

// @desc    Get active reservation
// @route   GET /api/events/:eventId/reservation
// @access  Private
export const getReservation = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  // Check if user is authenticated
  if (!req.user || !req.user._id) {
    return res.status(401).json({
      success: false,
      message: 'User not authenticated'
    });
  }
  
  const userId = req.user._id;

  try {
    const reservation = await Reservation.findActiveReservation(eventId, userId);
    
    if (!reservation) {
      // Return 404 with proper error response format
      return res.status(404).json({
        success: false,
        message: 'No active reservation found'
      });
    }

    res.status(200).json({
      success: true,
      reservation: {
        _id: reservation._id,
        eventId: reservation.eventId,
        tickets: reservation.tickets,
        seatIds: reservation.seatIds,
        totalAmount: reservation.totalAmount,
        buyerInfo: reservation.buyerInfo,
        expiresAt: reservation.expiresAt,
        status: reservation.status
      }
    });
  } catch (error) {
    console.error('Error in getReservation:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching reservation',
      error: error.message
    });
  }
});

// @desc    Delete reservation
// @route   DELETE /api/events/:eventId/reservation/:id
// @access  Private
export const deleteReservation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  // Find reservation
  const reservation = await Reservation.findById(id);
  if (!reservation) {
    res.status(404);
    throw new Error('Reservation not found');
  }

  // Verify ownership
  if (reservation.userId.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to delete this reservation');
  }

  // Clear seats in eventModel if any
  if (reservation.seatIds && reservation.seatIds.length > 0) {
    await Event.updateOne(
      { _id: reservation.eventId },
      {
        $set: {
          'seatingLayout.$[].seats.$[seat].status': 'available',
          'seatingLayout.$[].seats.$[seat].reservedBy': null,
          'seatingLayout.$[].seats.$[seat].reservedUntil': null,
          'seatingLayout.$[].seats.$[seat].sessionId': null
        }
      },
      {
        arrayFilters: [
          { 
            'seat.seatId': { $in: reservation.seatIds },
            'seat.status': 'selected' // Only clear seats that were 'selected', not organizer 'reserved'
          }
        ]
      }
    );
  }

  // Delete reservation
  await reservation.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Reservation deleted successfully',
    releasedSeats: reservation.seatIds ? reservation.seatIds.length : 0
  });
});

// @desc    Update buyer info
// @route   PUT /api/events/:eventId/reservation/:id/buyer
// @access  Private
export const updateBuyerInfo = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { buyerInfo } = req.body;
  const userId = req.user._id;

  const reservation = await Reservation.findById(id);
  if (!reservation) {
    res.status(404);
    throw new Error('Reservation not found');
  }

  if (reservation.userId.toString() !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to update this reservation');
  }

  if (!reservation.isActive()) {
    res.status(400);
    throw new Error('Reservation has expired or is not active');
  }

  reservation.buyerInfo = buyerInfo;
  await reservation.save();

  res.status(200).json({
    success: true,
    message: 'Buyer info updated'
  });
});

// @desc    Cleanup expired reservations
// @route   Internal function
// @access  Internal
export const cleanupExpiredReservations = async (eventId) => {
  const stats = {
    orphanedDeleted: 0,
    expiredDeleted: 0,
    seatsReleased: 0,
    orphanedSeatsFixed: 0,
    errors: []
  };

  try {
    // Find orphaned reservations (events that don't exist)
    const eventIds = await Event.distinct('_id');
    const orphanedResult = await Reservation.deleteMany({
      eventId: { $nin: eventIds }
    });
    stats.orphanedDeleted = orphanedResult.deletedCount || 0;
    
    // Clean expired reservations for specific event
    if (eventId) {
      // First, find expired reservations to get seat info
      const expiredReservations = await Reservation.find({
        eventId: eventId,
        status: 'active',
        expiresAt: { $lt: new Date() }
      });

      // Clear seats for expired reservations
      for (const reservation of expiredReservations) {
        if (reservation.seatIds && reservation.seatIds.length > 0) {
          try {
            await Event.updateOne(
              { _id: reservation.eventId },
              {
                $set: {
                  'seatingLayout.$[].seats.$[seat].status': 'available',
                  'seatingLayout.$[].seats.$[seat].reservedBy': null,
                  'seatingLayout.$[].seats.$[seat].reservedUntil': null,
                  'seatingLayout.$[].seats.$[seat].sessionId': null
                }
              },
              {
                arrayFilters: [
                  {
                    // Scoped to THIS expired reservation's own seatIds (the buyer's held seats), so
                    // freeing both 'selected' and buyer-'reserved' holds is safe: an organiser hold is
                    // never part of a buyer reservation. 'booked' and 'disabled' seats are left alone.
                    'seat.seatId': { $in: reservation.seatIds },
                    'seat.status': { $in: ['selected', 'reserved'] }
                  }
                ]
              }
            );
            stats.seatsReleased += reservation.seatIds.length;
          } catch (seatError) {
            console.error(`Error releasing seats for reservation ${reservation._id}:`, seatError);
            stats.errors.push(`Failed to release seats for reservation ${reservation._id}`);
          }
        }
      }

      // DELETE expired reservations (not just mark them)
      const deleteResult = await Reservation.deleteMany({
        eventId: eventId,
        status: 'active',
        expiresAt: { $lt: new Date() }
      });
      stats.expiredDeleted = deleteResult.deletedCount || 0;
    } else {
      // Global cleanup - delete ALL expired reservations
      const allExpiredReservations = await Reservation.find({
        status: 'active',
        expiresAt: { $lt: new Date() }
      }).limit(100); // Process in batches to avoid memory issues

      for (const reservation of allExpiredReservations) {
        if (reservation.seatIds && reservation.seatIds.length > 0) {
          try {
            await Event.updateOne(
              { _id: reservation.eventId },
              {
                $set: {
                  'seatingLayout.$[].seats.$[seat].status': 'available',
                  'seatingLayout.$[].seats.$[seat].reservedBy': null,
                  'seatingLayout.$[].seats.$[seat].reservedUntil': null,
                  'seatingLayout.$[].seats.$[seat].sessionId': null
                }
              },
              {
                arrayFilters: [
                  {
                    // Scoped to THIS expired reservation's own seatIds (the buyer's held seats), so
                    // freeing both 'selected' and buyer-'reserved' holds is safe: an organiser hold is
                    // never part of a buyer reservation. 'booked' and 'disabled' seats are left alone.
                    'seat.seatId': { $in: reservation.seatIds },
                    'seat.status': { $in: ['selected', 'reserved'] }
                  }
                ]
              }
            );
            stats.seatsReleased += reservation.seatIds.length;
          } catch (seatError) {
            console.error(`Error releasing seats for reservation ${reservation._id}:`, seatError);
            stats.errors.push(`Failed to release seats for reservation ${reservation._id}`);
          }
        }
      }

      // Delete all expired reservations
      const globalDeleteResult = await Reservation.deleteMany({
        status: 'active',
        expiresAt: { $lt: new Date() }
      });
      stats.expiredDeleted = globalDeleteResult.deletedCount || 0;
    }

    // Clean up orphaned seats (seats marked as reserved but no active reservation)
    if (eventId) {
      const event = await Event.findById(eventId);
      if (event && event.seatingLayout && event.seatingLayout.length > 0) {
        // Get all active reservations for this event
        const activeReservations = await Reservation.find({
          eventId: eventId,
          status: 'active',
          expiresAt: { $gt: new Date() }
        });
        
        // Create a set of legitimately reserved seat IDs
        const legitimatelyReservedSeats = new Set();
        activeReservations.forEach(reservation => {
          if (reservation.seatIds && reservation.seatIds.length > 0) {
            reservation.seatIds.forEach(seatId => legitimatelyReservedSeats.add(seatId));
          }
        });
        
        // Find orphaned seats
        const orphanedSeatIds = [];
        event.seatingLayout.forEach(section => {
          section.seats.forEach(seat => {
            if (seat.status === 'selected' && 
                !legitimatelyReservedSeats.has(seat.seatId)) {
              orphanedSeatIds.push(seat.seatId);
            }
          });
        });
        
        // Fix orphaned seats
        if (orphanedSeatIds.length > 0) {
          await Event.updateOne(
            { _id: eventId },
            {
              $set: {
                'seatingLayout.$[].seats.$[seat].status': 'available',
                'seatingLayout.$[].seats.$[seat].reservedBy': null,
                'seatingLayout.$[].seats.$[seat].reservedUntil': null,
                'seatingLayout.$[].seats.$[seat].sessionId': null
              }
            },
            {
              arrayFilters: [
                { 
                  'seat.seatId': { $in: orphanedSeatIds },
                  'seat.status': 'selected' // Double-check we only clean 'selected' seats
                }
              ]
            }
          );
          stats.orphanedSeatsFixed = orphanedSeatIds.length;
          console.log(`Fixed ${orphanedSeatIds.length} orphaned seats: ${orphanedSeatIds.join(', ')}`);
        }
      }
    }

    return stats;
  } catch (error) {
    console.error('Error in cleanup task:', error);
    stats.errors.push(error.message);
    return stats;
  }
};

// @desc    Trigger cleanup of expired reservations (API endpoint)
// @route   POST /api/events/:eventId/reservation/cleanup
// @access  Private
export const triggerCleanup = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  // Check if user is authenticated (optional for cleanup, but good for security)
  if (!req.user || !req.user._id) {
    return res.status(401).json({
      success: false,
      message: 'User not authenticated'
    });
  }
  
  console.log(`Triggering cleanup for event ${eventId}`);
  
  // Run cleanup and wait for results
  const stats = await cleanupExpiredReservations(eventId);
  
  res.status(200).json({
    success: true,
    message: 'Cleanup completed',
    stats: {
      orphanedReservationsDeleted: stats.orphanedDeleted,
      expiredReservationsDeleted: stats.expiredDeleted,
      seatsReleased: stats.seatsReleased,
      orphanedSeatsFixed: stats.orphanedSeatsFixed,
      errors: stats.errors
    }
  });
});