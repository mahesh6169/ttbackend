// utils/events/helperPaidEvent.js

import cloudinary from '../cloudinary.js';
import Event from '../../models/eventModel.js';

// Parse fields shared with free events
export { parseSharedFields, handleImageUploads, handleImageUpdates, generateEventCode, calculateExpiryDate, determineEventStatus } from './helperFreeEvent.js';

// Parse organizer reserved seats from user-friendly format like "A2,A4-A6,B1"
const parseReservedSeats = (reservedSeatsStr) => {
  if (!reservedSeatsStr || typeof reservedSeatsStr !== 'string') {
    return [];
  }

  const reservedSeats = [];
  const parts = reservedSeatsStr.split(',').map(part => part.trim()).filter(Boolean);

  parts.forEach(part => {
    if (part.includes('-')) {
      // Handle ranges like "A4-A6" (user format)
      const [start, end] = part.split('-').map(p => p.trim());
      const startMatch = start.match(/^([A-Z]+)(\d+)$/);
      const endMatch = end.match(/^([A-Z]+)(\d+)$/);
      
      if (startMatch && endMatch && startMatch[1] === endMatch[1]) {
        const row = startMatch[1];
        const startNum = parseInt(startMatch[2]);
        const endNum = parseInt(endMatch[2]);
        
        for (let i = startNum; i <= endNum; i++) {
          reservedSeats.push(`${row}-${i}`); // Store in internal format
        }
      }
    } else {
      // Handle individual seats like "A1" (user format)
      const match = part.match(/^([A-Z]+)(\d+)$/);
      if (match) {
        const row = match[1];
        const seatNum = match[2];
        reservedSeats.push(`${row}-${seatNum}`); // Store in internal format
      }
    }
  });

  return reservedSeats;
};

// Convert internal format reserved seats back to user-friendly format
// Example: ["A-1", "A-5", "A-6", "A-7", "A-10", "B-2"] → "A1,A5-A7,A10,B2"
const formatReservedSeatsForDisplay = (reservedSeatsArray) => {
  if (!Array.isArray(reservedSeatsArray) || reservedSeatsArray.length === 0) {
    return '';
  }

  // Group seats by row
  const seatsByRow = {};
  reservedSeatsArray.forEach(seatId => {
    const match = seatId.match(/^([A-Z]+)-(\d+)$/);
    if (match) {
      const row = match[1];
      const seatNum = parseInt(match[2]);
      if (!seatsByRow[row]) {
        seatsByRow[row] = [];
      }
      seatsByRow[row].push(seatNum);
    }
  });

  // Convert each row to user format
  const formattedParts = [];
  Object.keys(seatsByRow).sort().forEach(row => {
    const seats = seatsByRow[row].sort((a, b) => a - b);
    const ranges = [];
    let start = seats[0];
    let end = seats[0];

    for (let i = 1; i < seats.length; i++) {
      if (seats[i] === end + 1) {
        end = seats[i];
      } else {
        // End of current range
        if (start === end) {
          ranges.push(`${row}${start}`);
        } else {
          ranges.push(`${row}${start}-${row}${end}`);
        }
        start = seats[i];
        end = seats[i];
      }
    }

    // Add the last range
    if (start === end) {
      ranges.push(`${row}${start}`);
    } else {
      ranges.push(`${row}${start}-${row}${end}`);
    }

    formattedParts.push(...ranges);
  });

  return formattedParts.join(',');
};

