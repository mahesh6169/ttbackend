// controllers/tickets/ticketController.js

import asyncHandler from 'express-async-handler';
import stripe from '../../config/stripe.js';
import Event from '../../models/eventModel.js';
import User from '../../models/userModel.js';
import PaidTicket from '../../models/paidTicket.js';
import Reservation from '../../models/reservationModel.js';
import { validateTicketPurchase, calculateTicketPricing, formatBuyerNameForStripe, validateDiscountCode, applyDiscount, splitDiscountAcrossTickets, DISCOUNT_REASON_MESSAGES, planPackIssuance, isSalesOpen } from '../../utils/events/ticketHelpers.js';

import { assignSeatsToTicket } from '../../utils/events/seatHelpers.js';
import { cleanupExpiredReservations } from './reservationController.js';
import { getEffectivePlatformFee, computeCommissionCents } from '../../utils/constants/platformPriceConfig.js';
import PendingOrder from '../../models/pendingOrder.js';
import { fulfilPaidOrder, ORDER_WINDOW_MS } from '../../utils/events/paidOrderFulfilment.js';


// @desc    Create Payment Intent for ticket purchase
// @route   POST /api/events/:eventId/paid/create-payment-intent
// @access  Private
export const createPaymentIntent = asyncHandler(async (req, res) => {
  
  try {
    const { tickets, buyerInfo, discountCode, formResponses } = req.body;
    // 'hold' (feature 1015): authorise only; the money is taken once the tickets exist. Sent by the
    // new checkout page. Without it (the older page) the card is charged at Pay, as before.
    const captureMode = req.body.captureMode === 'hold' ? 'hold' : 'immediate';
    const eventId = req.params.eventId;
    const userId = req.user._id;

    // Validate required fields
    if (!eventId || !tickets || !buyerInfo) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: tickets or buyerInfo'
      });
    }

    // Clean up expired seat reservations before processing ticket purchase
    await cleanupExpiredReservations(eventId);
    
    // Fetch event with organizer details
    const event = await Event.findById(eventId).populate('postedBy', 'stripeAccountId email');
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if event is paid
    if (!event.isPaid) {
      return res.status(400).json({
        success: false,
        message: 'This is not a paid event'
      });
    }

    // REMOVED: Payment eligibility check - Stripe will handle this

    // Validate organizer has Stripe account
    if (!event.postedBy.stripeAccountId) {
      return res.status(400).json({
        success: false,
        message: 'Event organizer has not set up payment processing'
      });
    }

    // REMOVED: Account validation - Stripe will handle invalid accounts


    // Validate ticket purchase
    const validation = await validateTicketPurchase(event, tickets);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.error,
        ...(validation.errorCode ? { errorCode: validation.errorCode } : {})
      });
    }

    // Seat reliability (Move 1+2 + pre-charge guard): for a seated event, the buyer must
    // still hold a live seat for EVERY ticket before we create the PaymentIntent. If the
    // hold lapsed (e.g. they lingered on checkout past the reservation window), reject here
    // — nothing is charged — instead of charging and then rolling back at confirm. When the
    // hold is good we extend it to survive card entry and record the seatIds so confirm
    // binds from an authoritative server-side list (not a fragile reservedBy re-scan).
    // The window is fixed (not env-based): card-entry time doesn't depend on environment.
    const PAYMENT_HOLD_MS = ORDER_WINDOW_MS; // 15 min — comfortably survives card entry
    const totalTickets = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);
    let heldSeatIds = [];
    if (event.seatingLayout && event.seatingLayout.length > 0) {
      const reservation = await Reservation.findActiveReservation(eventId, userId);
      const now = new Date();

      // Seats genuinely held by THIS user right now (verified against the live layout).
      const heldByUser = [];
      if (reservation && reservation.seatIds && reservation.seatIds.length > 0) {
        for (const row of event.seatingLayout) {
          if (!row.seats || !Array.isArray(row.seats)) continue;
          for (const s of row.seats) {
            if (reservation.seatIds.includes(s.seatId) &&
                s.reservedBy && s.reservedBy.toString() === userId.toString() &&
                s.reservedUntil && s.reservedUntil > now &&
                (s.status === 'selected' || s.status === 'reserved')) {
              heldByUser.push(s.seatId);
            }
          }
        }
      }

      // PRE-CHARGE GUARD: no live hold for every ticket → refuse before any charge.
      if (heldByUser.length !== totalTickets) {
        return res.status(409).json({
          success: false,
          errorCode: 'SEAT_HOLD_EXPIRED',
          message: 'Your seat hold has expired. Please pick your seats again.',
          requiresSeatReselection: true
        });
      }

      // Hold is good — extend it to survive card entry (Move 1) and record the verified
      // seatIds for confirm to bind against (Move 2).
      const newExpiry = new Date(Date.now() + PAYMENT_HOLD_MS);
      reservation.expiresAt = newExpiry;
      await reservation.save();
      // Mirror addSeatsToReservation's array-filter update (reservationController.js:251).
      // Only touch this user's still-held seats — never a booked or someone else's seat.
      await Event.updateOne(
        { _id: eventId },
        { $set: { 'seatingLayout.$[].seats.$[seat].reservedUntil': newExpiry } },
        {
          arrayFilters: [{
            'seat.seatId': { $in: heldByUser },
            'seat.status': { $in: ['selected', 'reserved'] }
          }]
        }
      );
      heldSeatIds = heldByUser;
    }

    // Calculate pricing (pre-discount subtotal)
    const pricing = calculateTicketPricing(event, tickets);

    // Calculate platform fee using dynamic fee from event or default
    const totalTicketCount = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);
    const effectiveFees = getEffectivePlatformFee(event);

    // ── Discount code (S4 step 3) ──────────────────────────────────────────────
    // Work in INTEGER CENTS (Fix #6 path). Start from the pre-discount subtotal.
    let subtotalCents = Math.round(pricing.total * 100);
    let totalAmountCents = subtotalCents;
    let discountCents = 0;
    let appliedDiscountCode = null;
    let discountCoveredNames = null;
    if (discountCode) {
      // Re-validate authoritatively. The buyer hasn't paid yet, so an invalid code is
      // rejected here (unlike confirm-payment, which honors the price post-charge).
      const dv = validateDiscountCode(event, discountCode, tickets);
      if (!dv.valid) {
        return res.status(400).json({
          success: false,
          errorCode: 'INVALID_DISCOUNT',
          message: DISCOUNT_REASON_MESSAGES[dv.reason] || 'This discount code cannot be applied.'
        });
      }
      const applied = applyDiscount(event, tickets, dv.code);   // covered-only, integer cents
      discountCents = applied.discountCents;
      totalAmountCents = applied.discountedTotalCents;
      appliedDiscountCode = dv.code.code;                        // normalized as stored

      // Silent $1 backstop (D10): after the discount, no single ticket - and no per-person share
      // in a covered pack - may fall below the flat $1 minimum. The wizard gate (S2) normally
      // prevents this; this catches drift after an edit or a crafted request. Checked on the
      // intended per-ticket split (before the order-level min-charge raise below), and rejects.
      const coveredNames = new Set(dv.code.appliesToTicketTypes || []);
      discountCoveredNames = coveredNames;
      const floorPlan = planPackIssuance(event, tickets, discountCents, coveredNames);
      if (floorPlan.some(p => p.netPriceCents < 100)) {
        return res.status(400).json({
          success: false,
          errorCode: 'DISCOUNT_BELOW_MIN',
          message: 'This discount cannot be applied - it would make a ticket cost less than $1.'
        });
      }
    }

    // Fix #6: platform commission in INTEGER CENTS, computed on the DISCOUNTED total
    // (S4 step 4). computeCommissionCents is reused as-is — only the amount argument changed.
    let platformFeeCents = computeCommissionCents(totalAmountCents, totalTicketCount, effectiveFees);

    // S4 step 5 — minimum-charge guard: never charge below max($1, platform fee). If a
    // discount pushed the total under that floor, raise it back up (shrinking the effective
    // discount) and recompute the commission once. Wizard V6 makes this a rare backstop;
    // Stripe also rejects amount <= application_fee, so we never silently overcharge.
    const minChargeCents = Math.max(100, platformFeeCents);
    if (totalAmountCents < minChargeCents) {
      totalAmountCents = minChargeCents;
      discountCents = Math.max(0, subtotalCents - totalAmountCents);
      platformFeeCents = computeCommissionCents(totalAmountCents, totalTicketCount, effectiveFees);
    }

    // Display/metadata values (what the organizer sees), derived from the same integer path.
    const flatFeeCents = Math.round(totalTicketCount * effectiveFees.flatFee * 100);       // $0.80/ticket
    const percentageFeeCents = Math.round((totalAmountCents * effectiveFees.percentage) / 100);
    const totalFeesForOrganizerCents = flatFeeCents + percentageFeeCents;                  // 2% + $0.80, no absorption
    const organizerAmountCents = totalAmountCents - totalFeesForOrganizerCents;
    
    // Create Payment Intent - Stripe will handle account validation
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountCents,
        currency: 'aud',
        payment_method_types: ['card'],
        ...(captureMode === 'hold' ? { capture_method: 'manual' } : {}),
        
        // Direct charge configuration - charge in organizer's account
        application_fee_amount: platformFeeCents, // Platform fee (flat + percentage)
        
        // Metadata for tracking
        metadata: {
          eventId: eventId,
          userId: userId.toString(),
          ticketTypes: JSON.stringify(tickets),
          buyerEmail: buyerInfo.email,
          buyerName: `${buyerInfo.firstName} ${buyerInfo.lastName}`,
          eventTitle: event.title,
          organizerAccountId: event.postedBy.stripeAccountId,
          ticketCount: totalTicketCount.toString(),
          platformFeeFlat: effectiveFees.flatFee.toFixed(2),
          platformFeePercentage: effectiveFees.percentage.toFixed(2),
          totalPlatformFee: (platformFeeCents / 100).toFixed(2),
          organizerAmount: (organizerAmountCents / 100).toFixed(2),
          // Discount (S4 step 6) — confirm-payment reads these back to build the invoice +
          // per-ticket prices and to count the redemption. Empty/"0.00" when no code.
          discountCode: appliedDiscountCode || '',
          discountAmount: (discountCents / 100).toFixed(2),
          subtotal: (subtotalCents / 100).toFixed(2),
          // Authoritative held seats (Move 2). Empty "[]" for general-admission events.
          seatIds: JSON.stringify(heldSeatIds),
          captureMode,
        },
        
        // Description
        description: `${event.eventCode} | ${formatBuyerNameForStripe(buyerInfo.firstName, buyerInfo.lastName)} | ${totalTicketCount} ${totalTicketCount === 1 ? 'ticket' : 'tickets'}`,
      }, {
        // Execute in organizer's Stripe account context
        stripeAccount: event.postedBy.stripeAccountId,
      });

    } catch (stripeError) {
      // SIMPLIFIED: Generic error handling instead of specialized account error handling
      console.error('❌ Stripe error creating payment intent:', stripeError);
      
      return res.status(400).json({
        success: false,
        message: `Payment processing error: ${stripeError.message}`,
        errorCode: 'STRIPE_ERROR',
        error: process.env.NODE_ENV === 'development' ? stripeError.message : undefined
      });
    }

    // Feature 1015: keep the whole order on the server, so the Stripe webhook can make the tickets
    // if the buyer's browser never reports back. Prices are locked here (the price at Pay).
    await PendingOrder.create({
      paymentIntentId: paymentIntent.id,
      stripeAccountId: event.postedBy.stripeAccountId,
      event: event._id,
      user: userId,
      captureMode,
      tickets,
      buyer: {
        firstName: buyerInfo.firstName,
        lastName: buyerInfo.lastName,
        email: buyerInfo.email,
        phone: buyerInfo.phone,
        agreeToTerms: buyerInfo.agreeToTerms,
        refundPolicyAccepted: buyerInfo.refundPolicyAccepted || false,
      },
      ...(formResponses && typeof formResponses === 'object' ? { formResponses } : {}),
      seatIds: heldSeatIds,
      issuancePlan: planPackIssuance(event, tickets, discountCents, discountCoveredNames),
      subtotalCents,
      discountCode: appliedDiscountCode || '',
      discountCents,
      totalAmountCents,
    });

    res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      stripeAccountId: event.postedBy.stripeAccountId,
      // Augment pricing with the discounted figures for the checkout Option-A summary.
      pricing: {
        ...pricing,
        subtotal: subtotalCents / 100,
        discountCode: appliedDiscountCode,
        discountAmount: discountCents / 100,
        total: totalAmountCents / 100
      }
    });

  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment intent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Confirm payment and create tickets
