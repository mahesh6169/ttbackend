// utils/events/refundHelpers.js - Updated with enhanced logging

import Event from '../../models/eventModel.js';
import PaidTicket from '../../models/paidTicket.js';
import EventInvoice from '../../models/eventInvoice.js';
import RefundRequest from '../../models/refundRequest.js';

/**
 * Validate if user is the organizer of the event
 * @param {String} eventId - Event ID
 * @param {String} organizerId - Organizer ID
 * @returns {Boolean} Whether organizer has access
 */
export const validateOrganizerAccess = async (eventId, organizerId) => {
  try {
    // First try: Check using ticket data (works even if event deleted)
    const ticketCount = await PaidTicket.countDocuments({
      event: eventId,
      'eventSnapshot.postedBy': organizerId.toString()
    });
    
    if (ticketCount > 0) {
      console.log(`🔒 Organizer access GRANTED via tickets: ${ticketCount} tickets found`);
      return true;
    }
    
    // Fallback: Check Event collection (for events with no tickets yet)
    const event = await Event.findById(eventId).select('postedBy');
    if (event && event.postedBy.toString() === organizerId.toString()) {
      console.log('🔒 Organizer access GRANTED via Event document');
      return true;
    }
    
    console.log('🔒 Organizer access DENIED - no tickets or event found');
    return false;
    
  } catch (error) {
    console.error('❌ Error validating organizer access:', error);
    return false;
  }
};

/**
 * Release seats back to available status
 * @param {String} eventId - Event ID
 * @param {Array} ticketSeats - Array of seat objects from ticket
 * @returns {Object} Result with count of seats released
 */
export const releaseSeats = async (eventId, ticketSeats) => {
  try {
    if (!ticketSeats || ticketSeats.length === 0) {
      console.log('🪑 No seats to release');
      return { count: 0 };
    }

    const event = await Event.findById(eventId);
    if (!event || !event.seatingLayout || event.seatingLayout.length === 0) {
      console.log('🪑 No seating layout found');
      return { count: 0 };
    }

    let seatsReleased = 0;

    // Extract seat IDs from ticket
    const seatIdsToRelease = ticketSeats.map(seat => seat.seatId);

    // Find and release seats in the seating layout
    for (const row of event.seatingLayout) {
      for (const seat of row.seats) {
        if (seatIdsToRelease.includes(seat.seatId)) {
          if (seat.status === 'booked') {
            seat.status = 'available';
            seat.reservedBy = null;
            seat.reservedUntil = null;
            seat.sessionId = null;
            seatsReleased++;
          }
        }
      }
    }

    // Save the updated event
    if (seatsReleased > 0) {
      await event.save();
      console.log(`🪑 Released ${seatsReleased} seats`);
    }

    return { count: seatsReleased };

  } catch (error) {
    console.error('❌ Error releasing seats:', error);
    return { count: 0 };
  }
};

/**
 * Capacity restoration is automatic in the new system
 * Changing ticket status to 'refunded' excludes it from count(PaidTickets)
 * This function is kept for compatibility but does nothing
 * @param {String} eventId - Event ID  
 * @param {Object} ticketType - Ticket type object from ticket
 * @returns {Object} Result with restored count
 */
export const restoreTicketCapacity = async (eventId, ticketType) => {
  console.log('📊 Capacity restoration is automatic - ticket status change handles this');
  return { restored: 0, note: 'Automatic via status change' };
};

/**
 * Check for mixed refund scenarios in an invoice
 * @param {String} invoiceNumber - Invoice number to check
 * @param {String} eventId - Event ID
 * @returns {Object} Mixed refund analysis
 */
