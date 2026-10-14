import mongoose from 'mongoose';

const reservationSchema = new mongoose.Schema({
  // Identity & Session
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
    index: true
  },
  
  // Seat information
  seatIds: [{
    type: String
  }],
  
  // Reservation status
  status: {
    type: String,
    enum: ['active', 'completed', 'expired', 'cancelled'],
    default: 'active',
    index: true
  },
  
  // Timing
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true
    // Regular index is created below for efficient querying
  },
  
  // Enhanced ticket details for checkout display
  tickets: [{
    ticketTypeId: mongoose.Schema.Types.ObjectId,
    ticketName: String,
    price: Number,        // for a bundle this is the PACK price (events-bundle-pricing.md D1)
    quantity: Number,     // people (a bundle line is a whole multiple of bundleSize)
    bundleSize: Number    // present only for bundle lines; lets checkout show "admits N" per pack
  }],
  
  // Simple pricing
  totalAmount: Number,
  
  // Buyer information (collected at checkout)
  buyerInfo: {
    firstName: String,
    lastName: String,
    email: String,
    phone: String
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
reservationSchema.index({ eventId: 1, userId: 1 });
reservationSchema.index({ eventId: 1, sessionId: 1 });

// Static method to find active reservation
reservationSchema.statics.findActiveReservation = async function(eventId, userId) {
  return this.findOne({
    eventId,
    userId,
    status: 'active',
    expiresAt: { $gt: new Date() }
  });
};

// Static method to cleanup expired reservations
reservationSchema.statics.cleanupExpired = async function() {
  const now = new Date();
  return this.updateMany(
    {
      expiresAt: { $lt: now },
      status: 'active'
    },
    {
      $set: { status: 'expired' }
    }
  );
};

// Instance method to check if reservation is active
reservationSchema.methods.isActive = function() {
  return this.status === 'active' && this.expiresAt > new Date();
};

// Regular index on expiresAt for efficient querying of expired reservations
// NOTE: We removed the TTL index ({ expireAfterSeconds: 0 }) because it was creating a race condition:
// MongoDB would delete reservations before cleanup functions could clean the associated seats
// Now cleanup functions handle both seat cleanup and reservation deletion together
reservationSchema.index({ expiresAt: 1 });

const Reservation = mongoose.model('Reservation', reservationSchema);
export default Reservation;