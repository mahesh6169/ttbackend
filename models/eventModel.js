import mongoose from 'mongoose';

// Event coordinators schema
const coordinatorSchema = new mongoose.Schema(
  {
    name: String,
    role: String,
    phone: String,
    email: String
  },
  { _id: false }
);

// Event organizer schema
const organizerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    }, // "John Smith" or "Tech Conference Ltd"
    website: {
      type: String,
      trim: true
    }, // "https://techconf.com"
    contact: {
      type: String,
      trim: true
    }, // Phone number
    email: {
      type: String,
      trim: true,
      lowercase: true
    }, // Contact email
    abn: {
      type: String,
      trim: true,
      maxlength: 14
    }, // Australian Business Number for invoicing (paid events)
    socialMedia: [
      {
        platform: {
          type: String,
          trim: true
        }, // "Facebook", "Instagram", "LinkedIn", etc.
        url: {
          type: String,
          trim: true
        } // "https://facebook.com/techconf"
      }
    ]
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    // 🆔 Identification & Basic Info
    eventCode: {
      type: String,
      required: true,
      unique: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    description: {
      type: String,
      required: true
    },
    // Platform-owned SEO overrides for the public detail page (/events/[slug]).
    // Optional, never shown to or set by the organiser; populated via mongosh. Empty
    // means the detail page falls back to the organiser's title / a generated one-liner.
    // See designguide/06-seo/events.md.
    seoTitle: {
      type: String,
      trim: true
    },
    seoDescription: {
      type: String,
      trim: true
    },
    // Platform-owned canonical grouping: the id of the "hero" event this page should
    // canonical to, to collapse a multi-part event (e.g. a multi-day festival) onto one
    // page. Empty = self-canonical (the default). Set via mongosh; the page never gets
    // noindex when this is set. See designguide/06-seo/events.md.
    seoCanonicalEventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event'
    },
    category: {
      type: String,
    },
    // 🌍 Communities/Languages
    communities: [{
      type: String,
      trim: true,
      lowercase: true
    }],
    // 📅 Event Date & Time
    dateTime: {
      type: Date,
      required: true
    },
    timeZone: {
      type: String,
      default: 'Australia/Sydney'
    },

    // 📍 Location
    venue: {
      type: String,
      required: true,
      trim: true
    },
    address: {
      formattedAddress: { type: String, required: true },
      streetNumber: String,
      street: String,
      suburb: { type: String, required: true },
      state: { type: String, required: true },
      postalCode: { type: String, required: false, default: '' },  // Now optional
      location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
    },

    // 👥 Event Organization
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    organizer: organizerSchema, // NEW: Event organizer details
    coordinators: [coordinatorSchema],

    // 🔄 Recurring Event Settings
    recurrence: {
      isRecurring: {
        type: Boolean,
        default: false
      },
      repeatSchedule: [
        {
          day: {
            type: String,
            enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
          },
          time: {
            type: String, // format: "HH:mm", e.g. "18:30" (local time)
            match: /^\d{2}:\d{2}$/
          },
          // 🔧 ADD: UTC datetime field for backend processing
          utcDateTime: {
            type: String, // ISO string format, e.g. "2025-05-25T23:00:00.000Z"
            required: false // Optional for backward compatibility
          },
          // 🔧 ADD: Timezone reference
          timeZone: {
            type: String,
            default: 'Australia/Sydney'
          }
        }
      ],
      endDate: {
        type: Date,
        default: null
      },
      parentEventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event',
        default: null // Only set for child instances
      }
    },

    // 🖼️ Media
    images: [
      {
        url: String,
        publicId: String,
        originalFilename: String,
      },
    ],

    // 🎟️ General Ticketing
    isPaid: {
      type: Boolean,
      default: false
    },
    isAdvertiseOnly: {
      type: Boolean,
      default: false
    },

    // 📢 Event Intent & Promotional Settings
    eventIntent: {
      type: String,
      enum: ['promote', 'host'],
      default: 'host'
    },
    externalTicketUrl: {
      type: String,
      trim: true,
      default: ''  // External ticketing link for promotional events
    },
    isCuratedEvent: {
      type: Boolean,
      default: false  // Auto-set when creator's email is in CURATOR_EMAILS
    },

    capacity: {
      type: Number,
    },
    maxAttendeesPerRegistration: {
      type: Number,
    },

    // 🔒 Edit-locking signals (events-edit-locking.md D4). Set once by the server at the moment
    // activity happens; drive what the edit wizard locks (no computing in the browser). Only ever flip on.
    hasActivity: {
      type: Boolean,
      default: false // true after the event's first sale or first RSVP
    },
    hasSeating: {
      type: Boolean,
      default: false // true once a non-empty seat layout has been saved
    },

    // 🔍 Registration Fields
    registrationFields: [{
      // Stable question id (events-rsvp-question-editing.md D1): preserved across every save so an
      // answer can link to its question by id, which makes the text a display-only label. A question
      // saved without one (new, or before this feature) gets minted a qid on save by the finalizer.
      qid: String,
      fieldName: String,
      fieldType: String,
      fieldOptions: [String],
      isRequired: {
        type: Boolean,
        default: false
      },
      // Date questions only: also ask a time (one combined date-and-time answer).
      includeTime: {
        type: Boolean,
        default: false
      },
      // Blocking answers (events-rsvp-blocking-questions.md, free RSVP only). Dropdown-only: the option
      // VALUES that, if chosen, block the RSVP. A question can't block ALL its options; any blocking
      // option forces the question required. blockingMessage is the optional (<=150 char) reason shown.
      blockingOptions: {
        type: [String],
        default: undefined
      },
      blockingMessage: {
        type: String,
        maxlength: 150
      }
    }],

    // 💰 Paid Event Settings
    ticketTypes: [
      {
        name: { type: String, required: true },      // e.g., 'Early Bird', 'Standard', 'Group'
        price: { type: Number, required: true },     // Ticket price as typed. For a bundle type this IS the pack price (one price admits bundleSize people); split into per-ticket cents only at issuance. See featureplans/events-bundle-pricing.md.
        startDate: { type: Date },                   // When this ticket type becomes available
        expiryDate: { type: Date },                  // When this ticket type expires
        note: { type: String, trim: true, maxlength: 120, default: '' }, // Optional display-only note shown while choosing (e.g. "Includes dinner", "18+ only"). Never on issued tickets/emails/invoices.
        bundleSize: { type: Number, min: 2 },        // Bundle types only: one pack admits N people (empty = normal single ticket). Buyers see the pack price directly; every person's share stays >= $1.
        hasSold: { type: Boolean, default: false },  // Edit-locking signal (events-edit-locking.md D4/D8): true once THIS type sells one ticket; locks its price/bundle/name/delete.
        active: { type: Boolean, default: true },    // On sale (default). Turn OFF to stop selling this type immediately (buyers can't purchase it; already-issued tickets are unaffected). Deleting a sold type is blocked, so this is how an organiser retires it.
      }
    ],

    // 🏷️ Discount Codes (Paid Events Only) — see feature-add-discountcode.md S1
    discountCodes: [
      {
        code: { type: String, required: true },                 // stored trimmed + UPPERCASE; unique within the event
        kind: { type: String, enum: ['percent', 'fixed'], required: true },
        value: { type: Number, required: true },                // percent: 1–90 · fixed: dollars > 0
        maxUses: { type: Number, default: null },               // total orders; null = unlimited
        usedCount: { type: Number, default: 0 },                // orders redeemed (reporting)
        remainingUses: { type: Number, default: null },         // = maxUses at creation; atomically decremented at confirm; null = unlimited
        validFrom: { type: Date },                              // optional; blank = whole sale period
        validUntil: { type: Date },                             // optional
        active: { type: Boolean, default: true },               // on/off kill switch (discontinue)
        appliesToTicketTypes: [String],                         // ticket-type NAMES covered (explicit; ≥1 required when active)
        showHint: { type: Boolean, default: false },            // ON = public (hint on tickets page); OFF = secret
      }
    ],

    refundPolicy: {
      processingFeePolicy: {
        type: String,
        default: 'non-refundable' // 'refunded' or 'non-refundable'
      },
      policyText: {
        type: String,
        maxLength: 1000,
        required: false // Optional organizer notes
      },
      // Organiser's Terms & Conditions (events-terms-conditions.md): optional, longer than policyText.
      // Follows the refund policy through checkout, the confirmation email, and the ticket PDF/invoice.
      termsAndConditions: {
        type: String,
        maxLength: 2000,
        required: false
      }
    },
    // GST Configuration (Paid Events Only)