// ✅ Parse + validate discount codes (feature-add-discountcode.md S1; server enforces V1–V6).
// Counter fields (usedCount/remainingUses) are SERVER-OWNED — this sets create-time defaults
// and IGNORES any counter values coming from the form. Edit-time counter reconciliation
// (preserve usedCount, enforce V4) is done by reconcileDiscountCounters in the update flow.
//
// @param {*} rawDiscountCodes - req.body.discountCodes (JSON string or array)
// @param {Array} ticketTypes  - the already-parsed ticketTypes (needed for V3 + V6)
// @returns {Array} normalized discountCodes ready for the schema
export const parseDiscountCodes = (rawDiscountCodes, ticketTypes) => {
  if (!rawDiscountCodes) return [];

  let codes;
  try {
    codes = typeof rawDiscountCodes === 'string' ? JSON.parse(rawDiscountCodes) : rawDiscountCodes;
  } catch (err) {
    throw new Error(`Invalid discountCodes: ${err.message}`);
  }
  if (!Array.isArray(codes)) throw new Error('Invalid discountCodes: expected an array');
  if (codes.length === 0) return [];

  const ticketTypeNames = new Set((ticketTypes || []).map((t) => t.name));
  const seen = new Set();

  return codes.map((dc, idx) => {
    const n = idx + 1;
    const code = (dc.code == null ? '' : String(dc.code)).trim().toUpperCase();

    // V1 — code present + unique within the event
    if (!code) throw new Error(`Discount code ${n}: code is required`);
    if (seen.has(code)) throw new Error(`Discount code ${n}: "${code}" is duplicated`);
    seen.add(code);

    // kind
    const kind = dc.kind === 'fixed' ? 'fixed' : dc.kind === 'percent' ? 'percent' : null;
    if (!kind) throw new Error(`Discount code ${code}: type must be 'percent' or 'fixed'`);

    // V2 — value range + at most 2 decimal places
    const value = Number(dc.value);
    if (dc.value === undefined || dc.value === null || dc.value === '' || isNaN(value)) {
      throw new Error(`Discount code ${code}: value is required`);
    }
    if (kind === 'percent') {
      if (value < 1 || value > 90) throw new Error(`Discount code ${code}: percent must be between 1 and 90`);
    } else if (value <= 0) {
      throw new Error(`Discount code ${code}: fixed amount must be greater than 0`);
    }
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) {
      throw new Error(`Discount code ${code}: value can have at most 2 decimal places`);
    }

    // maxUses — optional whole number >= 1; blank/null = unlimited
    let maxUses = null;
    if (dc.maxUses !== undefined && dc.maxUses !== null && dc.maxUses !== '') {
      maxUses = Number(dc.maxUses);
      if (!Number.isInteger(maxUses) || maxUses < 1) {
        throw new Error(`Discount code ${code}: max uses must be a whole number of 1 or more`);
      }
    }

    const active = dc.active !== false; // default true

    // validity window (stored as-is; comparisons happen at redemption — S3/S4)
    const validFrom = dc.validFrom && dc.validFrom !== '' ? new Date(dc.validFrom) : undefined;
    const validUntil = dc.validUntil && dc.validUntil !== '' ? new Date(dc.validUntil) : undefined;
    if (validFrom && isNaN(validFrom.getTime())) throw new Error(`Discount code ${code}: invalid "valid from" date`);
    if (validUntil && isNaN(validUntil.getTime())) throw new Error(`Discount code ${code}: invalid "valid until" date`);
    // V5 — from must be on or before until
    if (validFrom && validUntil && validFrom > validUntil) {
      throw new Error(`Discount code ${code}: "valid from" must be on or before "valid until"`);
    }

    // applies-to: explicit names only; drop any that no longer exist (server cascade safety-net)
    const appliesToTicketTypes = Array.isArray(dc.appliesToTicketTypes)
      ? [...new Set(dc.appliesToTicketTypes.filter((name) => ticketTypeNames.has(name)))]
      : [];

    // V3 — an ACTIVE code must cover at least one (existing) ticket type
    if (active && appliesToTicketTypes.length === 0) {
      throw new Error(`Discount code ${code}: an active code must apply to at least one ticket type`);
    }

    // V6 - the code may not drop any covered ticket, or any per-person share inside a covered
    // pack, below the flat $1 minimum (D3/D9). For a bundle the floor is checked on the per-person
    // share (packPrice / size); a fixed amount reduces each share by value / size. The message
    // names the offending ticket type and the minimum.
    if (appliesToTicketTypes.length > 0) {
      for (const t of (ticketTypes || [])) {
        if (!appliesToTicketTypes.includes(t.name)) continue;
        const size = t.bundleSize && t.bundleSize >= 2 ? t.bundleSize : 1;
        const perPerson = t.price / size;
        const afterDiscount = kind === 'percent'
          ? perPerson * (1 - value / 100)
          : perPerson - value / size;
        if (Math.round(afterDiscount * 100) < 100) {
          throw new Error(`Discount code ${code}: leaves ${t.name} under the $1 minimum per ticket - lower the discount or uncheck that ticket type`);
        }
      }
    }

    return {
      code,
      kind,
      value,
      maxUses,
      usedCount: 0,           // server-owned; reconciled on edit
      remainingUses: maxUses, // = maxUses at creation; reconciled on edit
      validFrom,
      validUntil,
      active,
      appliesToTicketTypes,
      showHint: dc.showHint === true || dc.showHint === 'true',
    };
  });
};

