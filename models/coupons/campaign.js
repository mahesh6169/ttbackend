import mongoose from 'mongoose';

const campaignSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true
    },
    
    campaignName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    
    slug: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true
    },
    
    discount: {
      type: String,
      required: true,
      trim: true
    },
    
    discountProduct: {
      type: String,
      required: true,
      trim: true
    },
    
    termsConditions: {
      type: String,
      trim: true
    },
    
    expiryDate: {
      type: Date,
      required: true
    },

    // Recurring weekday pattern. Empty = valid every day. ENFORCED at redemption
    // (validate/redeem reject on a non-valid weekday, judged in the store's timezone).
    validDays: [{
      type: String,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    }],

    // Optional time windows (e.g. lunch + dinner happy hours). DISPLAY ONLY — never
    // enforced; the counter worker honours them by eye. Max 2 windows, shared across
    // all valid days. `end` earlier than `start` simply means the window crosses midnight.
    validHours: {
      type: [{
        start: { type: String, trim: true }, // "HH:MM" 24h
        end: { type: String, trim: true }
      }],
      validate: {
        validator: function(v) {
          return !v || v.length <= 2;
        },
        message: 'Maximum 2 time windows allowed'
      },
      default: []
    },

    isHidden: {
      type: Boolean,
      default: false
    },
    
    isActive: {
      type: Boolean,
      default: true
    },
    
    maxRedemptions: {
      type: Number,
      default: 0
    },
    
    totalGenerated: {
      type: Number,
      default: 0
    },
    
    totalRedeemed: {
      type: Number,
      default: 0
    },
    
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  {
    timestamps: true
  }
);

campaignSchema.index({ storeId: 1 });
campaignSchema.index({ expiryDate: 1 });
campaignSchema.index({ isActive: 1 });
campaignSchema.index({ isHidden: 1 });

const Campaign = mongoose.model('Campaign', campaignSchema);

export default Campaign;
