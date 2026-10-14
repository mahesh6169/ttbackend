// utils/events/ticketHelpers.js

import crypto from 'crypto';
import dateFnsTz from 'date-fns-tz';

const { utcToZonedTime, zonedTimeToUtc } = dateFnsTz;

// Returns true when `now` is still within the ticket sales window for `event`.
// Sales close at 11:59:59 PM on the event's local calendar day (the dateTime day in event.timeZone).
// `now` is injectable so tests can travel through time without touching the system clock.
export const isSalesOpen = (event, now = new Date()) => {
  const tz = event.timeZone || 'Australia/Sydney';
  // Get the local calendar date of the event start in the event's timezone.
  const localStart = utcToZonedTime(new Date(event.dateTime), tz);
  const y = localStart.getFullYear();
  const m = String(localStart.getMonth() + 1).padStart(2, '0');
  const d = String(localStart.getDate()).padStart(2, '0');
  // Build the cutoff as an ISO-local string (no timezone suffix) so zonedTimeToUtc
  // treats those numbers as existing in the event's own timezone, not the server tz.
  const cutoffLocal = `${y}-${m}-${d}T23:59:59`;
  const cutoffUtc = zonedTimeToUtc(cutoffLocal, tz);
  return now <= cutoffUtc;
};

/**
 * Generate a unique ticket number
 * 
 */
export const generateTicketNumber = async (eventCode, session = null) => {
  try {
    // Extract the code part from EVT-KYJDS -> KYJDS
    const codepart = eventCode.replace('EVT-', '');

    // Import here to avoid circular dependency
    const PaidTicket = (await import('../../models/paidTicket.js')).default;

    // Find the highest ticket number for this event code pattern.
    // When called inside a transaction (session passed), the query MUST run on that session
    // so it sees the ticket(s) this same order just inserted but hasn't committed yet —
    // otherwise every ticket in the order would be handed the same number.
    let query = PaidTicket.findOne({
      ticketNumber: { $regex: `^TKT-${codepart}-` }
    })
    .sort({ ticketNumber: -1 }) // Sort descending to get latest
    .select('ticketNumber');
    if (session) query = query.session(session);
    const latestTicket = await query;
    
    let nextNumber = 1;
    
    if (latestTicket) {
      // Extract the sequence number from the latest ticket
      // TKT-KYJDS-0003 -> extract 0003 -> convert to 3 -> increment to 4
      const ticketNumberParts = latestTicket.ticketNumber.split('-');
      const lastSequence = ticketNumberParts[ticketNumberParts.length - 1];
      nextNumber = parseInt(lastSequence) + 1;
    }
    
    // Format with leading zeros (0001, 0002, etc.)
    const sequenceStr = nextNumber.toString().padStart(4, '0');
    
    const ticketNumber = `TKT-${codepart}-${sequenceStr}`;
    
    console.log(`🎫 Generated ticket number: ${ticketNumber} (sequence ${nextNumber} for event ${eventCode})`);
    
    return ticketNumber;
    
  } catch (error) {
    console.error('❌ Error generating ticket number:', error);
    
    // Fallback to original logic if database query fails
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomStr = crypto.randomBytes(3).toString('hex').toUpperCase();
    const fallbackTicket = `TKT-${dateStr}-${randomStr}`;
    
    console.warn(`⚠️ Using fallback ticket number: ${fallbackTicket}`);
    return fallbackTicket;
  }
};

/**
 * Buyer-facing message when a bundle-type quantity isn't a whole number of packs.
 * One source of truth so the reservation path and the payment revalidation word it identically.
 * See featureplans/events-bundle-ticket.md (the multiples wall).
 */
export const bundleMultipleMessage = (name, bundleSize) =>
  `${name} is sold in packs of ${bundleSize}. Please choose a quantity that is a multiple of ${bundleSize}.`;

/**
 * Validate ticket purchase request
 * @param {Object} event - Event document
 * @param {Object} tickets - Object with ticketTypeId: quantity pairs
 * @returns {Object} { isValid: boolean, error?: string }
 */