gstIncluded: {
  type: Boolean,
  default: false
}, // Whether ticket prices include GST

    // 💺 REFACTORED: Single Seating Layout System
    seatingLayout: [
      {
        rowLabel: String, // "A", "B", "C", etc.
        // Cosmetic-only visual aisles: "insert a gap after seat N" (whole numbers, 1..seatCount-1).
        // Absent/empty = no walkways. No seat data, never selectable, invisible to booking/capacity/
        // check-in. See featureplans/events-seat-walkways.md.
        walkwayPositions: [Number],
        seats: [
          {
            seatId: String,        // "A-1", "B-3" - unique identifier
            seatNumber: String,    // "1", "2", "3" - display number
            row: String,
            status: {
              type: String,
              // 'blocked' = organiser-marked not-for-sale (see featureplans/events-blocked-seats.md):
              // a real seat that is never sold or occupied. Distinct from 'reserved' (VIP hold) so the
              // expired-reservation cleanup never frees it.
              enum: ['available', 'selected', 'reserved', 'booked', 'blocked'],
              default: 'available'
            },
            // 🔒 Reservation fields - now at seat level
            reservedBy: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'User',
              default: null
            },
            reservedUntil: {
              type: Date,
              default: null
            },
            sessionId: {
              type: String,
              default: null // Browser session for cleanup
            },
          },
        ],
      },
    ],

    seatingLayoutImage: [{
      url: String,
      publicId: String,
      originalFilename: String,
    }],

    // 💲 Financial Settings
    stripeAccountId: {
      type: String
    },

     paymentProcessingEnabled: {
      type: Boolean,
      default: true 
    },

    // Platform fee per ticket (admin-configurable)
    platformFee: {
      type: Number,
      default: null,  // null means use system default
      min: 0         // Prevent negative fees
    },
    
    // Platform fee percentage (admin-configurable)
    platformFeePercentage: {
      type: Number,
      default: null,  // null means use system default percentage
      min: 0,        // Prevent negative percentages
      max: 10        // Maximum 10% percentage fee
    },

    // ADD THIS NEW FIELD:
    organizerReservedSeats: {
      type: String,
      default: '',
      trim: true
    }, // Stores user-friendly format like "A1,A5-A7"

    // Not-for-sale seats (events-blocked-seats.md): same user-friendly format as reserved, re-derived
    // on save into the 'blocked' seat status. A blocked seat lowers availability, not capacity.
    organizerBlockedSeats: {
      type: String,
      default: '',
      trim: true
    },

    // Whole-hall horizontal render flip (events-layout-tools.md): a render orientation flag only - the
    // builder and attendee map draw each row reversed and mirror the aisles; seat ids are never changed.
    seatingLayoutFlipH: {
      type: Boolean,
      default: false
    },

    // Organiser soft-delete (events-past-events.md): the organiser "delete" marks the event and hides it
    // from their manage list + the upcoming/discover lists, but KEEPS the doc and image so a past event
    // still renders publicly in Past events. The admin purge queue is the only hard delete. Defaults to
    // false/absent, so every existing event is correct with no migration.
    deletedByOrganiser: {
      type: Boolean,
      default: false
    },
    deletedByOrganiserAt: {
      type: Date,
      default: null
    },
    deletedByOrganiserBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },

    // Admin curation of the public "Past events" strip (events-past-events.md): a past event shows there
    // ONLY when an admin has featured it. Defaults off, so the strip is admin-picked, not automatic.
    featuredInPast: {
      type: Boolean,
      default: false
    },

    // Admin moderation hide (events-delete-retention.md D5-D7): a separate state from the organiser's
    // own soft-delete - a blocked event is public NOWHERE (not even where a soft-deleted event still
    // shows, like the Past strip), keeps its document and images, and carries no sold-ticket guard on
    // top (a scam event must be removable instantly). No reason field - who and when is enough. Defaults
    // to false/absent, so every existing event is correct with no migration.
    isBlocked: {
      type: Boolean,
      default: false
    },
    blockedAt: {
      type: Date,
      default: null
    },
    blockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },


    // ⚙️ System & Lifecycle
    status: {
  type: String,
  enum: ['active', 'expired'],
  required: true
},
    expiryDate: {
      type: Date,
      required: true
    },
    expiryNotificationSent: {
      type: Boolean,
      default: false
    },
    expiryNotificationSentAt: {
      type: Date,
      default: null
    },
    notify1SentAt: {
      type: Date,
      default: null
    },
    notify2SentAt: {
      type: Date,
      default: null
    },
    toBeDeleted: {
      type: Boolean,
      default: false
    },
    deleteEligibleDate: {
      type: Date,
      default: null
    },
    
    // Go Live Flag - controls event visibility on frontend
    goLive: {
      type: Boolean,
      default: true
    },

    // Waitlist toggle - when a full event has this ON, visitors join a waitlist instead of
    // bouncing. Default OFF; enabling is a deliberate per-event organiser choice.
    waitlistEnabled: {
      type: Boolean,
      default: false
    },

    // Demo flag - marks event as demo/test
    demo: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

// Indexes
eventSchema.index({ 'address.location': '2dsphere' });
eventSchema.index({ postedBy: 1 });
eventSchema.index({ status: 1 });
eventSchema.index({ dateTime: 1 });
eventSchema.index({ expiryDate: 1 });
eventSchema.index({ deleteEligibleDate: 1 });
eventSchema.index({ 'refundPolicy.processingFeePolicy': 1 });
eventSchema.index({ communities: 1 });

// 🔄 UPDATED: Seat management indexes for new structure
eventSchema.index({ 'seatingLayout.seats.seatId': 1 });
eventSchema.index({ 'seatingLayout.seats.row': 1 });
eventSchema.index({ 'seatingLayout.seats.status': 1 });
eventSchema.index({ 'seatingLayout.seats.reservedBy': 1 });
eventSchema.index({ 'seatingLayout.seats.sessionId': 1 });
eventSchema.index({ 'seatingLayout.seats.reservedUntil': 1 });

// NEW: Add organizer name index for searching events by organizer
eventSchema.index({ 'organizer.name': 1 });

eventSchema.index({ paymentProcessingEnabled: 1 });
eventSchema.index({ eventIntent: 1 });

const Event = mongoose.model('Event', eventSchema);
export default Event;