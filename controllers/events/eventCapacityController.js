// controllers/events/eventCapacityController.js

import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Event from '../../models/eventModel.js';
import { calculateCurrentFreeRegistrations } from '../../utils/events/helperFreeEvent.js';
import { calculateCurrentTicketsSold } from '../../utils/events/ticketHelpers.js';
import { cleanupExpiredReservations } from './reservationController.js';
import { 
  countActiveReservations, 
  getUserReservationCount,
  formatCapacityDisplay,
  getAvailabilityStatus 
} from '../../utils/events/capacityHelpers.js';

/**
 * Calculate capacity for FREE/RSVP events
 * @param {Object} event - Event document
 * @returns {Object} Capacity information
 */
const calculateFreeEventCapacity = async (event) => {
  try {
    // Use the existing helper function to get total attendees
    const totalAttendees = await calculateCurrentFreeRegistrations(event._id);
    
    // Get total capacity from event
    const totalCapacity = event.capacity || 0;
    
    // Calculate remaining
    const remaining = totalCapacity > 0 ? 
      Math.max(0, totalCapacity - totalAttendees) : 
      'unlimited';
    
    // Determine if event is full
    const isFull = totalCapacity > 0 && totalAttendees >= totalCapacity;
    
    return {
      total: totalCapacity,
      sold: totalAttendees, // For FREE events, "sold" means registered attendees
      reserved: 0, // No reservation system for FREE events
      remaining: remaining,
      isUnlimited: totalCapacity === 0,
      confirmedAllocations: totalAttendees, // For FREE events, same as sold
      status: isFull ? 'sold-out' : 'available',
      eventType: 'free'
    };
    
  } catch (error) {
    console.error('Error calculating free event capacity:', error);
    throw error;
  }
};

/**
 * Calculate capacity for PAID events without seats
 * @param {Object} event - Event document
 * @param {String} userId - Current user ID (optional)
 * @param {String} context - Display context ('viewing' | 'purchasing')
 * @returns {Object} Capacity information
 */
const calculatePaidEventCapacity = async (event, userId = null, context = 'viewing') => {
  try {
    // Always trigger cleanup first for paid events
    await cleanupExpiredReservations(event._id);
    
    // Get sold tickets count
    const soldTickets = await calculateCurrentTicketsSold(event._id);
    
    // Get active reservations (excluding current user if in purchasing context)
    const reservations = await countActiveReservations(event._id, {
      excludeUserId: context === 'purchasing' ? userId : null,
      bufferSeconds: 0  // No buffer - count only truly active reservations
    });
    
    
    // Get user's current reservation if applicable
    const userReservation = (context === 'purchasing' && userId) 
      ? await getUserReservationCount(event._id, userId)
      : 0;
    
    // Calculate totals
    const totalCapacity = event.capacity || 0;
    const effectiveSold = soldTickets + reservations.totalTickets;
    const remaining = totalCapacity > 0 
      ? Math.max(0, totalCapacity - effectiveSold)
      : 'unlimited';
    
    // Base capacity data
    const capacityData = {
      total: totalCapacity,
      sold: soldTickets,
      reserved: reservations.totalTickets,
      remaining: remaining,
      isUnlimited: totalCapacity === 0,
      eventType: 'paid-nonseated'
    };
    
    // Determine status based on context
    if (context === 'purchasing' && userReservation > 0 && remaining === 0) {
      // User has reservation but no additional spots - not "sold out" for them
      capacityData.status = 'limited';
    } else {
      capacityData.status = getAvailabilityStatus(
        remaining === 'unlimited' ? totalCapacity : remaining, 
        totalCapacity
      );
    }
    
    // Add context-specific fields
    if (context === 'viewing') {
      // For viewing, only show confirmed sales
      capacityData.confirmedAllocations = soldTickets;
      capacityData.displayText = formatCapacityDisplay(capacityData, 'viewing');
    } else if (context === 'purchasing') {
      // For purchasing, include user-specific data
      capacityData.userReservation = userReservation;
      // canBook should be the total capacity minus tickets sold/reserved by others
      // This represents the maximum this user could potentially book
      capacityData.canBook = totalCapacity === 0 
        ? 'unlimited' 
        : Math.max(0, totalCapacity - soldTickets - (reservations.totalTickets - userReservation));
      capacityData.activeReservations = reservations.count;
      
      // True event availability (for display on tickets page)
      // This is total capacity minus ALL bookings (sold + ALL active reservations)
      const allReservations = reservations.totalTickets + userReservation;
      capacityData.trueAvailable = totalCapacity === 0 
        ? 'unlimited'
        : Math.max(0, totalCapacity - soldTickets - allReservations);
    }
    
    // Log for monitoring
    if (reservations.totalTickets > 0 || context === 'purchasing') {
      console.log(`📊 Paid event capacity (${context}):`, {
        eventId: event._id,
        sold: soldTickets,
        reserved: reservations.totalTickets,
        remaining: remaining,
        userReservation: userReservation
      });
    }
    
    return capacityData;
    
  } catch (error) {
    console.error('Error calculating paid event capacity:', error);
    throw error;
  }
};