export const validateTicketPurchase = async (event, tickets) => {
  console.log('🔍 Validating ticket purchase for event:', event._id);
  
  try {
    // Check if event exists and is paid
    if (!event) {
      return { isValid: false, error: 'Event not found' };
    }

    if (!event.isPaid) {
      return { isValid: false, error: 'This is not a paid event' };
    }

    // Sales close at 11:59:59 PM on the event's local calendar day (D1).
    if (!isSalesOpen(event)) {
      return { isValid: false, errorCode: 'SALES_CLOSED', error: 'Ticket sales for this event have closed.' };
    }

    // Check if event has ticket types
    if (!event.ticketTypes || event.ticketTypes.length === 0) {
      return { isValid: false, error: 'No ticket types available for this event' };
    }

    let totalTicketsRequested = 0;
    const ticketValidations = [];

    // Validate each ticket type request
    for (const [ticketTypeId, quantity] of Object.entries(tickets)) {
      if (quantity <= 0) continue;

      const ticketType = event.ticketTypes.find(t => t._id.toString() === ticketTypeId);
      
      if (!ticketType) {
        return { 
          isValid: false, 
          error: `Ticket type not found: ${ticketTypeId}` 
        };
      }

      // A stopped (switched-off) type can't be bought - the organiser retired it (events-edit-locking.md).
      if (ticketType.active === false) {
        return {
          isValid: false,
          error: `${ticketType.name} tickets are no longer available for purchase`,
        };
      }

      // Check date restrictions only (removed quantity availability check)
      const now = new Date();

      if (ticketType.startDate && new Date(ticketType.startDate) > now) {
        return { 
          isValid: false, 
          error: `${ticketType.name} tickets are not yet available for purchase` 
        };
      }

      if (ticketType.expiryDate && new Date(ticketType.expiryDate) < now) {
        return {
          isValid: false,
          error: `${ticketType.name} tickets are no longer available for purchase`
        };
      }

      // Multiples wall: a bundle type can only be bought in whole packs. Runs here so both
      // create-payment-intent and confirm-payment revalidation inherit it for free.
      if (ticketType.bundleSize && ticketType.bundleSize >= 2 && quantity % ticketType.bundleSize !== 0) {
        return {
          isValid: false,
          error: bundleMultipleMessage(ticketType.name, ticketType.bundleSize)
        };
      }

      totalTicketsRequested += quantity;
      ticketValidations.push({
        ticketTypeId,
        name: ticketType.name,
        quantity,
        price: ticketType.price
      });
    }

    // Check total ticket limit per registration
    if (totalTicketsRequested > (event.maxAttendeesPerRegistration || 10)) {
      return { 
        isValid: false, 
        error: `Cannot purchase more than ${event.maxAttendeesPerRegistration || 10} tickets per order` 
      };
    }

    // Check overall event capacity (if limited)
    if (event.capacity && event.capacity > 0) {
      // Calculate current tickets sold with retry for accuracy
      let currentTicketsSold = 0;
      try {
        currentTicketsSold = await calculateCurrentTicketsSold(event._id);
        console.log(`🔍 CAPACITY DEBUG: Event ${event._id} - Capacity: ${event.capacity}, Sold: ${currentTicketsSold}, Requesting: ${totalTicketsRequested}`);
      } catch (error) {
        console.error('❌ Error checking current capacity, being conservative:', error);
        return {
          isValid: false,
          error: 'Unable to verify ticket availability at this moment. Please try again.'
        };
      }
      
      const remainingCapacity = event.capacity - currentTicketsSold;
      
      // Check if event is sold out
      if (remainingCapacity <= 0) {
        return { 
          isValid: false, 
          error: 'Sorry, this event is now sold out! Please check back later in case of cancellations.' 
        };
      }
      
      // Check if request exceeds remaining capacity
      if (totalTicketsRequested > remainingCapacity) {
        if (remainingCapacity === 1) {
          return { 
            isValid: false, 
            error: `Only 1 ticket remaining for this event. Please adjust your selection.` 
          };
        } else if (remainingCapacity < 5) {
          return { 
            isValid: false, 
            error: `Only ${remainingCapacity} tickets left! You requested ${totalTicketsRequested}. Please reduce your selection.` 
          };
        } else {
          return { 
            isValid: false, 
            error: `Sorry, only ${remainingCapacity} tickets are available, but you requested ${totalTicketsRequested}. Please adjust your order.` 
          };
        }
      }
      
      // Warning if getting close to capacity
      if (remainingCapacity <= 10) {
        console.log(`⚠️ Low capacity warning: Only ${remainingCapacity} tickets left for event ${event._id}`);
      }
    }

    console.log('✅ Ticket purchase validation passed');
    return { 
      isValid: true, 
      ticketValidations,
      totalTicketsRequested 
    };

  } catch (error) {
    console.error('❌ Error validating ticket purchase:', error);
    return { 
      isValid: false, 
      error: 'Validation error occurred' 
    };
  }
};

