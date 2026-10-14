// models/eventInvoiceModel.js
import mongoose from 'mongoose';

const eventInvoiceSchema = new mongoose.Schema({
  // 🆔 Invoice Identity (Australian Invoice Requirements)
  invoiceNumber: {
    type: String,
    required: true,
    unique: true
  },
  
  // 🎯 Core Relationships (as strings for independence like PaidTicket)
  event: {
    type: String, // Store as string like paidTicket.js does
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', 
    required: true
  },
  
  // 📋 Event Snapshot (complete denormalized data - same structure as PaidTicket)
  eventSnapshot: {
    eventCode: String,
    title: String,
    description: String,
    dateTime: Date,
    timeZone: String,
    venue: String,
    address: String, // Full formatted address
    category: String,
    communities: [String],
    organizer: {
      name: String,
      email: String,
      phone: String,
      website: String,
      abn: String
    },
    postedBy: String, // Store as string like PaidTicket
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
  
  // 👤 Buyer Information (Australian Invoice Requirement - Customer Details)
  buyer: {
    firstName: String,
    lastName: String,
    email: String,
    phone: String
  },
  
  // 🎫 Invoice Line Items (original purchase - never modified)
  lineItems: [{
    ticketNumber: String,
    ticketType: {
      name: String,
      price: Number
    },
    // Pack tag (events-bundle-pricing.md D7/D8): set on each ticket issued from a bundle pack so the
    // invoice API can collapse a pack's N rows into one "admits N" line at the pack price. Absent for
    // single tickets.
    pack: {
      id: String,
      price: Number
    },
    quantity: {
      type: Number,
      default: 1
    },
    // This ticket's share of the order discount, in dollars (S4-D split). 0 when no discount
    // covered this ticket. Lets the invoice show a per-row Discount column + net Amount.
    discountAmount: {
      type: Number,
      default: 0
    },
    seats: [{
      row: String,
      seatNumber: String,
      seatId: String
    }],
    attendeeName: String
  }],
  
  // 💰 Financial Summary (Simple totals only)
  amounts: {
    total: Number, // Total amount paid (discounted total — what was charged)
    subtotal: Number, // NEW: pre-discount sum of line items (= total when no discount)
    discount: {       // NEW: discount applied to this order (absent when no discount)
      code: String,
      amount: Number
    },
    totalRefunded: {
      type: Number,
      default: 0
    },
    netAmount: { // Current amount after refunds (total - totalRefunded)
      type: Number,
      required: true
    }
  },
  
  // 🏢 Simple Display Flags (same as PaidTicket)
  gstIncluded: {
    type: Boolean,
    default: false
  },
  
  // 🔄 Refund Policy Display (captured at time of purchase)
  refundPolicy: {
    processingFeePolicy: {
      type: String
    },
    policyText: {
      type: String,
      maxLength: 1000
    },
    termsAndConditions: {
      type: String,
      maxLength: 2000
    }
  },
  
  // 💳 Payment Information (for audit trail)
  payment: {
    paymentIntentId: String,
    stripeAccountId: String,
    paymentDate: Date,
    currency: {
      type: String,
      default: 'AUD'
    }
  },
  
   // 🔄 Refund History
  refunds: [{
    ticketNumber: String,         // Ticket number for this refund
    refundRequestId: String,      // Human-readable refund id (REF-YYYYMMDD-NNN) from RefundRequest; buyer-facing
    ticketNumbers: {             // Legacy field - no longer used
        type:[String],
      default: undefined
          },
    refundAmount: Number,
    refundDate: {
      type: Date,
      default: Date.now
    },
    stripeRefundId: String,
    reason: String,
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  
  // 📊 Invoice Status
  status: {
    type: String,
    enum: ['paid', 'partially_refunded', 'fully_refunded'],
    default: 'paid'
  },
  
  // 📅 Important Dates (Australian Invoice Requirement)
  invoiceDate: {
    type: Date,
    required: true,
    default: Date.now
  }
  
}, {
  timestamps: true
});

// Essential Indexes
eventInvoiceSchema.index({ user: 1, createdAt: -1 });
eventInvoiceSchema.index({ event: 1, createdAt: -1 });
// Fix #1 (idempotency): at most ONE invoice (= one order) per Stripe payment intent.
// A double-submit/retry that races past the in-handler pre-check trips this unique index
// instead of creating duplicate tickets. Partial filter so legacy/missing values never
// collide on null. NOTE: an existing NON-unique index on this key must be dropped first —
// Mongo cannot upgrade an index in place. See platform-fixes.md Fix #1 "Migration".
eventInvoiceSchema.index(
  { 'payment.paymentIntentId': 1 },
  { unique: true, partialFilterExpression: { 'payment.paymentIntentId': { $type: 'string' } } }
);


const EventInvoice = mongoose.model('EventInvoice', eventInvoiceSchema);
export default EventInvoice;