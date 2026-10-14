// models/eventIdCounter.js
// Per-event sequence counter for human-readable ids (INV-/REF-). One document per event code,
// holding an independent running number for invoices and for refunds.
//
// Why this exists: the old approach scanned existing ids and took "the highest + 1", which (a) races
// under simultaneous buyers and (b) breaks past 9999 because ids were compared as TEXT. This counter
// hands out the next number via a single atomic increment, so two callers can never get the same number
// and there is no width ceiling. See designGuides/events-refactor/feature-stable-id-counter.md.
//
// IMPORTANT: this record is the OPPOSITE of a snapshot — it must never be deleted. Deleting it would
// reset the count and re-issue old numbers. The unique index on the id field remains as a backstop.
import mongoose from 'mongoose';

const eventIdCounterSchema = new mongoose.Schema({
  // Full event code, e.g. "EVT-AZAMW".
  eventCode: {
    type: String,
    required: true,
    unique: true
  },
  // Last-issued invoice sequence for this event (0 = none issued yet).
  invoiceSeq: {
    type: Number,
    default: 0
  },
  // Last-issued refund sequence for this event.
  refundSeq: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

/**
 * Atomically bump and return the next sequence number for an event.
 * Single-document update is atomic in MongoDB, so concurrent callers never collide.
 * @param {String} eventCode - full event code (e.g. "EVT-AZAMW")
 * @param {'invoice'|'refund'} kind - which sequence to advance
 * @returns {Promise<Number>} the new (post-increment) sequence value, starting at 1
 */
eventIdCounterSchema.statics.next = async function (eventCode, kind) {
  const field = kind === 'refund' ? 'refundSeq' : 'invoiceSeq';
  const doc = await this.findOneAndUpdate(
    { eventCode },
    { $inc: { [field]: 1 } },
    { new: true, upsert: true }
  );
  return doc[field];
};

const EventIdCounter = mongoose.model('EventIdCounter', eventIdCounterSchema);
export default EventIdCounter;