/**
 * Calculate pricing for ticket purchase (simplified - no GST or platform fees)
 * @param {Object} event - Event document
 * @param {Object} tickets - Object with ticketTypeId: quantity pairs
 * @returns {Object} Pricing breakdown
 */
export const calculateTicketPricing = (event, tickets) => {
  console.log('💰 Calculating pricing for tickets');
  
  let subtotalCents = 0;
  const ticketBreakdown = [];

  // Calculate subtotal for each ticket type. A bundle line is packPrice x packs (never
  // price x people); lineSubtotalCents is the single pack-aware source of that math.
  for (const [ticketTypeId, quantity] of Object.entries(tickets)) {
    if (quantity <= 0) continue;

    const ticketType = event.ticketTypes.find(t => t._id.toString() === ticketTypeId);
    if (!ticketType) continue;

    const ticketTotalCents = lineSubtotalCents(ticketType, quantity);
    subtotalCents += ticketTotalCents;

    ticketBreakdown.push({
      ticketTypeId,
      name: ticketType.name,
      price: ticketType.price,
      quantity,
      total: ticketTotalCents / 100
    });
  }

  const subtotal = subtotalCents / 100;

  // Simplified pricing - no GST, no platform fees calculated here
  // Platform fees are handled automatically by Stripe dashboard
  const pricing = {
    subtotal,
    total: subtotal, // Total = subtotal (no additional fees calculated)
    organizerAmount: subtotal, // Amount organizer receives before platform fees
    ticketBreakdown,
    currency: 'AUD'
  };

  console.log('💰 Pricing calculation complete:', {
    subtotal: pricing.subtotal,
    total: pricing.total,
    organizerAmount: pricing.organizerAmount
  });

  return pricing;
};

/**
 * Calculate current tickets sold for an event
 * @param {String} eventId - Event ID
 * @returns {Number} Number of tickets sold
 */
export const calculateCurrentTicketsSold = async (eventId) => {
  try {
    // Import here to avoid circular dependency
    const PaidTicket = (await import('../../models/paidTicket.js')).default;
    const mongoose = (await import('mongoose')).default;
    
    // Convert string to ObjectId if needed
    const objectId = mongoose.Types.ObjectId.isValid(eventId) 
      ? new mongoose.Types.ObjectId(eventId) 
      : eventId;
    
    // Count total tickets sold (each PaidTicket document represents 1 ticket)
    const result = await PaidTicket.countDocuments({
      event: objectId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }
    });

    return result;
  } catch (error) {
    console.error('❌ Error calculating tickets sold:', error);
    return 0;
  }
};

/**
 * Generate QR code data for ticket
 * @param {Object} ticket - Ticket document
 * @returns {String} QR code data
 */
