// A paid order between "buyer clicked Pay" and "tickets made / money released" (feature 1015).
// Written by create-payment-intent, so everything needed to make the tickets is on the server -
// not only in the buyer's browser. Either the browser (confirm-payment) or the Stripe webhook can
// then finish it; the status moves atomically so only one of them ever acts:
//   pending -> issuing -> done | released (| failed: charged in legacy immediate mode, not issued)
import mongoose from 'mongoose';

const pendingOrderSchema = new mongoose.Schema({
  paymentIntentId: { type: String, required: true, unique: true },
  stripeAccountId: { type: String, required: true },
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // 'hold' = card authorised, money taken only after the tickets exist (capture_method manual).
  // 'immediate' = charged at Pay (the checkout page from before feature 1015).
  captureMode: { type: String, enum: ['hold', 'immediate'], default: 'immediate' },

  tickets: { type: Object, required: true },            // { ticketTypeId: quantity }
  buyer: {
    firstName: String,
    lastName: String,
    email: String,
    phone: String,
    agreeToTerms: Boolean,
    refundPolicyAccepted: Boolean,
  },
  formResponses: { type: Object, default: undefined },  // { fieldName: response } as the checkout sends it
  seatIds: { type: [String], default: [] },

  // Prices locked at Pay: one entry per ticket, in issue order (planPackIssuance output).
  issuancePlan: { type: [Object], default: [] },
  subtotalCents: Number,
  discountCode: { type: String, default: '' },
  discountCents: { type: Number, default: 0 },
  totalAmountCents: Number,

  status: {
    type: String,
    enum: ['pending', 'issuing', 'done', 'released', 'failed'],
    default: 'pending',
  },
  issuingAt: Date,
  invoiceNumber: String,
  releaseReason: String,
  releasedAt: Date,
}, { timestamps: true });

pendingOrderSchema.index({ event: 1, user: 1, status: 1 });

export default mongoose.models.PendingOrder || mongoose.model('PendingOrder', pendingOrderSchema);