// @route   POST /api/events/:eventId/paid/confirm-payment
// @access  Private
// The browser path of the order. The same order can also be finished by the Stripe webhook
// (feature 1015) - both go through fulfilPaidOrder, which makes it exactly once.
export const confirmPayment = asyncHandler(async (req, res) => {
  try {
    const { paymentIntentId, tickets, buyerInfo, formResponses = {} } = req.body;
    const eventId = req.params.eventId;
    const userId = req.user._id;

    // Clean up expired seat reservations before confirming payment
    await cleanupExpiredReservations(eventId);

    // A payment started before feature 1015 has no saved order: keep the old early cutoff
    // guard for it (no Stripe call). Saved orders are judged by when Pay was clicked.
    const pending = await PendingOrder.findOne({ paymentIntentId }).select('_id').lean();
    if (!pending) {
      const event = await Event.findById(eventId).select('dateTime timeZone').lean();
      if (!event) {
        return res.status(404).json({ success: false, message: 'Event not found' });
      }
      if (!isSalesOpen(event)) {
        return res.status(400).json({
          success: false,
          message: 'Ticket sales for this event have closed.',
          errorCode: 'SALES_CLOSED',
        });
      }
    }

    const result = await fulfilPaidOrder({
      paymentIntentId,
      eventId,
      userId,
      source: 'browser',
      browser: { tickets, buyerInfo, formResponses },
    });
    return res.status(result.http).json(result.body);
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm payment and create tickets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Validate a discount code at checkout (the "Apply" button)
// @route   POST /api/events/:eventId/paid/validate-discount
// @access  Private
// Read-only: never mutates counters. create-payment-intent re-validates + applies
// authoritatively (S4); this just gives the checkout page its Option-A summary numbers.
export const validateDiscount = asyncHandler(async (req, res) => {
  try {
    const { code, tickets } = req.body;
    const eventId = req.params.eventId;

    if (!code || !tickets || Object.keys(tickets).length === 0) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: 'Discount code and selected tickets are required'
      });
    }

    const event = await Event.findById(eventId).select('isPaid ticketTypes discountCodes');
    if (!event) {
      return res.status(404).json({ success: false, valid: false, message: 'Event not found' });
    }
    if (!event.isPaid) {
      return res.status(400).json({ success: false, valid: false, message: 'This is not a paid event' });
    }

    // S3 canonical rule set. An invalid code is an expected user case, not an HTTP
    // error — return 200 with valid:false + a message the checkout page shows inline.
    const result = validateDiscountCode(event, code, tickets);
    if (!result.valid) {
      return res.status(200).json({
        success: true,
        valid: false,
        reason: result.reason,
        message: DISCOUNT_REASON_MESSAGES[result.reason] || 'This discount code cannot be applied.'
      });
    }

    // Valid — compute the advisory summary numbers (dollars). create-payment-intent is
    // authoritative (incl. the minimum-charge guard); this total is for display (S3).
    const { subtotalCents, discountCents, discountedTotalCents } = applyDiscount(event, tickets, result.code);

    return res.status(200).json({
      success: true,
      valid: true,
      code: result.code.code,          // normalized as stored on the event
      kind: result.code.kind,
      value: result.code.value,
      appliesToTicketTypes: result.code.appliesToTicketTypes || [], // covered ticket-type NAMES (for the checkout "applies to" label)
      subtotal: subtotalCents / 100,
      discountAmount: discountCents / 100,
      total: discountedTotalCents / 100
    });

  } catch (error) {
    console.error('Error validating discount code:', error);
    res.status(500).json({ success: false, valid: false, message: 'Failed to validate discount code' });
  }
});