export const generateTicketQRCode = (ticket) => {
  const qrData = {
    ticketNumber: ticket.ticketNumber,
    eventId: ticket.event._id || ticket.event,
    userId: ticket.user._id || ticket.user,
    ticketType: ticket.ticketType.name,
    checksum: crypto
      .createHash('sha256')
      .update(`${ticket.ticketNumber}-${ticket.event}-${ticket.user}`)
      .digest('hex')
      .substring(0, 8)
  };

  return JSON.stringify(qrData);
};

/**
 * Verify QR code data for ticket validation
 * @param {String} qrData - QR code data
 * @param {Object} ticket - Ticket document to verify against
 * @returns {Boolean} Whether QR code is valid
 */
export const verifyTicketQRCode = (qrData, ticket) => {
  try {
    const data = JSON.parse(qrData);
    
    // Verify checksum
    const expectedChecksum = crypto
      .createHash('sha256')
      .update(`${ticket.ticketNumber}-${ticket.event}-${ticket.user}`)
      .digest('hex')
      .substring(0, 8);

    return (
      data.ticketNumber === ticket.ticketNumber &&
      data.eventId === (ticket.event._id || ticket.event).toString() &&
      data.userId === (ticket.user._id || ticket.user).toString() &&
      data.checksum === expectedChecksum
    );
  } catch (error) {
    console.error('❌ Error verifying QR code:', error);
    return false;
  }
};

/**
 * Format ticket for email/display
 * @param {Object} ticket - Ticket document
 * @param {Object} event - Event document
 * @returns {Object} Formatted ticket data
 */
export const formatTicketForDisplay = (ticket, event) => {
  return {
    ticketNumber: ticket.ticketNumber,
    eventTitle: event.title,
    eventDate: event.dateTime,
    eventVenue: event.venue,
    eventAddress: event.address?.formattedAddress,
    ticketType: ticket.ticketType.name,
    price: ticket.ticketType.price,
    attendeeName: ticket.attendees[0]?.name,
    seats: ticket.seats && ticket.seats.length > 0 
      ? ticket.seats.map(seat => `${seat.row}${seat.seatNumber}`).join(', ')
      : 'General Admission',
    qrCode: generateTicketQRCode(ticket),
    status: ticket.status,
    purchaseDate: ticket.createdAt
  };
};



/**
 * Create event snapshot for ticket data independence
 * @param {Object} event - Event document
 * @returns {Object} Event snapshot object
 */
export const createEventSnapshot = (event) => {
  return {
    eventCode: event.eventCode,
    title: event.title,
    description: event.description,
    dateTime: event.dateTime,
    timeZone: event.timeZone,
    venue: event.venue,
    address: event.address?.formattedAddress || '',
    category: event.category,
    communities: event.communities || [],
    organizer: {
      name: event.organizer?.name || '',
      email: event.organizer?.email || '',
      phone: event.organizer?.contact || '', // Map 'contact' field to 'phone' for consistency
      website: event.organizer?.website || '',
      abn: event.organizer?.abn || '' // Australian Business Number for invoicing
    },
    postedBy: event.postedBy._id.toString(),
    isPaid: event.isPaid || false,
    capacity: event.capacity || null,
    status: event.status || 'active',
    images: event.images || [],
    refundPolicy: {
      processingFeePolicy: event.refundPolicy?.processingFeePolicy || 'non-refundable',
      policyText: event.refundPolicy?.policyText || '',
      termsAndConditions: event.refundPolicy?.termsAndConditions || ''
    },
    gstIncluded: event.gstIncluded || false,
    ticketTypes: event.ticketTypes || []
  };
};


/**
 * Generate invoice number with event code pattern.
 * Format: INV-<CODE>-NNNN (4-digit minimum, no cap) e.g. INV-AZAMW-0001.
 * Uses the atomic per-event counter (EventIdCounter) so concurrent buyers never collide and there is
 * no width ceiling. See designGuides/events-refactor/feature-stable-id-counter.md.
 * @param {String} eventCode - full event code (e.g. "EVT-AZAMW")
 */