// ✅ Edit-time counter reconciliation (S1: counters are server-owned). Matches each parsed
// code to the existing one BY CODE, preserves its usedCount, enforces V4 (max uses can't drop
// below what's already been used), and recomputes remainingUses. New codes keep their defaults.
//
// @param {Array} parsedCodes   - output of parseDiscountCodes (create-time defaults)
// @param {Array} existingCodes - the event's current discountCodes (before this save)
// @returns {Array} codes with reconciled usedCount/remainingUses
export const reconcileDiscountCounters = (parsedCodes, existingCodes = []) => {
  const byCode = new Map((existingCodes || []).map((c) => [String(c.code).toUpperCase(), c]));
  return parsedCodes.map((dc) => {
    const prev = byCode.get(dc.code);
    const usedCount = prev ? prev.usedCount || 0 : 0;
    if (dc.maxUses != null && dc.maxUses < usedCount) {
      throw new Error(`Discount code ${dc.code}: ${usedCount} already used — max uses cannot be below ${usedCount}`);
    }
    const remainingUses = dc.maxUses == null ? null : dc.maxUses - usedCount;
    return { ...dc, usedCount, remainingUses };
  });
};

// ✅ Parse PAID event-specific fields (ticket types, seating, etc.)
export const parsePaidEventFields = (req) => {
  // Parse ticket types
  let ticketTypes = [];
  try {
    if (req.body.ticketTypes) {
      ticketTypes = typeof req.body.ticketTypes === 'string'
        ? JSON.parse(req.body.ticketTypes)
        : req.body.ticketTypes;
      
      if (!Array.isArray(ticketTypes) || ticketTypes.length === 0) {
        throw new Error('At least one ticket type is required');
      }
      
      // ✅ FIXED: Validation without quantity checks
      ticketTypes.forEach((ticket, idx) => {
        const ticketNum = idx + 1;
        
        // Name validation (required)
        if (!ticket.name || typeof ticket.name !== 'string' || !ticket.name.trim()) {
          throw new Error(`Ticket type ${ticketNum}: Name is required`);
        }
        
        // ✅ FIXED: Price validation (handle string from form data)
        if (ticket.price === undefined || ticket.price === null || ticket.price === '') {
          throw new Error(`Ticket type ${ticketNum}: Price is required`);
        }
        
        const price = Number(ticket.price);
        if (isNaN(price) || price < 1) {
          throw new Error(`Ticket type ${ticketNum}: Minimum ticket price is $1`);
        }
        // Any 2-decimal amount is allowed (D4); a 3rd decimal is rejected.
        if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-9) {
          throw new Error(`Ticket type ${ticketNum}: price can have at most 2 decimal places`);
        }

        // Bundle type: one price admits N people. bundleSize empty/absent = normal single ticket.
        // The `price` field IS the pack price the organiser typed and is stored as-is (D1); any
        // 2-decimal pack price is allowed (D2, the divides-evenly rule is gone). The only floor is
        // that every person's share stays at least $1 - packPrice / size >= 1 (D3).
        if (ticket.bundleSize !== undefined && ticket.bundleSize !== null && ticket.bundleSize !== '') {
          const bundleSize = Number(ticket.bundleSize);
          if (!Number.isInteger(bundleSize) || bundleSize < 2) {
            throw new Error(`Ticket type ${ticketNum}: bundle size must be a whole number of 2 or more`);
          }
          if (price / bundleSize < 1) {
            throw new Error(`Ticket type ${ticketNum}: each person's share must be at least $1`);
          }
        }

        // ✅ REMOVED: All quantity validation - no longer needed
        
        // ✅ Date validation (null is valid for optional dates)
        if (ticket.startDate !== null && ticket.startDate !== undefined && ticket.startDate !== '') {
          const startDate = new Date(ticket.startDate);
          if (isNaN(startDate.getTime())) {
            throw new Error(`Ticket type ${ticketNum}: Invalid start date format`);
          }
        }
        
        if (ticket.expiryDate !== null && ticket.expiryDate !== undefined && ticket.expiryDate !== '') {
          const expiryDate = new Date(ticket.expiryDate);
          if (isNaN(expiryDate.getTime())) {
            throw new Error(`Ticket type ${ticketNum}: Invalid expiry date format`);
          }
          
          // If both dates exist, validate that start < expiry
          if (ticket.startDate && ticket.startDate !== null && ticket.startDate !== '') {
            const startDate = new Date(ticket.startDate);
            if (startDate >= expiryDate) {
              throw new Error(`Ticket type ${ticketNum}: Start date must be before expiry date`);
            }
          }
        }
      });

      // ✅ FIXED: Process ticket types without quantity field
      ticketTypes = ticketTypes.map(ticket => {
        // The stored price IS what the organiser typed - the pack price for a bundle, the plain
        // price otherwise (D1). No save-time division; bundleSize is kept alongside.
        const hasBundle = ticket.bundleSize !== undefined && ticket.bundleSize !== null && ticket.bundleSize !== '';
        const bundleSize = hasBundle ? Number(ticket.bundleSize) : undefined;
        const enteredPrice = Number(ticket.price);
        return {
          name: ticket.name.trim(),
          price: enteredPrice,
          ...(hasBundle ? { bundleSize } : {}),
          // ✅ REMOVED: quantity field entirely
          startDate: ticket.startDate && ticket.startDate !== null && ticket.startDate !== ''
            ? new Date(ticket.startDate)
            : null,
          expiryDate: ticket.expiryDate && ticket.expiryDate !== null && ticket.expiryDate !== ''
            ? new Date(ticket.expiryDate)
            : null,
          // Optional display-only note, capped at 120 (mirror of the wizard cap).
          note: typeof ticket.note === 'string' ? ticket.note.trim().slice(0, 120) : '',
          // On sale by default; false = the organiser stopped selling this type (still shown to holders).
          active: ticket.active === false ? false : true,
        };
      });
    }
  } catch (err) {
    throw new Error(`Invalid ticketTypes: ${err.message}`);
  }

  // Server backstop (events-wizard-validation.md AC23): a paid event must have at least one ticket
  // type - reject even when the field is absent entirely (not just an empty array).
  if (!Array.isArray(ticketTypes) || ticketTypes.length === 0) {
    throw new Error('A paid event needs at least one ticket type');
  }
  // At least one type must be ON SALE - an event with every type stopped can't sell anything.
  if (!ticketTypes.some((t) => t.active !== false)) {
    throw new Error('At least one ticket type must be on sale');
  }

  // 🏷️ Parse discount codes (paid events only) — needs ticketTypes for V3/V6. Throws on
  // any V1/V2/V3/V5/V6 violation (caught by the controller → 400). Counter reconciliation
  // (V4 + usedCount preservation) happens on edit in the controller via reconcileDiscountCounters.
  const discountCodes = parseDiscountCodes(req.body.discountCodes, ticketTypes);

  // 🆕 NEW: Parse organizer reserved seats and store both formats
  let organizerReservedSeats = [];
  let organizerReservedSeatsUserFormat = '';
  
  try {
    if (req.body.organizerReservedSeats) {
      const reservedSeatsStr = typeof req.body.organizerReservedSeats === 'string'
        ? req.body.organizerReservedSeats
        : String(req.body.organizerReservedSeats);
      
      // Store the original user-friendly format for the new field
      organizerReservedSeatsUserFormat = reservedSeatsStr.trim();
      
      // Parse to internal format for seat status logic
      organizerReservedSeats = parseReservedSeats(reservedSeatsStr);
      console.log(`📋 Parsed ${organizerReservedSeats.length} organizer reserved seats:`, organizerReservedSeats);
      console.log(`📝 User format for storage: "${organizerReservedSeatsUserFormat}"`);
    }
  } catch (err) {
    console.warn("⚠️ Invalid organizerReservedSeats, using empty array:", err.message);
    organizerReservedSeats = [];
    organizerReservedSeatsUserFormat = '';
  }

  // Not-for-sale seats (events-blocked-seats.md): same user-friendly format + parser as reserved.
  let organizerBlockedSeats = [];
  let organizerBlockedSeatsUserFormat = '';
  try {
    if (req.body.organizerBlockedSeats) {
      const blockedSeatsStr = typeof req.body.organizerBlockedSeats === 'string'
        ? req.body.organizerBlockedSeats
        : String(req.body.organizerBlockedSeats);
      organizerBlockedSeatsUserFormat = blockedSeatsStr.trim();
      organizerBlockedSeats = parseReservedSeats(blockedSeatsStr); // same "A1, A4-A6" -> ["A-1",...] parse
    }
  } catch (err) {
    console.warn("⚠️ Invalid organizerBlockedSeats, using empty array:", err.message);
    organizerBlockedSeats = [];
    organizerBlockedSeatsUserFormat = '';
  }

