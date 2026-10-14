import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    // 👤 Basic User Information
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      default: 'Guest',
      trim: true,
    },
    password: {
      type: String,
      required: function () {
        return this.role !== 'guest';
      },
      minlength: 4,
    },
    role: {
      type: String,
      default: 'user',
    },
    
    // 📱 Contact Information
    mobile: { 
      type: String, 
      trim: true 
    },
    
    // 📍 Location
    // Required for normal users; optional for a guest, who gives us only an email.
    // Same conditional pattern as password above. No borrowed/defaulted location data.
    suburb: {
      name: { type: String, required: function () { return this.role !== 'guest'; } },
      state: { type: String, required: function () { return this.role !== 'guest'; } },
      postalCode: { type: String, required: false, default: '' },  // Now optional
      location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], required: function () { return this.role !== 'guest'; } },
      },
    },
    
    // 👔 Organizer Profile
    organizerProfile: {
  businessName: String,
  businessType: String,
  abn: String,
  gstRegistered: {
    type: Boolean,
    default: false
  },
  bio: String,
  website: String,      // Add this
  phone: String,        // Add this
  emailId: String,      // Add this
},

    // 🏷️ Host Type Flags (sticky; see designGuides/02-Frontend-GUI/HostTypeFlags.md)
    // Set true when the user first posts each kind of event; never set back to false.
    freeHost: { type: Boolean, default: false },   // hosted RSVP / free-registration event
    paidHost: { type: Boolean, default: false },   // hosted ticketed (paid) event
    promoHost: { type: Boolean, default: false },  // advertise-only (promote) event

    // 💳 Payment & Financial
    stripeAccountStatus: {
  type: String,
  enum: [
    'no_account',
    'incomplete_setup', 
    'action_required',
    'account_restricted',
    'under_review',
    'capabilities_pending',
    'fully_active',
    'unknown'  // ADD this as catch-all
  ],
  default: 'no_account'
},
    stripeAccountId: { 
      type: String, 
      default: null 
    },    
    stripeDetailsSubmitted: { 
      type: Boolean, 
      default: false 
    },
    stripeChargesEnabled: { 
      type: Boolean, 
      default: false 
    },
    stripePayoutsEnabled: { 
      type: Boolean, 
      default: false 
    },
    stripeRequirementsCurrentlyDue: {
  type: [String],
  default: []
},
stripeRequirementsPastDue: {
  type: [String], 
  default: []
},
stripeRequirementsPendingVerification: {
  type: [String],
  default: []
},
    
    // 🔐 Account Security & Verification
    isAccountVerified: { 
      type: Boolean, 
      default: false 
    },
    verifyOtp: { 
      type: String, 
      default: '' 
    },
    verifyOtpExpireAt: { 
      type: Number, 
      default: 0 
    },
    resetOtp: { 
      type: String, 
      default: '' 
    },
    resetOtpExpireAt: { 
      type: Number, 
      default: 0 
    },
    
    // ❤️ User Preferences
    wishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Advert',
      },
    ],
    eventWishlist: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event',
      },
    ],
    
    // 🔔 Notifications
    chatNotifiedAt: { 
      type: Date, 
      default: null 
    },
    mutedThreads: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Thread',
      },
    ],
    threadNotifiedAt: { 
      type: Date, 
      default: null 
    },
    // Per-thread notification timestamps
    threadNotifyAtByThread: {
      type: Map,
      of: Date,
      default: new Map()
    },
    
    // 📜 Terms and Marketing
    acceptedTermsAt: { 
      type: Date, 
      default: null 
    },
    acceptedTermsVersion: { 
      type: String, 
      default: null 
    },
    marketingOptIn: { 
      type: Boolean, 
      default: false
    },

    // 🔗 Public organiser handle for /events/by/{slug} (featureplans/events-by-organiser.md). In v1 the
    // platform owner sets this by hand in the DB - there is no admin UI. Unique + sparse (most users have
    // none) and format-enforced (lowercase letters, numbers and dashes; no spaces or symbols), so a
    // hand-set value stays valid and never collides. lowercase normalises casing; the match rule rejects
    // spaces/symbols and leading/trailing/double dashes.
    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers and dashes only'],
    },

    // Optional social-share card for the public organiser page /events/by/{slug}
    // (featureplans/events-organiser-share-meta.md). All three are optional and hand-set in the DB
    // (no UI): when empty the page's generateMetadata falls back to defaults built from the
    // organiser name + the site default OG image. organiserShareImage is a plain URL string
    // (no uploader).
    organiserShareTitle: { type: String, trim: true },
    organiserShareDescription: { type: String, trim: true },
    organiserShareImage: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

// A guest has no suburb, but the schema still defaults suburb.location.type to 'Point'.
// That leaves a Point with a type but no coordinates, which the 2dsphere index below
// rejects on insert ("Can't extract geo keys"). Drop the half-built location whenever
// there are no valid coordinates, so the index skips the document instead of failing.
// Real users always carry coordinates, so this is a no-op for them.
userSchema.pre('save', function (next) {
  const coords = this.suburb?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) {
    this.set('suburb.location', undefined);
  }
  next();
});

// Indexes

userSchema.index({ 'suburb.location': '2dsphere' });
userSchema.index({ stripeAccountId: 1 });
userSchema.index({ stripeAccountStatus: 1 });
userSchema.index({ stripeRequirementsCurrentlyDue: 1 });
userSchema.index({ stripeRequirementsPastDue: 1 });
userSchema.index({ stripeRequirementsPendingVerification: 1 });

const User = mongoose.model('User', userSchema);
export default User;