import mongoose from 'mongoose';

const paidTicketSchema = new mongoose.Schema(
  {

    // Event Detials from Event Schema
    eventSnapshot: {
      eventCode: String,
      title: String,
      description: String,
      dateTime: Date,
      timeZone: String,
      venue: String,
      address: String,
      category: String,
      communities: [String],
      organizer: {
        name: String,
        email: String,
        phone: String,
        website: String,
        abn: String
      },
      postedBy: String,
      isPaid: Boolean,
      capacity: Number,
      status: String,
      images: [{
        url: String,
        publicId: String
      }],
      refundPolicy: {
        processingFeePolicy: String,
        policyText: String,
        termsAndConditions: String
      },
      gstIncluded: Boolean,
      ticketTypes: [{
        name: String,
        price: Number,
        startDate: Date,
        expiryDate: Date
      }]
    },

    // 🎫 Ticket Information
    event: {
      type: String, // Store eventId as string
      required: true,
      index: true
    },
    ticketNumber: {
      type: String,
      required: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
    },
  
    // user account from where the ticket was purchased , object reference to User model
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    // 🏷️ Ticket Type & Pricing
    ticketType: {
      name: String,
      price: Number,       // this ticket's own price (its share of the pack, for a bundle)
      quantity: Number
    },

    // 📦 Pack tag (events-bundle-pricing.md D7): the N tickets issued from one bundle pack share a
    // pack id and the pack price. "admits N" is derived by counting tickets with the same pack.id -
    // never stored. Absent for single (non-bundle) tickets.
    pack: {
      id: String,          // shared across the pack's N tickets
      price: Number        // the pack (sticker) price the buyer saw
    },
    priceDetails: {
      basePrice: Number,     // original ticket-type price (pre-discount)
      totalPrice: Number,    // discounted price actually paid (= basePrice when no discount)
      discountCode: String   // discount code applied to the order, if any (discountAmount = basePrice − totalPrice)
    },

    // 💺 Seating Information
    seats: [
      {
        row: String,                  // ✅ Now matches seatingLayout.seats[].row
        seatNumber: String,           // ✅ Now matches seatingLayout.seats[].seatNumber
        seatId: String,               // ✅ Now matches seatingLayout.seats[].seatId
        ticketTypeId: String          // ✅ Now matches seatingLayout.seats[].ticketTypeId
      }
    ],

   // 👤 Purchaser & Attendee Information
    buyer: {
      firstName: String,
      lastName: String,
      email: String,
      phone: String,
      agreedToTerms: {
        type: Boolean,
        required: true,
        default: false
      },
      termsAgreedAt: {
        type: Date,
        required: true,
        default: Date.now
      },
    },

    // 👥 Attendee Details
    attendees: [
      {
        name: String,
        checkedIn: {
          type: Boolean,
          default: false
        },
        checkInTime: Date
      }
    ],

    // 📝 Form Responses. qid links the answer to its question (events-rsvp-question-editing.md D2);
    // fieldName is kept as the label asked under (id first, name fallback on display).
    formResponses: [{
      fieldName: String,
      qid: String,
      response: mongoose.Schema.Types.Mixed
    }],

    // 🔄 Check-in Status Information (Operational only, not financial)
    checkInStatus: {
      type: String,
      enum: ['confirmed', 'checked-in', 'cancelled'],
      default: 'confirmed',
      index: true
    },

    // 💳 Payment Details
    paymentIntentId: String,
    stripeAccountId: String,
    checkoutSessionId: String,
    paymentDate: Date,

    // 💰 Refund information
    refundStatus: {
      type: String,
      enum: ['none', 'partial', 'full'],
      default: 'none',
      index: true
    },
    totalRefundedAmount: {
      type: Number,
      default: 0
    },
    stripeRefundId: String,
    refundedAt: Date,
    refundedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // 🔄 Refund Policy Acceptance (Paid Events Only)
    refundPolicyAcceptance: {
      policyType: {
        type: String,
        required: true // 'refunded' or 'non-refundable'
      },
      policyText: {
        type: String,
        maxLength: 1000 // Copy of organizer's policy notes at time of purchase
      },
      termsAndConditions: {
        type: String,
        maxLength: 2000 // Organiser T&C at time of purchase (events-terms-conditions.md)
      },
      accepted: {
        type: Boolean,
        required: true,
        default: false // Did buyer tick the acknowledgment box
      },
      acceptedAt: {
        type: Date,
        required: true,
        default: Date.now // When they accepted the policy
      }
    },

    // ✅ Check-In Information
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // 📱 Communication
    confirmationSentAt: {
      type: Date,
      default: null
    },
    receiptSentAt: {
      type: Date,
      default: null
    },
    reminderSentAt: {
      type: Date,
      default: null
    },
    refundNotificationSentAt: {
      type: Date,
      default: null
    },
  },
  {
    timestamps: true
  }
);

// Indexes
paidTicketSchema.index({ event: 1, checkInStatus: 1 });
paidTicketSchema.index({ ticketNumber: 1 }, { unique: true });
paidTicketSchema.index({ invoiceNumber: 1 });
paidTicketSchema.index({ paymentIntentId: 1 });
paidTicketSchema.index({ stripeAccountId: 1 });

// Add refund-specific indexes for better performance
paidTicketSchema.index({ event: 1, refundStatus: 1 });
paidTicketSchema.index({ refundedBy: 1 });          // Changed from refundProcessedBy
paidTicketSchema.index({ refundedAt: 1 });          // Changed from refundProcessedDate
paidTicketSchema.index({ invoiceNumber: 1, refundStatus: 1 }); // For group refund queries

// Add refund policy acceptance index for efficient queries
paidTicketSchema.index({ 'refundPolicyAcceptance.policyType': 1 });
paidTicketSchema.index({ 'refundPolicyAcceptance.accepted': 1 });

const PaidTicket = mongoose.model('PaidTicket', paidTicketSchema);
export default PaidTicket;