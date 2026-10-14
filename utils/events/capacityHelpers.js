// utils/events/capacityHelpers.js

import mongoose from 'mongoose';

/**
 * Count active reservations for an event
 * @param {String} eventId - Event ID
 * @param {Object} options - Options for counting
 * @param {String} options.excludeUserId - User ID to exclude from count
 * @param {Number} options.bufferSeconds - Buffer time before expiry (default 0)
 * @returns {Object} { count: number, totalTickets: number }
 */
export async function countActiveReservations(eventId, options = {}) {
  const {
    excludeUserId = null,
    bufferSeconds = 0  // Default to no buffer
  } = options;
  
  try {
    // Dynamic import to avoid circular dependencies
    const Reservation = (await import('../../models/reservationModel.js')).default;
    
    // Calculate buffer time
    const bufferTime = new Date(Date.now() + (bufferSeconds * 1000));
    
    // Build match criteria
    const matchCriteria = {
      eventId: new mongoose.Types.ObjectId(eventId),
      status: 'active',
      expiresAt: { $gt: bufferTime },
      tickets: { $exists: true, $ne: [] }
    };
    
    // Exclude specific user if provided
    if (excludeUserId) {
      matchCriteria.userId = { $ne: new mongoose.Types.ObjectId(excludeUserId) };
    }
    
    // Aggregation pipeline to count tickets
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
          totalReserved: { $sum: '$tickets.quantity' },
          reservationCount: { $addToSet: '$_id' }
        }
      },
      {
        $project: {
          totalReserved: 1,
          reservationCount: { $size: '$reservationCount' }
        }
      }
    ];
    
    const result = await Reservation.aggregate(pipeline);
    
    return {
      count: result[0]?.reservationCount || 0,
      totalTickets: result[0]?.totalReserved || 0
    };
    
  } catch (error) {
    console.error('Error counting active reservations:', error);
    throw error;
  }
}

/**
 * Get user's current reservation quantity for an event
 * @param {String} eventId - Event ID
 * @param {String} userId - User ID
 * @returns {Number} Total quantity in user's reservation
 */
export async function getUserReservationCount(eventId, userId) {
  if (!userId) return 0;
  
  try {
    const Reservation = (await import('../../models/reservationModel.js')).default;
    
    const reservation = await Reservation.findOne({
      eventId: new mongoose.Types.ObjectId(eventId),
      userId: new mongoose.Types.ObjectId(userId),
      status: 'active',
      expiresAt: { $gt: new Date() }
    });
    
    if (!reservation || !reservation.tickets) return 0;
    
    return reservation.tickets.reduce((sum, ticket) => sum + ticket.quantity, 0);
    
  } catch (error) {
    console.error('Error getting user reservation count:', error);
    return 0;
  }
}

/**
 * Format capacity display text based on context
 * @param {Object} capacity - Capacity data
 * @param {String} context - Display context ('viewing' | 'purchasing')
 * @returns {String} Formatted display text
 */
export function formatCapacityDisplay(capacity, context = 'viewing') {
  if (context === 'viewing') {
    if (capacity.isUnlimited) {
      return 'Unlimited capacity';
    }
    if (capacity.status === 'sold-out') {
      return 'Sold out';
    }
    // For all events in viewing context, show available count
    // Use the pre-calculated available count which properly accounts for organizer reserved seats
    const available = capacity.available !== undefined ? capacity.available : (capacity.total - capacity.sold);
    return `${available} of ${capacity.total} spots left`;
  }
  
  // Purchasing context
  if (capacity.available === 0) {
    return 'No spots available';
  }
  if (capacity.available < 5 && capacity.available > 0) {
    return `Only ${capacity.available} spots remaining!`;
  }
  return `${capacity.available} spots available`;
}

/**
 * Generate validation message for quantity selection
 * @param {Number} requested - Requested quantity
 * @param {Object} availability - Availability data
 * @returns {String|null} Error message or null if valid
 */
export function generateValidationMessage(requested, availability) {
  if (availability.available === 0 && availability.userReservation === 0) {
    return "Sorry, this event just sold out! The last spots were taken moments ago.";
  }
  
  if (availability.available === 0 && availability.userReservation > 0) {
    return `You already have ${availability.userReservation} tickets reserved. No additional spots available.`;
  }
  
  if (requested > availability.canBook) {
    if (availability.userReservation > 0) {
      return `You have ${availability.userReservation} tickets reserved. Only ${availability.available} additional spots available.`;
    }
    return `Only ${availability.available} spots remaining. Please reduce your selection.`;
  }
  
  return null; // Valid
}

/**
 * Determine availability status
 * @param {Number} available - Available spots
 * @param {Number} total - Total capacity
 * @returns {String} Status: 'available' | 'limited' | 'sold-out'
 */
export function getAvailabilityStatus(available, total) {
  if (available === 0) return 'sold-out';
  if (total > 0 && available < total * 0.1) return 'limited'; // Less than 10%
  return 'available';
}