/**
 * Calculate capacity for PAID events with seats
 * @param {Object} event - Event document
 * @param {String} userId - Current user ID (optional)
 * @param {String} context - Display context ('viewing' | 'purchasing')
 * @returns {Object} Capacity information
 */
const calculateSeatedEventCapacity = async (event, userId = null, context = 'viewing') => {
  try {
    // Always trigger cleanup first for seated events
    await cleanupExpiredReservations(event._id);
    
    // Count seats by status
    let totalSeats = 0;
    let bookedSeats = 0;
    let reservedSeats = 0; // organizer reserved
    let blockedSeats = 0; // organizer not-for-sale (events-blocked-seats.md)
    let selectedSeats = 0;
    let availableSeats = 0;
    let userSelectedSeats = 0;

    // Iterate through seating layout
    event.seatingLayout.forEach(section => {
      section.seats.forEach(seat => {
        totalSeats++;
        switch(seat.status) {
          case 'booked': 
            bookedSeats++; 
            break;
          case 'reserved':
            reservedSeats++;
            break;
          case 'blocked':
            blockedSeats++;
            break;
          case 'selected':
            selectedSeats++;
            // Check if this seat is selected by current user
            if (userId && seat.reservedBy?.toString() === userId.toString()) {
              userSelectedSeats++;
            }
            break;
          case 'available': 
            availableSeats++; 
            break;
          default:
            // Handle any unknown status as unavailable
            console.warn(`Unknown seat status: ${seat.status} for seat ${seat.seatId}`);
        }
      });
    });

    // Get sold tickets count (for events that might have ticket sales before seat implementation)
    const soldTickets = await calculateCurrentTicketsSold(event._id);
    
    // Base capacity data
    const capacityData = {
      total: totalSeats,
      eventType: 'paid-seated',
      hasSeatingLayout: true
    };

    if (context === 'viewing') {
      // Views page: booked + organizer reserved + not-for-sale are unavailable
      const unavailable = bookedSeats + reservedSeats + blockedSeats;
      const viewingAvailable = totalSeats - unavailable;

      capacityData.sold = bookedSeats;
      capacityData.organizerReserved = reservedSeats;
      capacityData.organizerBlocked = blockedSeats;
      capacityData.available = viewingAvailable;
      capacityData.remaining = viewingAvailable; // Add remaining for frontend consistency
      capacityData.status = viewingAvailable === 0 ? 'sold-out' : 'available';
      
      // For viewing, we show a simple "X of Y sold" format
      capacityData.confirmedAllocations = bookedSeats;
      capacityData.displayText = formatCapacityDisplay(capacityData, 'viewing');
      
    } else if (context === 'purchasing') {
      // Get user's current reservation ticket count (not seat count)
      const userReservationTickets = (context === 'purchasing' && userId) 
        ? await getUserReservationCount(event._id, userId)
        : 0;
      
      // Count active reservations WITHOUT seats (to avoid double counting)
      // These are tickets purchased but seats not yet selected
      let ticketsWithoutSeats = 0;
      
      const Reservation = (await import('../../models/reservationModel.js')).default;
      const reservationsWithoutSeats = await Reservation.aggregate([
        {
          $match: {
            eventId: new mongoose.Types.ObjectId(event._id),
            status: 'active',
            expiresAt: { $gt: new Date() },
            $or: [
              { seatIds: { $exists: false } },
              { seatIds: { $size: 0 } }
            ]
          }
        },
        {
          $unwind: {
            path: '$tickets',
            preserveNullAndEmptyArrays: false
          }
        },
        {
          $group: {
            _id: null,
            totalTicketsWithoutSeats: { $sum: '$tickets.quantity' }
          }
        }
      ]);
      
      ticketsWithoutSeats = reservationsWithoutSeats[0]?.totalTicketsWithoutSeats || 0;
      
      // Tickets/Seats page: include all non-available seats (booked, reserved, not-for-sale, user
      // selections) AND tickets without seats
      const unavailable = bookedSeats + reservedSeats + blockedSeats + selectedSeats + ticketsWithoutSeats;
      const trueAvailable = totalSeats - unavailable;

      capacityData.sold = bookedSeats;
      capacityData.reserved = selectedSeats; // user selections in active reservations
      capacityData.organizerReserved = reservedSeats;
      capacityData.organizerBlocked = blockedSeats;
      capacityData.available = trueAvailable;
      capacityData.remaining = trueAvailable; // Add remaining for frontend consistency
      capacityData.userSelected = userSelectedSeats;
      capacityData.userReservation = userReservationTickets; // Use ticket count from reservation, not seat count
      capacityData.trueAvailable = trueAvailable; // for consistency with non-seated
      
      // User can book up to available seats plus what they already have
      // This matches non-seated event logic
      capacityData.canSelect = trueAvailable + userReservationTickets;
      capacityData.canBook = trueAvailable + userReservationTickets;
      
      // Determine status considering user's context
      if (context === 'purchasing' && userSelectedSeats > 0 && trueAvailable === 0) {
        // User has seats but no additional ones available
        capacityData.status = 'limited';
      } else {
        capacityData.status = trueAvailable === 0 ? 'sold-out' : 'available';
      }
      
      // Additional data for seat selection
      capacityData.seatCounts = {
        available: availableSeats,
        selected: selectedSeats,
        booked: bookedSeats,
        organizerReserved: reservedSeats,
        organizerBlocked: blockedSeats,
        userSelected: userSelectedSeats
      };
    }
    
    return capacityData;
    
  } catch (error) {
    console.error('Error calculating seated event capacity:', error);
    throw error;
  }
};