export const generateInvoiceNumber = async (eventCode) => {
  // Extract the code part for the visible id: EVT-AZAMW -> AZAMW.
  const codepart = eventCode.replace('EVT-', '');

  const EventIdCounter = (await import('../../models/eventIdCounter.js')).default;
  const seq = await EventIdCounter.next(eventCode, 'invoice');

  const sequenceStr = seq.toString().padStart(4, '0');
  const invoiceNumber = `INV-${codepart}-${sequenceStr}`;

  console.log(`📋 Generated invoice number: ${invoiceNumber} (sequence ${seq} for event ${eventCode})`);
  return invoiceNumber;
};


/**
 * Format buyer name for Stripe descriptions (First name + Last initial)
 * @param {String} firstName - Buyer's first name
 * @param {String} lastName - Buyer's last name  
 * @returns {String} Formatted name like "John S."
 */
export const formatBuyerNameForStripe = (firstName, lastName) => {
  if (!firstName || !lastName) return 'Guest';

  const firstNameTrimmed = firstName.trim();
  const lastInitial = lastName.trim().charAt(0).toUpperCase();

  return `${firstNameTrimmed} ${lastInitial}.`;
};


// ─── Discount codes (feature-add-discountcode.md S3/S4) ──────────────────────
// Shared, side-effect-free helpers reused by all three call sites:
//   • validate-discount endpoint (S2 hint redeemability + S3 Apply)
//   • create-payment-intent (S4 step 3 — re-validate + apply, CAN reject)
//   • confirm-payment (S4-B — read from metadata, honor price; uses the split helper)
// All money math is in INTEGER CENTS to match Fix #6 (computeCommissionCents).

/**
 * Normalize a user-entered code to how it's stored on the event: trim + UPPERCASE.
 * @param {*} raw
 * @returns {String}
 */
export const normalizeDiscountCode = (raw) =>
  (raw == null ? '' : String(raw)).trim().toUpperCase();

// Stable reason codes → buyer-facing messages. One source of truth so the endpoint
// and create-payment-intent surface identical wording (S3 "first match wins").
export const DISCOUNT_REASON_MESSAGES = {
  NO_CODE: 'Enter a discount code.',
  NOT_FOUND: "This discount code isn't valid for this event.",
  INACTIVE: 'This discount code is no longer available.',
  NOT_STARTED: "This discount code isn't active yet.",
  EXPIRED: 'This discount code has expired.',
  FULLY_USED: 'This discount code has reached its usage limit.',
  NOT_APPLICABLE: "This discount code doesn't apply to the tickets you selected.",
};

/**
 * Validate a discount code against an event + the tickets being bought.
 * Implements S3's canonical rule set, first match wins. Pure read — never mutates
 * counters (confirm-payment owns the atomic decrement). Returns the matched
 * subdocument when valid so callers don't look it up twice.
 *
 * @param {Object} event   - Event document (discountCodes[] + ticketTypes[])
 * @param {String} rawCode - code the buyer typed
 * @param {Object} tickets - { ticketTypeId: quantity }
 * @param {Object} [opts]  - { now?: Date } injectable clock for tests
 * @returns {{ valid: boolean, reason?: string, code?: Object }}
 */
export const validateDiscountCode = (event, rawCode, tickets, opts = {}) => {
  const now = opts.now || new Date();
  const code = normalizeDiscountCode(rawCode);
  if (!code) return { valid: false, reason: 'NO_CODE' };

  const dc = (event.discountCodes || []).find(
    (d) => normalizeDiscountCode(d.code) === code
  );
  if (!dc) return { valid: false, reason: 'NOT_FOUND' };       // unknown code
  if (!dc.active) return { valid: false, reason: 'INACTIVE' }; // organizer switched it off

  // Validity window (inclusive). validUntil is stored as end-of-day in the event's
  // timezone at wizard save (S1), so a plain comparison is correct here.
  if (dc.validFrom && now < new Date(dc.validFrom)) return { valid: false, reason: 'NOT_STARTED' };
  if (dc.validUntil && now > new Date(dc.validUntil)) return { valid: false, reason: 'EXPIRED' };

  // Remaining uses (null = unlimited). Read-only check; confirm-payment honors the
  // price even if this races to 0 between intent and confirm (S4-B).
  if (dc.remainingUses != null && dc.remainingUses <= 0) {
    return { valid: false, reason: 'FULLY_USED' };
  }

  // Must cover at least one purchased ticket type. appliesToTicketTypes stores NAMES;
  // tickets is keyed by ticket-type _id, so map id → name first.
  const covered = new Set(dc.appliesToTicketTypes || []);
  const buysCoveredType = Object.entries(tickets).some(([id, qty]) => {
    if (qty <= 0) return false;
    const tt = event.ticketTypes.find((t) => t._id.toString() === id);
    return tt && covered.has(tt.name);
  });
  if (!buysCoveredType) return { valid: false, reason: 'NOT_APPLICABLE' };

  return { valid: true, code: dc };
};

