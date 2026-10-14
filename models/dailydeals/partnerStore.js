import mongoose from 'mongoose';

const partnerStoreSchema = new mongoose.Schema(
  {
    partnerstoreId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true
    },

    businessName: {
      type: String,
      required: true,
      trim: true
    },

    category: {
      type: String,
      required: true,
      trim: true
    },

    subcategory: {
      type: String,
      required: true,
      trim: true
    },

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

    contactInfo: {
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      website: { type: String, trim: true },
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

    logo: {
      url: { type: String },
      publicId: { type: String },
      originalFilename: { type: String }
    },

    description: {
      type: String,
      trim: true
    },

    isNationwide: {
      type: Boolean,
      default: false
    },

    isActive: {
      type: Boolean,
      default: true
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

partnerStoreSchema.index({ 'address.location': '2dsphere' });
partnerStoreSchema.index({ category: 1 });
partnerStoreSchema.index({ subcategory: 1 });
partnerStoreSchema.index({ isActive: 1 });
partnerStoreSchema.index({ isNationwide: 1 });
partnerStoreSchema.index({ businessName: 'text' });

const PartnerStore = mongoose.model('PartnerStore', partnerStoreSchema);

export default PartnerStore;
