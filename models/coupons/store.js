import mongoose from 'mongoose';

const storeSchema = new mongoose.Schema(
  {
    storeIdentifier: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      length: 5
    },
    
    storeName: {
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
      state: { type: String, required: true },
      postalCode: { type: String },
      location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], required: true }
      }
    },
    
    contactInfo: {
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true }
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
    
    isActive: {
      type: Boolean,
      default: true
    },
    
    isNationwide: {
      type: Boolean,
      default: false
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

storeSchema.index({ category: 1 });
storeSchema.index({ subcategory: 1 });
storeSchema.index({ 'address.location': '2dsphere' });
storeSchema.index({ 'address.state': 1 });
storeSchema.index({ isNationwide: 1 });
storeSchema.index({ isActive: 1 });
storeSchema.index({ storeName: 'text' });

const Store = mongoose.model('Store', storeSchema);

export default Store;
