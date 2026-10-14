import mongoose from 'mongoose';

const advertSchema = new mongoose.Schema(
  {
    // Core fields
    title: { 
      type: String, 
      required: true,
      trim: true 
    },
    
    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    
    category: {
      type: String,
      trim: true
    },

    subcategory: {
      type: String,
      trim: true
    },

    description: {
      type: String,
      trim: true
    },

    // Contact information (all optional)
    contactInfo: {
      mobile: {
        type: String,
        trim: true,
        validate: {
          validator: function(v) {
            // Optional field - only validate if provided
            if (!v) return true;
            // Australian mobile: starts with 0, 10 digits
            return /^0\d{9}$/.test(v);
          },
          message: 'Mobile must be Australian format (10 digits starting with 0)'
        }
      },
      email: {
        type: String,
        trim: true,
        lowercase: true
      },
      website: {
        type: String,
        trim: true
      },
      socialMedia: {
        type: [{
          platform: {
            type: String,
            enum: ['Facebook', 'Instagram', 'X'],
            trim: true
          },
          url: {
            type: String,
            trim: true
          }
        }],
        validate: {
          validator: function(v) {
            return !v || v.length <= 3;
          },
          message: 'Maximum 3 social media links allowed'
        },
        default: []
      }
    },

    adType: { 
      type: String,
      default: 'offered'
    },
    
    // Condition field (promoted from dynamic fields)
    condition: {
      type: String,
      // enum removed to allow null/undefined for wanted ads
    },
    
    // Dynamic fields for category-specific data
    fields: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {}
    },
    
    // Flexible pricing without enums
    pricing: [{
      priceType: {
        type: String,
      },
      amount: {
        type: Number,
        min: 0,
        default: 0
      },
      unit: {
        type: String
      }
    }],
    
    // Images
    images: [{
      url: { type: String },
      publicId: { type: String },
      originalFilename: { type: String }
    }],
    
    // Address
    address: {
      formattedAddress: { type: String },
      streetNumber: { type: String },
      street: { type: String },
      suburb: { type: String },
      state: { type: String },
      postalCode: { type: String },
      location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] }
      }
    },
    
    // User reference
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    
    // Status
    status: {
      type: String,
      default: 'active'
    },
    
    // Communities/Languages
    communities: [{
      type: String,
      trim: true,
      lowercase: true
    }],
    
    // Simple expiry management
    expiresAt: { 
      type: Date,
      required: true
    },
    
    // Simple notification tracking
    notifications: {
      first: { type: Date, default: null },   // 14 days before expiry
      second: { type: Date, default: null },  // 7 days before expiry
      deleteEligible: { type: Date, default: null } // 7 days after second notification
    },
    
    // Featured ad placement
    featured: {
        isActive: { type: Boolean, default: false },
        expiresAt: { type: Date }
      },
    
    // Nationwide visibility
    isNationwide: {
      type: Boolean,
      default: false
    },

    // Curated listing identification (auto-set by backend when creator's email is in CURATOR_EMAILS)
    isCuratedListing: {
      type: Boolean,
      default: false
    },

    // Notification opt-in for wanted ads
    notifyOnWanted: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// Essential indexes only
advertSchema.index({ 'address.location': '2dsphere' });
advertSchema.index({ category: 1, subcategory: 1, status: 1 });
advertSchema.index({ postedBy: 1 });
advertSchema.index({ expiresAt: 1 });
advertSchema.index({ 'notifications.deleteEligible': 1 });
advertSchema.index({ 'featured.isActive': 1, 'featured.placement': 1 });
advertSchema.index({ title: 'text', description: 'text' });
advertSchema.index({ communities: 1 });

const Advert = mongoose.model('Advert', advertSchema);
export default Advert;