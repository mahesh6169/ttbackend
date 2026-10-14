import mongoose from 'mongoose';

const dailyDealSchema = new mongoose.Schema(
  {
    partnerstoreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PartnerStore',
      required: true
    },

    dealTitle: {
      type: String,
      required: true,
      trim: true
    },

    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true
    },

    description: {
      type: String,
      trim: true
    },

    terms: {
      type: String,
      trim: true
    },

    dealLink: {
      type: String,
      trim: true
    },

    whatsappOrders: {
      type: Boolean,
      default: false
    },

    whatsappNumber: {
      type: String,
      trim: true
    },

    validDays: [{
      type: String,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    }],

    startDate: {
      type: Date,
      required: true
    },

    endDate: {
      type: Date,
      required: true
    },

    images: [{
      url: { type: String },
      publicId: { type: String },
      originalFilename: { type: String }
    }],

    featured: {
      isActive: { type: Boolean, default: false },
      startDate: { type: Date },
      endDate: { type: Date }
    },

    isActive: {
      type: Boolean,
      default: true
    },

    // Online/Offline: admin-only publish switch (default true = listed publicly).
    // Offline hides the deal from browse/search but keeps its direct link reachable,
    // so an admin can preview a deal with a customer before launch. Independent of
    // isActive (which is the link kill-switch). Users never set this.
    isOnline: {
      type: Boolean,
      default: true
    },

    notifications: {
      createdEmailSent: { type: Boolean, default: false },
      reminderEmailSent: { type: Boolean, default: false },
      expiredEmailSent: { type: Boolean, default: false }
    },

    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Curated deal identification (auto-set when creator's email is in CURATOR_EMAILS)
    isCuratedDeal: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

dailyDealSchema.index({ partnerstoreId: 1 });
dailyDealSchema.index({ validDays: 1 });
dailyDealSchema.index({ endDate: 1 });
dailyDealSchema.index({ isActive: 1 });
dailyDealSchema.index({ isOnline: 1 });
dailyDealSchema.index({ 'featured.isActive': 1 });
dailyDealSchema.index({ dealTitle: 'text', description: 'text' });

const DailyDeal = mongoose.model('DailyDeal', dailyDealSchema);

export default DailyDeal;