/**
 * Compute the discount in INTEGER CENTS for an already-validated code (S4 step 3).
 * The discount applies to the COVERED ticket types only; the whole-order subtotal is
 * returned too so callers can build the Option-A summary + invoice.
 *
 * NOTE: this is raw pricing — the caller still applies the minimum-charge guard
 * (max($1, platform fee), S4 step 5), which may shrink the effective discount.
 *
 * @param {Object} event          - Event document
 * @param {Object} tickets        - { ticketTypeId: quantity }
 * @param {Object} discountSubdoc - the matched discountCodes[] entry (from validateDiscountCode)
 * @returns {{ subtotalCents, coveredCents, discountCents, discountedTotalCents }}
 */
export const applyDiscount = (event, tickets, discountSubdoc) => {
  let subtotalCents = 0;
  let coveredCents = 0;
  const covered = new Set(discountSubdoc.appliesToTicketTypes || []);

  for (const [id, qty] of Object.entries(tickets)) {
    if (qty <= 0) continue;
    const tt = event.ticketTypes.find((t) => t._id.toString() === id);
    if (!tt) continue;
    // Pack-aware: a bundle line is packPrice x packs, not share x people.
    const lineCents = lineSubtotalCents(tt, qty);
    subtotalCents += lineCents;
    if (covered.has(tt.name)) coveredCents += lineCents;
  }

  let discountCents;
  if (discountSubdoc.kind === 'percent') {
    discountCents = Math.round((coveredCents * discountSubdoc.value) / 100);
  } else {
    // fixed: dollars off the covered portion, capped so it never exceeds it
    discountCents = Math.round(discountSubdoc.value * 100);
  }
  discountCents = Math.max(0, Math.min(discountCents, coveredCents));

  return {
    subtotalCents,
    coveredCents,
    discountCents,
    discountedTotalCents: subtotalCents - discountCents,
  };
};

/**
 * Split a total discount (cents) across covered tickets proportionally to each
 * ticket's base price, using the largest-remainder method so the parts sum EXACTLY
 * to totalDiscountCents (no lost/extra cent). Used at confirm to store each covered
 * ticket's discounted priceDetails.totalPrice (S4-D).
 *
 * @param {Number[]} basePricesCents - one entry per covered ticket
 * @param {Number}   totalDiscountCents
 * @returns {Number[]} per-ticket discount in cents, aligned with basePricesCents
 */
export const splitDiscountAcrossTickets = (basePricesCents, totalDiscountCents) => {
  const n = basePricesCents.length;
  if (n === 0 || totalDiscountCents <= 0) return basePricesCents.map(() => 0);
  const base = basePricesCents.reduce((s, c) => s + c, 0);
  if (base <= 0) return basePricesCents.map(() => 0);

  const exact = basePricesCents.map((c) => (c * totalDiscountCents) / base);
  const result = exact.map(Math.floor);
  const handedOut = result.reduce((s, c) => s + c, 0);
  const leftover = totalDiscountCents - handedOut; // cents still to distribute
  // Give each leftover cent to the largest fractional part (largest-remainder).
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < leftover; k++) result[order[k % n].i] += 1;
  return result;
};