export const checkMixedRefunds = async (invoiceNumber, eventId) => {
  try {
    // Get all tickets for this invoice
    const allTicketsInInvoice = await PaidTicket.find({
      invoiceNumber,
      event: eventId
    }).select('ticketNumber refundStatus priceDetails.totalPrice checkInStatus');

    const refundedTickets = allTicketsInInvoice.filter(t => t.refundStatus === 'full');
    const activeTickets = allTicketsInInvoice.filter(t => t.refundStatus !== 'full');
    
    // No longer tracking refund types - all refunds are processed individually
    
    const totalOriginalAmount = allTicketsInInvoice.reduce((sum, t) => sum + t.priceDetails.totalPrice, 0);
    const totalRefundedAmount = refundedTickets.reduce((sum, t) => sum + t.priceDetails.totalPrice, 0);
    const remainingRefundableAmount = activeTickets.reduce((sum, t) => sum + t.priceDetails.totalPrice, 0);

    return {
      invoiceNumber,
      totalTickets: allTicketsInInvoice.length,
      refundedTickets: refundedTickets.length,
      activeTickets: activeTickets.length,
      totalOriginalAmount,
      totalRefundedAmount,
      remainingRefundableAmount,
      refundedTicketNumbers: refundedTickets.map(t => t.ticketNumber),
      activeTicketNumbers: activeTickets.map(t => t.ticketNumber)
    };
  } catch (error) {
    console.error('❌ Error checking mixed refunds:', error);
    return {
      invoiceNumber,
      error: error.message,
      canProcessGroupRefund: false
    };
  }
};

/**
 * Validate if tickets can be refunded
 * @param {Array} tickets - Array of ticket documents
 * @returns {Object} Validation result
 */
export const validateRefundEligibility = (tickets) => {
  const eligibleTickets = [];
  const ineligibleTickets = [];

  for (const ticket of tickets) {
    if (ticket.checkInStatus === 'cancelled' || ticket.refundStatus === 'full') {
      ineligibleTickets.push({
        ticketNumber: ticket.ticketNumber,
        reason: 'Already refunded'
      });
    } else if (!['confirmed', 'checked-in'].includes(ticket.status)) {
      ineligibleTickets.push({
        ticketNumber: ticket.ticketNumber,
        reason: 'Invalid status for refund'
      });
    } else if (!ticket.paymentIntentId) {
      ineligibleTickets.push({
        ticketNumber: ticket.ticketNumber,
        reason: 'No payment intent found'
      });
    } else {
      eligibleTickets.push(ticket);
    }
  }

  return {
    isValid: ineligibleTickets.length === 0,
    eligibleTickets,
    ineligibleTickets,
    totalEligible: eligibleTickets.length,
    totalIneligible: ineligibleTickets.length
  };
};

/**
 * Get invoice summary for refund analysis
 * @param {String} invoiceNumber - Invoice number
 * @param {String} eventId - Event ID
 * @returns {Object} Invoice refund summary
 */
export const getInvoiceRefundSummary = async (invoiceNumber, eventId) => {
  try {
    const tickets = await PaidTicket.find({
      invoiceNumber,
      event: eventId
    }).select('ticketNumber refundStatus priceDetails paymentIntentId checkInStatus createdAt');

    if (tickets.length === 0) {
      return {
        found: false,
        message: 'No tickets found for this invoice'
      };
    }

    // Verify payment intent consistency
    const paymentIntents = [...new Set(tickets.map(t => t.paymentIntentId))];
    const hasConsistentPaymentIntent = paymentIntents.length === 1;

    const summary = {
      found: true,
      invoiceNumber,
      totalTickets: tickets.length,
      paymentIntentId: paymentIntents[0],
      hasConsistentPaymentIntent,
      paymentIntents: paymentIntents.length > 1 ? paymentIntents : undefined,
      tickets: tickets.map(t => ({
        ticketNumber: t.ticketNumber,
        status: t.status,
        refundStatus: t.refundStatus,
        amount: t.priceDetails.totalPrice,
        isRefundable: ['confirmed', 'checked-in'].includes(t.checkInStatus) && t.refundStatus !== 'full'
      })),
      totalAmount: tickets.reduce((sum, t) => sum + t.priceDetails.totalPrice, 0),
      refundedAmount: tickets
        .filter(t => t.refundStatus === 'full')
        .reduce((sum, t) => sum + t.priceDetails.totalPrice, 0),
      refundableAmount: tickets
        .filter(t => ['confirmed', 'checked-in'].includes(t.checkInStatus) && t.refundStatus !== 'full')
        .reduce((sum, t) => sum + t.priceDetails.totalPrice, 0),
      refundableTickets: tickets.filter(t => 
        ['confirmed', 'checked-in'].includes(t.checkInStatus) && t.refundStatus !== 'full'
      ).length,
      canProcessGroupRefund: tickets.every(t => t.refundStatus !== 'full') && 
                            tickets.every(t => ['confirmed', 'checked-in'].includes(t.status)) &&
                            hasConsistentPaymentIntent
    };

    return summary;
  } catch (error) {
    console.error('❌ Error getting invoice refund summary:', error);
    return {
      found: false,
      error: error.message
    };
  }
};