// Parse seating layout and generate seatIds
let seatingLayout = [];
try {
  if (req.body.seatingLayout) {
    const rawLayout = typeof req.body.seatingLayout === 'string'
      ? JSON.parse(req.body.seatingLayout)
      : req.body.seatingLayout;

    if (Array.isArray(rawLayout)) {
      // Cosmetic walkway gaps: "insert a gap after seat N". Keep only whole numbers in 1..seatCount-1,
      // deduped and sorted; anything else (out of range, non-integer, absent) yields none.
      // See featureplans/events-seat-walkways.md. This never touches seat data.
      const sanitizeWalkways = (raw, seatCount) => {
        if (!Array.isArray(raw)) return [];
        return [...new Set(
          raw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= seatCount - 1)
        )].sort((a, b) => a - b);
      };

      // ✅ FIRST: Process the seating layout to add seatIds and row fields
      seatingLayout = rawLayout.map(row => ({
        ...row,
        walkwayPositions: sanitizeWalkways(row.walkwayPositions, Array.isArray(row.seats) ? row.seats.length : 0),
        seats: row.seats.map(seat => {
          const seatId = `${row.rowLabel}-${seat.seatNumber}`;

          return {
            ...seat,
            seatId,
            seatNumber: seat.seatNumber,
            row: row.rowLabel,
            // Keep original status for now - we'll update reserved seats later
          };
        })
      }));

      // ✅ SECOND: Validate that organizer isn't trying to reserve already booked seats
      if (organizerReservedSeats.length > 0) {
  const bookedSeats = [];
  seatingLayout.forEach(row => {
    if (row.seats && Array.isArray(row.seats)) {
      row.seats.forEach(seat => {
        const seatId = `${row.rowLabel}-${seat.seatNumber}`;
        if (seat.status === 'booked' && organizerReservedSeats.includes(seatId)) {
          // Convert back to user-friendly format for error message
          bookedSeats.push(`${row.rowLabel}${seat.seatNumber}`);
        }
      });
    }
  });
  
  if (bookedSeats.length > 0) {
    const seatList = bookedSeats.join(', ');
    throw new Error(`Cannot reserve seats that are already booked by customers. Please remove ${seatList} from your reserved seats list.`);
  }
}

      // ✅ SECOND-b: A booked seat cannot be marked not-for-sale (events-blocked-seats.md D9 / AC5).
      if (organizerBlockedSeats.length > 0) {
        const bookedBlocked = [];
        seatingLayout.forEach(row => {
          if (row.seats && Array.isArray(row.seats)) {
            row.seats.forEach(seat => {
              const seatId = `${row.rowLabel}-${seat.seatNumber}`;
              if (seat.status === 'booked' && organizerBlockedSeats.includes(seatId)) {
                bookedBlocked.push(`${row.rowLabel}${seat.seatNumber}`);
              }
            });
          }
        });
        if (bookedBlocked.length > 0) {
          const seatList = bookedBlocked.join(', ');
          throw new Error(`Cannot mark seats that are already booked as not for sale. Please remove ${seatList} from your not-for-sale list.`);
        }
      }

// ✅ THIRD: Apply organizer reservations + not-for-sale blocks, and clear old ones.
      seatingLayout = seatingLayout.map(row => ({
        ...row,
        seats: row.seats.map(seat => {
          const seatId = `${row.rowLabel}-${seat.seatNumber}`;
          const isCurrentlyReserved = organizerReservedSeats.includes(seatId);
          const isCurrentlyBlocked = organizerBlockedSeats.includes(seatId);

          // Check if this seat was previously reserved by organizer
          const wasPreviouslyReservedByOrganizer = seat.status === 'reserved' &&
            seat.reservedBy &&
            seat.reservedBy.toString() === req.user._id.toString() &&
            seat.reservedUntil === null; // Organizer reservations have null expiry
          const wasPreviouslyBlocked = seat.status === 'blocked';

          // Determine new status. Blocked wins over reserved (a not-for-sale seat is never a VIP hold);
          // a booked seat is in neither list (guarded above) so it stays booked.
          let newStatus = seat.status;
          let newReservedBy = seat.reservedBy;
          let newReservedUntil = seat.reservedUntil;
          let newSessionId = seat.sessionId;

          if (isCurrentlyBlocked) {
            // Mark this seat not-for-sale
            newStatus = 'blocked';
            newReservedBy = null;
            newReservedUntil = null;
            newSessionId = null;
          } else if (isCurrentlyReserved) {
            // Reserve this seat for organizer
            newStatus = 'reserved';
            newReservedBy = req.user._id;
            newReservedUntil = null;
            newSessionId = null;
          } else if (wasPreviouslyBlocked) {
            // Was not-for-sale but no longer in the list - unblock it
            newStatus = 'available';
            newReservedBy = null;
            newReservedUntil = null;
            newSessionId = null;
          } else if (wasPreviouslyReservedByOrganizer) {
            // This seat was reserved by organizer but is no longer in the list - unreserve it
            newStatus = 'available';
            newReservedBy = null;
            newReservedUntil = null;
            newSessionId = null;
          }

          return {
            ...seat,
            status: newStatus,
            reservedBy: newReservedBy,
            reservedUntil: newReservedUntil,
            sessionId: newSessionId
          };
        })
      }));
    }
  }
} catch (err) {
  // ❌ DON'T clear seatingLayout on validation errors!
  // Instead, throw the error to be handled by the calling function
  throw new Error(`Seating layout error: ${err.message}`);
}

  // Parse financial fields
  const stripeAccountId = req.body.stripeAccountId || '';

  // Seating layout images - now supports multiple images
  let seatingLayoutImage = [];
  try {
    if (req.body.existingSeatingLayoutImages) {
      const parsed = typeof req.body.existingSeatingLayoutImages === 'string'
        ? JSON.parse(req.body.existingSeatingLayoutImages)
        : req.body.existingSeatingLayoutImages;
      seatingLayoutImage = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch (err) {
    seatingLayoutImage = [];
  }

  // Parse refund policy (paid events only)
  let refundPolicy = {
    processingFeePolicy: 'non-refundable', // default
    policyText: '',
    termsAndConditions: ''
  };

  try {
    if (req.body.refundPolicy) {
      const refundPolicyData = typeof req.body.refundPolicy === 'string'
        ? JSON.parse(req.body.refundPolicy)
        : req.body.refundPolicy;
      
      // Validate processingFeePolicy
      if (refundPolicyData.processingFeePolicy) {
        const policy = refundPolicyData.processingFeePolicy;
        if (policy === 'refunded' || policy === 'non-refundable') {
          refundPolicy.processingFeePolicy = policy;
        }
      }
      
      // Validate policyText (optional)
      if (refundPolicyData.policyText && typeof refundPolicyData.policyText === 'string') {
        refundPolicy.policyText = refundPolicyData.policyText.trim().substring(0, 1000); // Limit to 1000 chars
      }

      // Validate termsAndConditions (optional, longer - events-terms-conditions.md)
      if (refundPolicyData.termsAndConditions && typeof refundPolicyData.termsAndConditions === 'string') {
        refundPolicy.termsAndConditions = refundPolicyData.termsAndConditions.trim().substring(0, 2000); // 2000 cap
      }
    }
  } catch (err) {
    console.warn("⚠️ Invalid refundPolicy, using defaults:", err.message);
    // Keep defaults
  }

  // Parse GST configuration (paid events only)
  let gstIncluded = false;
  try {
    if (req.body.gstIncluded !== undefined) {
      gstIncluded = req.body.gstIncluded === 'true' || req.body.gstIncluded === true;
    }
  } catch (err) {
    console.warn("⚠️ Invalid gstIncluded, using default false:", err.message);
    gstIncluded = false;
  }

  return {
    ticketTypes,
    discountCodes, // 🏷️ create-time defaults; update flow reconciles counters
    seatingLayout,
    stripeAccountId,
    seatingLayoutImage,
    refundPolicy,
    gstIncluded,
    organizerReservedSeats, // Internal format array (for backwards compatibility)
    organizerReservedSeatsUserFormat, // 🆕 NEW: User-friendly format string for the schema field
    organizerBlockedSeats, // Internal format array (not-for-sale)
    organizerBlockedSeatsUserFormat, // User-friendly format string for the schema field
    // Whole-hall horizontal render flip (events-layout-tools.md): a boolean render flag.
    seatingLayoutFlipH: req.body.seatingLayoutFlipH === 'true' || req.body.seatingLayoutFlipH === true,
  };
};

// A bundle whose size is larger than the event's max-tickets-per-order can never be bought
// (one order can't hold a whole pack). Throws on any such bundle. Runs on create AND edit against
// the current per-order limit, so it also blocks lowering the limit below a live bundle's size.
// See featureplans/events-bundle-ticket.md (AC4, AC5).
export const assertBundlesFitPerRegistration = (ticketTypes, maxPerRegistration) => {
  const limit = Number(maxPerRegistration);
  if (!Number.isFinite(limit) || limit <= 0) return; // no meaningful per-order cap to check against
  for (const t of ticketTypes || []) {
    if (t.bundleSize && t.bundleSize > limit) {
      throw new Error(
        `A bundle that admits ${t.bundleSize} can't be sold when the maximum tickets per order is ${limit}. ` +
        `Increase the per-order limit or reduce the bundle size.`
      );
    }
  }
};

// Handle seating layout images upload (now supports multiple)
export const handleSeatingLayoutImageUpload = async (req) => {
  const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';
  const maxImages = 4;
  
  console.log('🪑 handleSeatingLayoutImageUpload called');
  console.log('🪑 req.files structure:', req.files ? Object.keys(req.files) : 'No files');
  console.log('🪑 req.body.existingSeatingLayoutImages:', req.body.existingSeatingLayoutImages);
  
  try {
    const uploadedImages = [];
    
    // Check if there are new file uploads
    // When using .fields(), seating images are in a separate object
    let seatingImageFiles = [];
    
    if (req.files) {
      if (Array.isArray(req.files)) {
        // Legacy format - filter by fieldname
        console.log('🪑 Files is array format');
        seatingImageFiles = req.files.filter(file => file.fieldname === 'seatingLayoutImageFiles');
      } else if (req.files.seatingLayoutImageFiles) {
        // New format - direct access
        console.log('🪑 Files has seatingLayoutImageFiles property');
        seatingImageFiles = req.files.seatingLayoutImageFiles;
      }
    }
    
    console.log('🪑 Seating image files found:', seatingImageFiles.length);
      
      if (seatingImageFiles.length > maxImages) {
        throw new Error(`Maximum ${maxImages} seating layout images allowed`);
      }
      
      for (const file of seatingImageFiles) {
        if (file && file.size > 0) {
          console.log('📤 Uploading seating layout image:', file.originalname);
          
          // Validate file type
          const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
          if (!allowedTypes.includes(file.mimetype)) {
            throw new Error('Seating layout image: Only JPEG, PNG, and WebP formats are allowed');
          }

          // Validate file size (10MB max)
          const maxSize = 10 * 1024 * 1024;
          if (file.size > maxSize) {
            throw new Error('Each seating layout image must be less than 10MB');
          }
          
          // Upload to Cloudinary
          const result = await cloudinary.uploader.upload(
            `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
            {
              folder: `${folderName}/events/seating`,
              transformation: [{ fetch_format: 'auto', quality: 'auto:good' }]
            }
          );

          console.log('✅ Seating layout image uploaded:', result.public_id);
          
          uploadedImages.push({
            url: result.secure_url,
            publicId: result.public_id,
            originalFilename: file.originalname
          });
        }
      }
    
    // Check if there are existing images metadata
    let existingImages = [];
    if (req.body.existingSeatingLayoutImages) {
      const parsed = typeof req.body.existingSeatingLayoutImages === 'string'
        ? JSON.parse(req.body.existingSeatingLayoutImages)
        : req.body.existingSeatingLayoutImages;
      existingImages = Array.isArray(parsed) ? parsed : [parsed];
    }
    
    // Combine uploaded and existing images
    const allImages = [...existingImages, ...uploadedImages];
    
    // Ensure we don't exceed max limit
    if (allImages.length > maxImages) {
      throw new Error(`Maximum ${maxImages} seating layout images allowed`);
    }
    
    return allImages.length > 0 ? allImages : null;
  } catch (error) {
    console.error('❌ Seating layout images upload error:', error);
    throw error;
  }
};

// Handle seating layout images update (with deletion of old images)
export const handleSeatingLayoutImageUpdate = async (req, existingImages) => {
  const FALLBACK_PUBLIC_ID = process.env.FALLBACK_EVENT_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';
  
  try {
    // Upload new images if provided
    const newImages = await handleSeatingLayoutImageUpload(req);
    
    // If we have new images, we need to handle old images deletion
    if (newImages && newImages.length > 0) {
      // Get list of images to keep (from existing images that are still in the new list)
      const existingImagesArray = Array.isArray(existingImages) ? existingImages : (existingImages ? [existingImages] : []);
      const imagesToKeep = newImages.filter(newImg => 
        existingImagesArray.some(oldImg => oldImg.publicId === newImg.publicId)
      );
      
      // Delete old images that are not in the new list
      const imagesToDelete = existingImagesArray.filter(oldImg => 
        !newImages.some(newImg => newImg.publicId === oldImg.publicId) &&
        oldImg.publicId !== FALLBACK_PUBLIC_ID
      );
      
      for (const img of imagesToDelete) {
        try {
          await cloudinary.uploader.destroy(img.publicId);
          console.log('🗑️ Deleted old seating layout image:', img.publicId);
        } catch (err) {
          console.error('⚠️ Failed to delete old seating image:', err.message);
        }
      }
    }
    
    return newImages || existingImages;
  } catch (error) {
    console.error('❌ Seating layout images update error:', error);
    throw error;
  }
};

// Export the display formatting function
export { formatReservedSeatsForDisplay };