// @desc    Get user's tickets for a specific event
// @route   GET /api/events/:eventId/paid/my-tickets
// @access  Private
export const getMyTickets = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const userId = req.user._id;

    const tickets = await PaidTicket.find({
      event: eventId,
      user: userId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }
    }).populate('event', 'title dateTime venue');

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching user tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets'
    });
  }
});

// @desc    Get user's tickets across all events
// @route   GET /api/events/paid/my-paid-tickets
// @access  Private
export const getMyAllPaidTickets = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;

    // Fetch ALL tickets including cancelled/refunded ones
    // Frontend will handle displaying them with appropriate styling
    const tickets = await PaidTicket.find({
      user: userId
    })
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching user tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets'
    });
  }
});

// @desc    Get ticket details by ticket number
// @route   GET /api/events/paid/ticket-details/:ticketNumber
// @access  Private
export const getTicketDetails = asyncHandler(async (req, res) => {
  try {
    const { ticketNumber } = req.params;
    
    const ticket = await PaidTicket.findOne({ ticketNumber })
      .populate('event', 'title dateTime venue address')
      .populate('user', 'name email');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Only allow ticket owner or event organizer to view details
    const isOwner = ticket.user._id.toString() === req.user._id.toString();
    const isOrganizer = ticket.event.postedBy.toString() === req.user._id.toString();

    if (!isOwner && !isOrganizer) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this ticket'
      });
    }

    res.status(200).json({
      success: true,
      ticket
    });

  } catch (error) {
    console.error('Error fetching ticket details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ticket details'
    });
  }
});

// @desc    Get all tickets for an event (organizer only)
// @route   GET /api/events/:eventId/paid/all-tickets
// @access  Private (Organizer only)
export const getAllEventTickets = asyncHandler(async (req, res) => {
  
  try {
    const { eventId } = req.params;
    const organizerId = req.user._id;

    // Verify event ownership
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (event.postedBy.toString() !== organizerId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only event organizers can view all tickets'
      });
    }

    // Get all tickets for this event
    const tickets = await PaidTicket.find({
      event: eventId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }
    })
    .populate('user', 'name email')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching event tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event tickets'
    });
  }
});