/**
 * Calculate invoice status based on tickets refunded vs tickets purchased
 * @param {Object} invoice - EventInvoice document
 * @returns {String} - 'paid', 'partially_refunded', or 'fully_refunded'
 */
export const calculateInvoiceStatus = (invoice) => {
  // Get total invoice amount and total refunded
  const totalInvoiceAmount = invoice.amounts.total;
  const totalRefundedAmount = invoice.amounts.totalRefunded;
  
  // Determine status based on amounts (not ticket count)
  if (totalRefundedAmount === 0) {
    return 'paid';
  } else if (totalRefundedAmount >= totalInvoiceAmount) {
    return 'fully_refunded';  // ✅ Full amount has been refunded
  } else {
    return 'partially_refunded';  // Some amount still not refunded
  }
};

/**
 * Update EventInvoice with refund data
 * @param {String} invoiceNumber - Invoice number to update
 * @param {Object} refundData - Refund information
 * @returns {Object} Updated invoice or error
 */
export const updateInvoiceWithRefund = async (invoiceNumber, refundData) => {
  try {
    // Find the invoice
    const invoice = await EventInvoice.findOne({ invoiceNumber });
    
    if (!invoice) {
      console.error(`❌ Invoice not found: ${invoiceNumber}`);
      return { success: false, error: 'Invoice not found' };
    }
    
    // Add refund entry to array
const refundEntry = {
  ticketNumber: refundData.ticketNumber,
  refundAmount: refundData.refundAmount,
  refundDate: new Date(),
  stripeRefundId: refundData.stripeRefundId,
  reason: refundData.reason,
  processedBy: refundData.processedBy
};

invoice.refunds.push(refundEntry);
    
    // Update financial totals
    invoice.amounts.totalRefunded += refundData.refundAmount;
    invoice.amounts.netAmount = invoice.amounts.total - invoice.amounts.totalRefunded;
    
    // Calculate status based on tickets (not money)
    invoice.status = calculateInvoiceStatus(invoice);
    
    // Save the invoice
    await invoice.save();
    
    console.log(`✅ Invoice ${invoiceNumber} updated with refund for ticket ${refundData.ticketNumber}`);
    console.log(`📊 Invoice status: ${invoice.status} (${invoice.refunds.length} refunds total)`);
    
    return { success: true, invoice };
    
  } catch (error) {
    console.error('❌ Error updating invoice with refund:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Log refund activity for audit purposes
 * @param {Object} refundData - Refund information
 */
export const logRefundActivity = (refundData) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: refundData.type, // 'individual' or 'group'
    eventId: refundData.eventId,
    organizerId: refundData.organizerId,
    ticketNumbers: refundData.ticketNumbers,
    invoiceNumber: refundData.invoiceNumber,
    totalAmount: refundData.totalAmount,
    reason: refundData.reason,
    stripeRefundIds: refundData.stripeRefundIds,
    seatsReleased: refundData.seatsReleased,
    capacityRestored: refundData.capacityRestored,
    // Enhanced logging for new architecture
    refundMethod: refundData.type === 'group' ? 'FULL_TRANSACTION' : 'PARTIAL_TRANSACTION',
    paymentIntentId: refundData.paymentIntentId
  };

  console.log(`🔍 REFUND AUDIT: ${JSON.stringify(logEntry)}`);
  
  // You could also write this to a database table for persistent audit logs
  // await AuditLog.create(logEntry);
};

// ============================================================================
// NEW REFUND FLOW HELPERS (Phase 2)
// ============================================================================

/**
 * Generate unique refund request ID.
 * Format: REF-<CODE>-NNNN (4-digit minimum, no cap) e.g. REF-AZAMW-0001 — per-event sequence, mirrors
 * invoice numbers. Uses the same atomic per-event counter (EventIdCounter) so it never collides and has
 * no width ceiling. See designGuides/events-refactor/feature-stable-id-counter.md.
 * @param {String} eventCode - the event code (e.g. EVT-AZAMW); the EVT- prefix is stripped for the id.
 * @returns {Promise<String>} Unique refund request ID
 */
export const generateRefundRequestId = async (eventCode) => {
  // Strip the EVT- prefix the same way generateInvoiceNumber does: EVT-AZAMW -> AZAMW.
  const codepart = (eventCode || '').replace('EVT-', '');

  const EventIdCounter = (await import('../../models/eventIdCounter.js')).default;
  const seq = await EventIdCounter.next(eventCode, 'refund');

  const numStr = seq.toString().padStart(4, '0');
  return `REF-${codepart}-${numStr}`;
};

/**
 * Check if any ticket already has pending refund
 * Returns existing RefundRequest or null
 * @param {Array<String>} ticketNumbers - Array of ticket numbers
 * @returns {Promise<Object|null>} Existing RefundRequest or null
 */
export const checkConcurrentRefund = async (ticketNumbers) => {
  const existingRefund = await RefundRequest.findOne({
    ticketNumbers: { $in: ticketNumbers },
    status: { $in: ['pending', 'processing_stripe'] }
  });
  
  return existingRefund;
};

/**
 * Check if tickets are within 180-day refund limit
 * @param {Array} tickets - Array of ticket documents
 * @returns {Object|null} Error object if too old, null if valid
 */
export const check180DayLimit = (tickets) => {
  const today = new Date();
  const maxDays = 180;
  
  for (const ticket of tickets) {
    if (!ticket.paymentDate) {
      continue; // Skip if no payment date
    }
    
    const paymentDate = new Date(ticket.paymentDate);
    const daysSincePayment = Math.floor((today - paymentDate) / (1000 * 60 * 60 * 24));
    
    if (daysSincePayment > maxDays) {
      return {
        ticketNumber: ticket.ticketNumber,
        days: daysSincePayment,
        message: `Ticket ${ticket.ticketNumber} was purchased ${daysSincePayment} days ago`
      };
    }
  }
  
  return null; // All tickets are within limit
};

/**
 * Prepare refund success data (don't execute yet)
 * Builds data structure for what SHOULD change after Stripe succeeds
 * @param {Array} tickets - Array of ticket documents
 * @param {Object} event - Event document (optional - may be null if deleted)
 * @returns {Object} refundSuccessData object
 */
export const prepareRefundSuccessData = (tickets, event, refundAmounts = null) => {
  const ticketsToUpdate = [];
  const seatsToRelease = [];

  for (const ticket of tickets) {
    // A refund is FULL only when this refund clears the whole ticket price. A partial refund keeps
    // the attendee's spot (they still come), so it must NOT cancel the ticket or release its seat.
    const alreadyRefunded = ticket.totalRefundedAmount || 0;
    const thisAmount = refundAmounts && refundAmounts.get(ticket.ticketNumber) != null
      ? refundAmounts.get(ticket.ticketNumber)
      : (ticket.priceDetails.totalPrice - alreadyRefunded); // no map (legacy caller) = treat as full
    const isFull = (alreadyRefunded + thisAmount) >= ticket.priceDetails.totalPrice - 0.01;

    // Ticket update record (newStatus is informational for validation; the apply step re-derives it).
    ticketsToUpdate.push({
      ticketNumber: ticket.ticketNumber,
      currentStatus: ticket.checkInStatus,
      newStatus: isFull ? 'cancelled' : ticket.checkInStatus
    });

    // Add seat release only for a FULL refund of a seated, not-already-cancelled ticket. A partial
    // refund leaves the seat booked so the still-attending buyer keeps it.
    if (isFull && event && event.seatingLayout && ticket.seats && ticket.seats.length > 0 && ticket.checkInStatus !== 'cancelled') {
      const ticketSeats = [];
      
      for (const seat of ticket.seats) {
        // Find seat in event.seatingLayout
        let foundSeat = null;
        
        for (const row of event.seatingLayout || []) {
          const eventSeat = row.seats.find(s => s.seatId === seat.seatId);
          if (eventSeat) {
            foundSeat = eventSeat;
            break;
          }
        }
        
        if (!foundSeat) {
          // Seat not found in seatingLayout - skip this seat (don't throw error)
          console.warn(`⚠️  Seat ${seat.seatId} not found in event seating layout - skipping seat release`);
          continue;
        }
        
        ticketSeats.push({
          seatId: seat.seatId,
          row: seat.row,
          seatNumber: seat.seatNumber,
          currentStatus: foundSeat.status,
          newStatus: 'available'
        });
      }
      
      if (ticketSeats.length > 0) {
        seatsToRelease.push({
          ticketNumber: ticket.ticketNumber,
          seats: ticketSeats
        });
      }
    }
  }
  
  return {
    ticketsToUpdate,
    seatsToRelease
  };
};

/**
 * Validate refund success data before Stripe call
 * @param {Object} refundSuccessData - Prepared refund data
 * @param {Object} event - Event document (optional - may be null if deleted)
 * @returns {String|null} Error message if validation fails, null if valid
 */
export const validateRefundSuccessData = async (refundSuccessData, event) => {
  // Validate tickets
  for (const ticketUpdate of refundSuccessData.ticketsToUpdate) {
    const ticket = await PaidTicket.findOne({ ticketNumber: ticketUpdate.ticketNumber });
    
    if (!ticket) {
      return `Ticket ${ticketUpdate.ticketNumber} not found`;
    }
    
    if (ticket.checkInStatus !== ticketUpdate.currentStatus) {
      return `Ticket ${ticketUpdate.ticketNumber} status changed (expected ${ticketUpdate.currentStatus}, got ${ticket.checkInStatus})`;
    }
    
    if (ticket.refundStatus === 'full') {
      return `Ticket ${ticketUpdate.ticketNumber} is already fully refunded`;
    }
  }
  
  // Validate seats (only if event exists)
  if (event && event.seatingLayout) {
    for (const seatRelease of refundSuccessData.seatsToRelease) {
      for (const seat of seatRelease.seats) {
        // Find seat in event
        let foundSeat = null;
        
        for (const row of event.seatingLayout || []) {
          const eventSeat = row.seats.find(s => s.seatId === seat.seatId);
          if (eventSeat) {
            foundSeat = eventSeat;
            break;
          }
        }
        
        if (!foundSeat) {
          return `Seat ${seat.seatId} not found in event`;
        }
        
        if (foundSeat.status !== 'booked') {
          return `Seat ${seat.seatId} is not booked (current status: ${foundSeat.status})`;
        }
      }
    }
  }
  
  return null; // Valid
};

/**
 * Apply refund success data after Stripe succeeds
 * Executes the prepared changes
 * @param {Object} refundSuccessData - Prepared refund data (may be null for past events)
 * @param {Object} refundRequest - RefundRequest document
 * @param {Array} tickets - Array of ticket documents
 * @param {Object} invoice - Invoice document
 * @param {String} userId - User ID who processed refund
 * @returns {Promise<Object>} Result object
 */
export const applyRefundSuccessData = async (refundSuccessData, refundRequest, tickets, invoice, userId) => {
  try {
    // Part A: Release seats (if any and if event exists)
    if (refundSuccessData && refundSuccessData.seatsToRelease && refundSuccessData.seatsToRelease.length > 0) {
      const event = await Event.findById(refundRequest.eventId);
      
      if (!event) {
        console.log('⚠️  Event document deleted - skipping seat release (no seatingLayout available)');
        // Don't throw error - this is expected for deleted events
      } else {
      
      for (const seatRelease of refundSuccessData.seatsToRelease) {
        for (const seat of seatRelease.seats) {
          // Find and update seat in event
          for (const row of event.seatingLayout) {
            const eventSeat = row.seats.find(s => s.seatId === seat.seatId);
            if (eventSeat) {
              eventSeat.status = 'available';
              eventSeat.reservedBy = null;
              eventSeat.reservedUntil = null;
              eventSeat.sessionId = null;
            }
          }
        }
      }
      
        await event.save();
        console.log(`🪑 Released ${refundSuccessData.seatsToRelease.reduce((sum, item) => sum + item.seats.length, 0)} seats`);
      }
    }
    
    // Part B: Update tickets
    for (const ticket of tickets) {
      const refundAmount = refundRequest.refundAmounts.get(ticket.ticketNumber);

      ticket.totalRefundedAmount = (ticket.totalRefundedAmount || 0) + refundAmount;
      ticket.stripeRefundId = refundRequest.stripeRefundId;
      ticket.refundedAt = new Date();
      ticket.refundedBy = userId;

      // Calculate refund status with epsilon for floating point
      const totalPrice = ticket.priceDetails.totalPrice;
      const epsilon = 0.01;

      if (ticket.totalRefundedAmount >= totalPrice - epsilon) {
        ticket.refundStatus = 'full';
        // A FULL refund cancels the ticket: it stops consuming capacity (the sold-count excludes
        // 'cancelled'), the door refuses it, and its seat is released in Part A above.
        ticket.checkInStatus = 'cancelled';
      } else {
        ticket.refundStatus = 'partial';
        // A PARTIAL refund keeps the ticket active: the attendee still attends, so the spot stays
        // occupied, the door still admits them, and the remainder can still be refunded later.
      }

      await ticket.save();
      console.log(`🎫 Updated ticket ${ticket.ticketNumber}: refundStatus=${ticket.refundStatus}, checkInStatus=${ticket.checkInStatus}`);
    }
    
    // Part C: Update invoice
    for (const ticket of tickets) {
      const refundAmount = refundRequest.refundAmounts.get(ticket.ticketNumber);
      
      invoice.refunds.push({
        ticketNumber: ticket.ticketNumber,
        refundRequestId: refundRequest.refundRequestId,
        refundAmount: refundAmount,
        refundDate: new Date(),
        stripeRefundId: refundRequest.stripeRefundId,
        reason: refundRequest.reason,
        processedBy: userId
      });
    }
    
    // Update invoice totals
    invoice.amounts.totalRefunded = (invoice.amounts.totalRefunded || 0) + refundRequest.totalAmount;
    invoice.amounts.netAmount = invoice.amounts.total - invoice.amounts.totalRefunded;
    
    // Update invoice status
    invoice.status = calculateInvoiceStatus(invoice);
    
    await invoice.save();
    console.log(`📄 Updated invoice ${invoice.invoiceNumber}: status=${invoice.status}`);
    
    return { success: true };
    
  } catch (error) {
    console.error('❌ Error applying refund success data:', error);
    throw error;
  }
};