// --- Bundle (pack) pricing (events-bundle-pricing.md) ------------------------
// The stored price of a bundle type IS the pack price the organiser typed. A pack admits
// `bundleSize` people and is split into that many real tickets only at issuance. All money math
// below is INTEGER CENTS so nothing drifts a cent.

/**
 * Pack-aware line subtotal in INTEGER CENTS for a ticket type + a people-quantity.
 *   bundle  -> packPrice x packs   (packs = quantity / bundleSize, a validated whole number)
 *   single  -> price x quantity
 * One source of truth reused by reservation totals, checkout pricing, and discount math (D11).
 */
export const lineSubtotalCents = (ticketType, quantity) => {
  const priceCents = Math.round((ticketType.price || 0) * 100);
  const size = ticketType.bundleSize && ticketType.bundleSize >= 2 ? ticketType.bundleSize : 1;
  const packs = size > 1 ? Math.round(quantity / size) : quantity;
  return priceCents * packs;
};

/**
 * Split a positive amount (cents) into n parts that sum EXACTLY to it, differing by at most one
 * cent (e.g. 5000/3 -> 1667,1667,1666). Reuses the largest-remainder helper with equal weights (D6).
 */
export const splitEvenCents = (totalCents, n) =>
  splitDiscountAcrossTickets(new Array(n).fill(1), totalCents);

// Default pack id: a short, unique tag shared by the N tickets of one pack. Injectable for tests.
const defaultPackId = () => crypto.randomBytes(12).toString('hex');

/**
 * Plan how one order's tickets are issued (events-bundle-pricing.md S4). Turns the buyer's
 * { ticketTypeId: peopleQuantity } into the exact list of PaidTickets to create, in creation order:
 *   - a bundle line of quantity Q becomes Q/size packs; each pack's price is split across its
 *     `size` tickets in exact cents (summing to the pack price) and the tickets share one pack tag;
 *   - a single line becomes `quantity` independent tickets.
 * The order discount (in cents) is spread across the covered PACK/single units by base price
 * (largest-remainder), then each unit's discounted total is split across its tickets - so a covered
 * pack's tickets sum to the discounted pack price exactly (AC13).
 *
 * @param {Object} event
 * @param {Object} tickets            - { ticketTypeId: peopleQuantity }
 * @param {Number} totalDiscountCents - order discount to spread across covered units (0 = none)
 * @param {Set|null} coveredNames     - covered ticket-type NAMES; null = discount covers everything
 * @param {Function} [genId]          - pack-id generator (injected in tests for determinism)
 * @returns {Array<{ticketTypeId,name,basePriceCents,netPriceCents,packId,packPriceCents}>}
 */
