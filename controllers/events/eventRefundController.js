import PaidTicket from '../../models/paidTicket.js';
import EventInvoice from '../../models/eventInvoice.js';
import Event from '../../models/eventModel.js';
import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import stripe from '../../config/stripe.js';
import { 
  logRefundActivity, 
  updateInvoiceWithRefund,
  generateRefundRequestId,
  checkConcurrentRefund,
  check180DayLimit,
  prepareRefundSuccessData,
  validateRefundSuccessData,
  applyRefundSuccessData
} from '../../utils/events/refundHelpers.js';
import RefundRequest from '../../models/refundRequest.js';
import { releaseSeatsForTicket } from '../../utils/events/seatHelpers.js';
import { sendRefundConfirmationToBuyer } from '../../utils/notifications/events/sendRefundNotifications.js';


// @desc    Get organizer's paid events for refund management (matches route: GET /api/events/refunds/my-events)
// @route   GET /api/events/refunds/my-events
// @access  Private (Organizer only)
export const getRefundableEvents = asyncHandler(async (req, res) => {
  const organizerId = req.user._id;

  try {
    // Get all unique events from PaidTickets grouped by eventCode
    const eventGroups = await PaidTicket.aggregate([
      {
        $match: {
          'eventSnapshot.postedBy': organizerId.toString(),
          'eventSnapshot.isPaid': true
        }
      },
      {
        $group: {
          _id: '$eventSnapshot.eventCode', // Group by eventCode for uniqueness
          event: { $first: '$event' }, // Original event ID
          eventSnapshot: { $last: '$eventSnapshot' }, // Use latest ticket's snapshot to get most recent event details
          firstTicketCreatedAt: { $min: '$createdAt' }, // Earliest ticket creation
          invoiceNumbers: { $addToSet: '$invoiceNumber' }, // Distinct invoices for count
          totalTickets: { $sum: 1 },
          totalRevenue: { $sum: '$priceDetails.totalPrice' },
          refundedTickets: {
            $sum: {
              $cond: [
                { $eq: ['$refundStatus', 'full'] },
                1,
                0
              ]
            }
          },
          partiallyRefundedTickets: {
            $sum: {
              $cond: [
                { $eq: ['$refundStatus', 'partial'] },
                1,
                0
              ]
            }
          },
          refundedAmount: {
            $sum: '$totalRefundedAmount'
          },
          cancelledTickets: {
            $sum: {
              $cond: [
                { $eq: ['$checkInStatus', 'cancelled'] },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: '$event', // Use original event ID as _id
          eventCode: '$_id', // The grouped eventCode
          title: '$eventSnapshot.title',
          dateTime: '$eventSnapshot.dateTime',
          venue: '$eventSnapshot.venue',
          capacity: '$eventSnapshot.capacity',
          isPaid: '$eventSnapshot.isPaid',
          status: '$eventSnapshot.status',
          category: '$eventSnapshot.category',
          timeZone: '$eventSnapshot.timeZone',
          address: '$eventSnapshot.address',
          createdAt: '$firstTicketCreatedAt',
          isDeleted: { $literal: false }, // Static value for frontend compatibility
          stats: {
            totalTickets: '$totalTickets',
            totalInvoices: { $size: '$invoiceNumbers' },
            totalRevenue: '$totalRevenue',
            refundedTickets: '$refundedTickets',
            partiallyRefundedTickets: '$partiallyRefundedTickets',
            refundedAmount: '$refundedAmount',
            cancelledTickets: '$cancelledTickets'
          }
        }
      },
      {
        $sort: { createdAt: -1 } // Sort by creation date (newest first)
      }
    ]);

    res.status(200).json({
      success: true,
      count: eventGroups.length,
      events: eventGroups
    });

  } catch (error) {
    console.error('❌ Error fetching refundable events:', error);
    console.error('❌ Full error details:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});


// @desc    Get refundable tickets for an event (matches route: GET /api/events/:eventId/refunds/eligible)
// @route   GET /api/events/:eventId/refunds/eligible
// @access  Private (Organizer only)
export const getRefundableTickets = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { page = 1, limit = 20, search = '', searchType = 'all' } = req.query;
  const organizerId = req.user._id;

  // Pagination is by whole invoice groups (not individual tickets)
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  try {
    // First get a sample ticket to verify organizer access
    // This approach works even if the Event document is deleted
    const sampleTicket = await PaidTicket.findOne({ event: eventId })
      .select('eventSnapshot');
    
    if (!sampleTicket) {
      // No tickets exist - verify organizer access through Event collection
      const event = await Event.findById(eventId).select('postedBy');
      
      if (!event || event.postedBy.toString() !== organizerId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Only event organizers can manage refunds.'
        });
      }
      
      // Return empty tickets array with proper pagination
      return res.status(200).json({
        success: true,
        tickets: [],
        count: 0,
        pagination: {
          currentPage: pageNum,
          totalPages: 0,
          totalInvoices: 0,
          hasMore: false
        }
      });
    }

    // 🔒 SECURITY: Check if user is the organizer using eventSnapshot
    if (sampleTicket.eventSnapshot.postedBy !== organizerId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only event organizers can manage refunds.'
      });
    }

    // No need for additional checks - organizer already verified via eventSnapshot

    // Build the search match. It is applied AFTER grouping by invoice so an
    // invoice is kept whole whenever ANY of its tickets matches. Post-group,
    // the invoice number is `_id` and ticket fields live in the `tickets` array
    // (a regex on `tickets.<field>` matches if any element matches).
    let searchMatch = null;
    if (search && search.trim()) {
      const term = search.trim();
      const rx = { $regex: term, $options: 'i' };
      const rxOf = (s) => ({ $regex: s, $options: 'i' });

      // Match a (possibly multi-word) buyer name: every word must appear in the
      // first OR last name, so "Bob Demo" matches firstName="Bob" + lastName="Demo".
      const nameMatch = {
        $and: term.split(/\s+/).map((word) => ({
          $or: [
            { 'tickets.buyer.firstName': rxOf(word) },
            { 'tickets.buyer.lastName': rxOf(word) }
          ]
        }))
      };

      if (searchType === 'ticketNumber') {
        searchMatch = { 'tickets.ticketNumber': rx };
      } else if (searchType === 'invoiceNumber') {
        searchMatch = { _id: rx };
      } else if (searchType === 'buyerName') {
        searchMatch = nameMatch;
      } else if (searchType === 'buyerEmail') {
        searchMatch = { 'tickets.buyer.email': rx };
      } else {
        // Search across all fields
        searchMatch = {
          $or: [
            { 'tickets.ticketNumber': rx },
            { _id: rx },
            { 'tickets.buyer.email': rx },
            nameMatch
          ]
        };
      }
    }

    // Fields carried per ticket (mirrors the previous .select()).
    const ticketFields = {
      ticketNumber: 1, invoiceNumber: 1, priceDetails: 1, checkInStatus: 1,
      refundStatus: 1, totalRefundedAmount: 1, buyer: 1, seats: 1, ticketType: 1,
      pack: 1, // pack tag so the refund screen can label a pack ("$50, admits N")
      createdAt: 1, eventSnapshot: 1, paymentIntentId: 1, attendees: 1,
      stripeRefundId: 1, refundedAt: 1, refundedBy: 1,
    };

    // Group by invoice, then paginate the invoice groups (never split an
    // invoice across pages). $facet returns the page of groups + a total count.
    const pipeline = [
      { $match: { event: eventId } }, // `event` is stored as a String (see model)
      { $sort: { createdAt: -1 } },
      { $project: ticketFields },
      {
        $group: {
          _id: '$invoiceNumber',
          tickets: { $push: '$$ROOT' },
          sortKey: { $first: '$createdAt' } // newest ticket in the invoice
        }
      },
      ...(searchMatch ? [{ $match: searchMatch }] : []),
      { $sort: { sortKey: -1 } },
      {
        $facet: {
          metadata: [{ $count: 'totalInvoices' }],
          data: [{ $skip: skip }, { $limit: limitNum }]
        }
      }
    ];

    const [result] = await PaidTicket.aggregate(pipeline);
    const totalInvoices = result?.metadata?.[0]?.totalInvoices || 0;
    const totalPages = Math.ceil(totalInvoices / limitNum);
    // Flatten the paged invoice groups back into a ticket list (already ordered
    // invoice-by-invoice); the frontend regroups them for display.
    const tickets = (result?.data || []).flatMap(group => group.tickets);

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalInvoices,
        hasMore: pageNum < totalPages
      },
    });

  } catch (error) {
    console.error('❌ Error fetching refundable tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch refundable tickets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Process refund with new 7-step flow
// @route   POST /api/events/:eventId/refunds/process
// @access  Private (Organizer only)
export const processRefund = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { tickets, reason } = req.body;
  const organizerId = req.user._id;
  const organizerName = req.user.name;

  // Basic validation
  if (!tickets || !Array.isArray(tickets) || tickets.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Please select at least one ticket to refund'
    });
  }

  const ticketNumbers = tickets.map(t => t.ticketNumber);

  try {
    // ========== STEP 1: Create RefundRequest ==========
    console.log('📋 STEP 1: Creating RefundRequest...');

    // Fetch tickets (use eventSnapshot as source of truth)
    const dbTickets = await PaidTicket.find({
      ticketNumber: { $in: ticketNumbers },
      event: eventId
    });
    
    // Optionally fetch Event document (may not exist if organizer deleted it)
    const event = await Event.findById(eventId);
    
    if (!dbTickets || dbTickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No valid tickets found'
      });
    }
    
    // Verify organizer access using eventSnapshot (works even if Event deleted)
    if (dbTickets[0].eventSnapshot?.postedBy !== organizerId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only process refunds for your own events.'
      });
    }
    
    // Use eventSnapshot as source of truth for event data
    const eventSnapshot = dbTickets[0].eventSnapshot;
    
    // Build refund amounts map
    const refundAmountMap = new Map();
    let totalAmount = 0;
    
    for (const ticket of dbTickets) {
      const requestedTicket = tickets.find(t => t.ticketNumber === ticket.ticketNumber);
      let refundAmount = requestedTicket?.amount;
      
      console.log(`🔍 [${ticket.ticketNumber}] Received amount from frontend:`, refundAmount, typeof refundAmount);
      
      // Calculate max refundable first
      const maxRefundable = ticket.priceDetails.totalPrice - (ticket.totalRefundedAmount || 0);
      console.log(`🔍 [${ticket.ticketNumber}] Max refundable:`, maxRefundable);
      
      if (refundAmount === undefined || refundAmount === null) {
        // If no amount specified, use max refundable
        console.log(`🔍 [${ticket.ticketNumber}] No amount specified, using max refundable`);
        refundAmount = maxRefundable;
      }
      
      console.log(`🔍 [${ticket.ticketNumber}] Before rounding:`, refundAmount);
      
      // Round to 2 decimal places
      refundAmount = Math.round(refundAmount * 100) / 100;
      
      console.log(`🔍 [${ticket.ticketNumber}] After rounding:`, refundAmount);
      
      // Validate: Must be positive and within max
      if (isNaN(refundAmount) || refundAmount <= 0 || refundAmount > maxRefundable) {
        console.log(`❌ [${ticket.ticketNumber}] VALIDATION FAILED - isNaN:`, isNaN(refundAmount), 'isZeroOrNeg:', refundAmount <= 0, 'exceedsMax:', refundAmount > maxRefundable);
        return res.status(400).json({
          success: false,
          message: `Invalid refund amount $${refundAmount} for ticket ${ticket.ticketNumber}. Must be between $0.01 and $${maxRefundable.toFixed(2)} AUD`
        });
      }
      
      console.log(`✅ [${ticket.ticketNumber}] Validation passed, adding to map:`, refundAmount);
      refundAmountMap.set(ticket.ticketNumber, refundAmount);
      totalAmount += refundAmount;
    }
    
    if (totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Refund amount must be greater than $0. Please enter a valid amount for the selected tickets.'
      });
    }
    
    // Get invoice number
    const invoiceNumbers = [...new Set(dbTickets.map(t => t.invoiceNumber))];
    const invoiceNumber = invoiceNumbers[0]; // Should all be same

    // Generate the refund id now that we know the event (read the code off the ticket snapshot,
    // which exists even if the Event was deleted). Per-event sequence: REF-<CODE>-NNNN.
    const refundRequestId = await generateRefundRequestId(eventSnapshot.eventCode);

    // Create RefundRequest using eventSnapshot
    const refundRequest = new RefundRequest({
      refundRequestId,
      eventId: eventId.toString(),
      eventSnapshot: {
        eventCode: eventSnapshot.eventCode,
        title: eventSnapshot.title,
        dateTime: eventSnapshot.dateTime,
        timeZone: eventSnapshot.timeZone,
        venue: eventSnapshot.venue,
        address: eventSnapshot.address || '',
        organizer: {
          name: eventSnapshot.organizer?.name || '',
          email: eventSnapshot.organizer?.email || '',
          abn: eventSnapshot.organizer?.abn || ''
        }
      },
      ticketNumbers,
      invoiceNumber,
      refundAmounts: Object.fromEntries(refundAmountMap),
      totalAmount,
      status: 'pending',
      requestedBy: organizerId,
      requestedByName: organizerName,
      reason: reason || '',
      refundSuccessData: null,
      attempts: 0
    });
    
    await refundRequest.save();
    console.log(`✅ RefundRequest created: ${refundRequestId}`);
    
    // ========== STEP 2: Check Concurrent Refunds ==========
    console.log('🔒 STEP 2: Checking concurrent refunds...');
    
    const existingRefund = await checkConcurrentRefund(ticketNumbers);
    
    if (existingRefund && existingRefund._id.toString() !== refundRequest._id.toString()) {
      refundRequest.status = 'failed';
      refundRequest.errorMessage = `Refund already in progress: ${existingRefund.refundRequestId}`;
      await refundRequest.save();
      
      return res.status(409).json({
        success: false,
        message: 'Refund already in progress for one or more tickets',
        refundRequestId: existingRefund.refundRequestId
      });
    }
    
    console.log('✅ No concurrent refunds found');
    
    // ========== STEP 3: Check 180-Day Limit ==========
    console.log('📅 STEP 3: Checking 180-day limit...');
    
    const ageCheck = check180DayLimit(dbTickets);
    
    if (ageCheck) {
      refundRequest.status = 'failed';
      refundRequest.errorMessage = `Ticket too old: ${ageCheck.message}`;
      await refundRequest.save();
      
      return res.status(400).json({
        success: false,
        message: `This ticket is too old to refund (purchased ${ageCheck.days} days ago). Stripe only allows refunds within 180 days.`,
        refundRequestId: refundRequest.refundRequestId
      });
    }
    
    console.log('✅ All tickets within 180-day limit');
    
    // ========== STEP 4: Prepare Refund Success Data ==========
    console.log('📝 STEP 4: Preparing refund success data...');
    
    // Check if event already happened using eventSnapshot
    const today = new Date();
    const eventDate = new Date(eventSnapshot.dateTime);
    
    if (today > eventDate) {
      console.log('⏰ Event already happened, skipping seat/ticket operations (purely financial refund)');
    } else if (!event) {
      console.log('⏰ Event document deleted, skipping seat operations (no seatingLayout available)');
    } else {
      console.log('⏰ Event is upcoming and Event document exists, preparing seat release');
      
      try {
        // Pass the per-ticket amounts so a partial refund does not release the seat (full only).
        const refundSuccessData = prepareRefundSuccessData(dbTickets, event, refundAmountMap);
        
        // Validate prepared data
        const validationError = await validateRefundSuccessData(refundSuccessData, event);
        
        if (validationError) {
          refundRequest.status = 'failed';
          refundRequest.errorMessage = `Validation failed: ${validationError}`;
          await refundRequest.save();
          
          return res.status(400).json({
            success: false,
            message: validationError,
            refundRequestId: refundRequest.refundRequestId
          });
        }
        
        // Save prepared data
        refundRequest.refundSuccessData = refundSuccessData;
        refundRequest.seatsReleased = refundSuccessData.seatsToRelease.reduce((sum, item) => sum + item.seats.length, 0);
        await refundRequest.save();
        
        console.log(`✅ Prepared data for ${refundSuccessData.ticketsToUpdate.length} tickets, ${refundRequest.seatsReleased} seats`);
        
      } catch (prepError) {
        refundRequest.status = 'failed';
        refundRequest.errorMessage = `Preparation failed: ${prepError.message}`;
        await refundRequest.save();
        
        return res.status(500).json({
          success: false,
          message: 'Could not prepare refund data',
          error: prepError.message,
          refundRequestId: refundRequest.refundRequestId
        });
      }
    }
    
    // ========== STEP 5: Process Stripe Refund ==========
    console.log('💳 STEP 5: Processing Stripe refund...');
    
    refundRequest.status = 'processing_stripe';
    await refundRequest.save();
    
    try {
      // Group tickets by paymentIntentId
      const paymentIntentGroups = {};
      dbTickets.forEach(ticket => {
        const pid = ticket.paymentIntentId;
        if (!paymentIntentGroups[pid]) {
          paymentIntentGroups[pid] = [];
        }
        paymentIntentGroups[pid].push(ticket);
      });
      
      let stripeRefundId = null;
      
      for (const [paymentIntentId, ticketGroup] of Object.entries(paymentIntentGroups)) {
        const groupRefundAmount = ticketGroup.reduce((sum, ticket) => {
          return sum + (refundAmountMap.get(ticket.ticketNumber) || 0);
        }, 0);
        
        // Call Stripe
        const stripeRefund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: Math.round(groupRefundAmount * 100), // Convert to cents
          reason: 'requested_by_customer',
          metadata: {
            eventId: eventId,
            refundRequestId: refundRequest.refundRequestId,
            ticketNumbers: ticketGroup.map(t => t.ticketNumber).join(',')
          }
        }, {
          stripeAccount: ticketGroup[0].stripeAccountId
        });
        
        stripeRefundId = stripeRefund.id;
        refundRequest.stripeRefundId = stripeRefundId;
      }
      
      console.log(`✅ Stripe refund successful: ${stripeRefundId}`);
      
    } catch (stripeError) {
      // Stripe failed - NO ROLLBACK NEEDED (nothing was changed in Step 4)
      console.error('❌ Stripe refund failed:', stripeError.message);
      
      refundRequest.status = 'failed';
      refundRequest.errorMessage = `Stripe failed: ${stripeError.message}`;
      await refundRequest.save();
      
      if (stripeError.type === 'StripeCardError' || stripeError.type === 'StripeInvalidRequestError') {
        return res.status(400).json({
          success: false,
          message: `Stripe error: ${stripeError.message}`,
          refundRequestId: refundRequest.refundRequestId
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Stripe refund failed',
        error: stripeError.message,
        refundRequestId: refundRequest.refundRequestId
      });
    }
    
    // ========== STEP 6: Apply Changes ==========
    console.log('💾 STEP 6: Applying changes to database...');
    
    try {
      // Get invoice
      const invoice = await EventInvoice.findOne({ invoiceNumber });
      
      if (!invoice) {
        throw new Error('Invoice not found');
      }
      
      // Apply prepared changes
      await applyRefundSuccessData(
        refundRequest.refundSuccessData,
        refundRequest,
        dbTickets,
        invoice,
        organizerId
      );
      
      // Mark complete
      refundRequest.status = 'completed';
      refundRequest.completedAt = new Date();
      refundRequest.refundSuccessData = null; // Clear (no longer needed)
      await refundRequest.save();
      
      console.log(`✅ Refund completed: ${refundRequest.refundRequestId}`);
      
    } catch (applyError) {
      console.error('❌ Error applying changes:', applyError);
      
      refundRequest.status = 'failed';
      refundRequest.errorMessage = `Apply failed: ${applyError.message}`;
      await refundRequest.save();
      
      return res.status(500).json({
        success: false,
        message: 'Failed to apply changes after Stripe success',
        error: applyError.message,
        refundRequestId: refundRequest.refundRequestId
      });
    }
    
    // ========== STEP 7: Send Notification ==========
    console.log('📧 STEP 7: Sending notification...');
    
    try {
      const invoice = await EventInvoice.findOne({ invoiceNumber });
      
      if (invoice) {
        await sendRefundConfirmationToBuyer({
          tickets: dbTickets,
          invoice: invoice,
          refundDetails: {
            refundRequestId: refundRequest.refundRequestId,
            totalAmount: refundRequest.totalAmount,
            refundAmountMap: Object.fromEntries(refundAmountMap),
            reason: reason,
            refundedAt: new Date()
          }
        });
        
        console.log('✅ Notification sent');
      }
    } catch (emailError) {
      console.warn('⚠️  Email notification failed:', emailError.message);
      // Don't fail refund if email fails
    }
    
    // Success response
    res.status(200).json({
      success: true,
      message: `Successfully refunded ${refundRequest.totalAmount.toFixed(2)} AUD`,
      refund: {
        refundRequestId: refundRequest.refundRequestId,
        ticketNumbers: ticketNumbers,
        refundAmount: refundRequest.totalAmount,
        stripeRefundId: refundRequest.stripeRefundId,
        seatsReleased: refundRequest.seatsReleased,
        refundedAt: refundRequest.completedAt
      }
    });
    
  } catch (error) {
    console.error('❌ Error processing refund:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to process refund',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});