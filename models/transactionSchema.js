import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
  {
    // 🔄 Core Relationships - KEEP
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    ticket: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'ticketType',
      required: true
    },
    ticketType: {
      type: String,
      required: true
    },
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    
    // 💰 Financial Data - SIMPLIFIED
    amount: {  // Renamed from grossAmount for simplicity
      type: Number,
      required: true,
      default: 0
    },
    currency: {
      type: String,
      default: 'AUD'
    },
    
    // 🏷️ Fee Info - SIMPLIFIED
    platformFee: {  // Single field instead of breakdown
      type: Number,
      default: 0
    },
    

    
    // 💳 Payment Information - ESSENTIAL ONLY
    stripePaymentIntentId: {
      type: String,
      index: true
    },
    paymentStatus: {
      type: String,
      default: 'pending',
      index: true
    },
    paymentDate: {
      type: Date
    },
    
    // ↩️ Refund Information - SIMPLIFIED
    refundAmount: {
      type: Number,
      default: 0
    },
    refundDate: {
      type: Date
    },
    
    // 🧾 Receipt - MINIMAL
    receiptUrl: {
      type: String
    },
    
    // Status Tracking
    status: {
      type: String,
      default: 'pending',
      index: true
    },
    
    // Simple Note
    note: String
  },
  { 
    timestamps: true 
  }
);

// Indexes
transactionSchema.index({ event: 1, createdAt: 1 });

// Add refund-specific indexes
transactionSchema.index({ event: 1, status: 1 });
transactionSchema.index({ refundDate: 1 });
transactionSchema.index({ stripePaymentIntentId: 1, refundAmount: 1 });

// Simple virtual to check if refunded
transactionSchema.virtual('isRefunded').get(function() {
  return this.refundAmount > 0;
});

const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;