export const planPackIssuance = (event, tickets, totalDiscountCents = 0, coveredNames = null, genId = defaultPackId) => {
  // 1. Build the pack/single units in ticket order.
  const units = [];
  for (const [ticketTypeId, quantity] of Object.entries(tickets)) {
    if (quantity <= 0) continue;
    const tt = event.ticketTypes.find((t) => t._id.toString() === ticketTypeId);
    if (!tt) continue;
    const size = tt.bundleSize && tt.bundleSize >= 2 ? tt.bundleSize : 1;
    const unitCount = size > 1 ? Math.round(quantity / size) : quantity;
    const basePackCents = Math.round(tt.price * 100);
    const covered = coveredNames ? coveredNames.has(tt.name) : true;
    for (let u = 0; u < unitCount; u++) {
      units.push({
        ticketTypeId, name: tt.name, size, basePackCents, covered,
        packId: size > 1 ? genId() : null,
        discountCents: 0,
      });
    }
  }
  // 2. Spread the order discount across covered units by base price (largest-remainder).
  if (totalDiscountCents > 0) {
    const coveredUnits = units.filter((u) => u.covered);
    const split = splitDiscountAcrossTickets(coveredUnits.map((u) => u.basePackCents), totalDiscountCents);
    coveredUnits.forEach((u, i) => { u.discountCents = split[i]; });
  }
  // 3. Expand each unit into `size` per-person tickets (exact-cent split of base + discounted total).
  const plan = [];
  for (const u of units) {
    const baseShares = splitEvenCents(u.basePackCents, u.size);
    const netShares = splitEvenCents(u.basePackCents - u.discountCents, u.size);
    for (let i = 0; i < u.size; i++) {
      plan.push({
        ticketTypeId: u.ticketTypeId,
        name: u.name,
        basePriceCents: baseShares[i],
        netPriceCents: netShares[i],
        packId: u.packId,
        packPriceCents: u.size > 1 ? u.basePackCents : null,
      });
    }
  }
  return plan;
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Collapse raw per-ticket invoice line items into display lines (events-bundle-pricing.md S5, D8):
 *   - tickets carrying a pack tag (lineItem.pack.id) group into ONE line per pack id, shown at the
 *     pack price with "admits N" by COUNT (never stored);
 *   - other tickets group by ticket-type name.
 * Line amount is the exact stored money (packPrice - discount, or price x qty - discount for
 * singles) - never a rounded per-ticket share x quantity, so no line ever reads $50.01 (AC16).
 */
export const buildInvoiceDisplayLines = (lineItems = []) => {
  const packLines = new Map();   // packId -> line
  const singleLines = new Map(); // name  -> line
  const order = [];
  for (const li of lineItems) {
    const disc = li.discountAmount || 0;
    const seats = li.seats || [];
    if (li.pack && li.pack.id) {
      let line = packLines.get(li.pack.id);
      if (!line) {
        line = { name: li.ticketType?.name || 'Ticket', isPack: true, admits: 0, price: li.pack.price, discount: 0, amount: 0, seats: [] };
        packLines.set(li.pack.id, line); order.push(line);
      }
      line.admits += 1;
      line.discount = round2(line.discount + disc);
      line.seats.push(...seats);
      line.amount = round2(line.price - line.discount);
    } else {
      const key = li.ticketType?.name || 'Ticket';
      let line = singleLines.get(key);
      if (!line) {
        line = { name: key, isPack: false, quantity: 0, price: li.ticketType?.price || 0, discount: 0, amount: 0, seats: [] };
        singleLines.set(key, line); order.push(line);
      }
      line.quantity += (li.quantity || 1);
      line.discount = round2(line.discount + disc);
      line.seats.push(...seats);
      line.amount = round2(line.price * line.quantity - line.discount);
    }
  }
  return order;
};

/**
 * Group issued PaidTickets into human display lines for the sale emails (D8):
 *   - pack tickets (ticket.pack.id) collapse to one line per pack ("Type", admits N), priced at the
 *     pack's actual paid total (sum of its tickets' stored prices) - so a discounted pack still
 *     reconciles with the invoice total and never renders as N odd-cent lines (AC17);
 *   - single tickets group by type name.
 * Amounts are summed from each ticket's stored paid price, never price x quantity.
 */
export const summarizeSaleLines = (tickets = []) => {
  const packs = new Map();   // packId -> group
  const singles = new Map(); // name   -> group
  const order = [];
  for (const t of tickets) {
    const plain = t.toObject ? t.toObject() : t;
    const paid = plain.priceDetails?.totalPrice ?? plain.ticketType?.price ?? 0;
    const packId = plain.pack?.id;
    if (packId) {
      let g = packs.get(packId);
      if (!g) { g = { type: plain.ticketType?.name || 'Ticket', isPack: true, admits: 0, amount: 0 }; packs.set(packId, g); order.push(g); }
      g.admits += 1;
      g.amount = round2(g.amount + paid);
    } else {
      const name = plain.ticketType?.name || 'Ticket';
      let g = singles.get(name);
      if (!g) { g = { type: name, isPack: false, count: 0, amount: 0 }; singles.set(name, g); order.push(g); }
      g.count += 1;
      g.amount = round2(g.amount + paid);
    }
  }
  return order;
};