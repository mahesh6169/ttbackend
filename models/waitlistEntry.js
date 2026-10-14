import mongoose from 'mongoose';

// One person on one event's waitlist. Created when a full-and-enabled event is joined.
// "Unnotified" is defined purely as notifiedAt == null - that single rule drives the send
// targeting and the unnotified count, and is what makes the two-day test pass by construction
// (a second send only ever sees entries still at null). See featureplans/events-waitlist.md.
const waitlistEntrySchema = new mongoose.Schema(
  {
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    // Optional contact details captured at join time (member session or the logged-out form).
    // Snapshot on the entry so the organiser's list shows them without touching user records.
    name: {
      type: String,
      trim: true,
      default: ''
    },
    mobile: {
      type: String,
      trim: true,
      default: ''
    },
    // Set when the joiner is a known user (member or guest record); null for an unmatched email.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    // Stamped when the organiser sends the "tickets available" email. null = not notified.
    notifiedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true } // createdAt is the joined-at time (arrival order = sort createdAt asc)
);

// One entry per email per event. A duplicate join hits this and is reported as already-on-list.
waitlistEntrySchema.index({ event: 1, email: 1 }, { unique: true });

const WaitlistEntry = mongoose.model('WaitlistEntry', waitlistEntrySchema);
export default WaitlistEntry;
