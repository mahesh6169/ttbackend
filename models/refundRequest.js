import mongoose from 'mongoose';

const refundRequestSchema = new mongoose.Schema(
  {
    // Unique identifier
    refundRequestId: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    
    // References (stored as strings for independence)
    eventId: {
      type: String,
      required: true,
      index: true
    },
    ticketNumbers: {
      type: [String],
      required: true,
      validate: {
        validator: function(v) {
          return v && v.length > 0;
        },
        message: 'At least one ticket number required'
      },
      index: true
    },
    invoiceNumber: {
      type: String,
      required: true,
      index: true
    },
    
    // Event Snapshot (for data preservation after event deletion)
    eventSnapshot: {
      eventCode: String,
      title: String,
      dateTime: Date,
      timeZone: String,
      venue: String,
      address: String,
      organizer: {
        name: String,
        email: String,
        abn: String
      }
    },
    
    // Financial data
    refundAmounts: {
      type: Map,
      of: Number,
      required: true
    },
    totalAmount: {
      type: Number,
      required: true,
      min: [0, 'Total amount must be greater than 0'],
      validate: {
        validator: function(v) {
          return v > 0;
        },
        message: 'Total amount must be greater than 0'
      }
    },
    
    // Status tracking (THE LOCK for concurrent protection)
    status: {
      type: String,
      enum: {
        values: ['pending', 'processing_stripe', 'completed', 'failed'],
        message: '{VALUE} is not a valid status'
      },
      default: 'pending',
      required: true,
      index: true
    },
    
    // Results
    stripeRefundId: {
      type: String,
      default: null
    },
    seatsReleased: {
      type: Number,
      default: 0,
      min: 0
    },
    errorMessage: {
      type: String,
      default: null
    },
    
    // Prepared changes (applied ONLY after Stripe succeeds)
    refundSuccessData: {
      ticketsToUpdate: [{
        ticketNumber: String,
        currentStatus: String,
        newStatus: String
      }],
      seatsToRelease: [{
        ticketNumber: String,
        seats: [{
          seatId: String,
          row: String,
          seatNumber: String,
          currentStatus: String,
          newStatus: String
        }]
      }]
    },
    
    // Audit
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    requestedByName: {
      type: String,
      required: true
    },
    reason: {
      type: String,
      default: ''
    },
    completedAt: {
      type: Date,
      default: null
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

// Indexes for performance (refundRequestId already indexed via unique: true)
refundRequestSchema.index({ status: 1, createdAt: -1 });
refundRequestSchema.index({ eventId: 1, status: 1 });
refundRequestSchema.index({ 'eventSnapshot.eventCode': 1 });

const RefundRequest = mongoose.model('RefundRequest', refundRequestSchema);
export default RefundRequest;