// @desc    Get current event capacity and availability (v2)
// @route   GET /api/events/:eventId/capacity/v2
// @access  Public
export const getEventCapacityV2 = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { context = 'viewing' } = req.query; // Get context from query params
  const userId = req.user?._id || null; // Will be set by authMiddleware on protected route
  
  
  try {
    // Fetch event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        success: false, 
        message: 'Event not found' 
      });
    }
    
    let capacityData;
    
    // Route to appropriate calculation based on event type
    if (!event.isPaid) {
      // FREE/RSVP events (context doesn't matter much for free events)
      capacityData = await calculateFreeEventCapacity(event);
      // Add context-specific formatting for consistency
      if (context === 'viewing') {
        capacityData.displayText = formatCapacityDisplay(capacityData, 'viewing');
      }
    } else if (event.seatingLayout && event.seatingLayout.length > 0) {
      // PAID events with seats
      capacityData = await calculateSeatedEventCapacity(event, userId, context);
    } else {
      // PAID events without seats
      capacityData = await calculatePaidEventCapacity(event, userId, context);
    }
    
    // Add metadata
    capacityData.lastUpdated = new Date().toISOString();
    capacityData.context = context;

    // Ride the waitlist flag on this LIVE (uncached) response so the event page's "Join the
    // waitlist" decision never depends on the cached slug-page HTML. See featureplans/events-waitlist.md.
    capacityData.waitlistEnabled = !!event.waitlistEnabled;
    capacityData.isAdvertiseOnly = !!event.isAdvertiseOnly;
    
    res.json({
      success: true,
      capacity: capacityData
    });
    
  } catch (error) {
    console.error('❌ Error fetching event capacity v2:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event capacity',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});