import mongoose from 'mongoose';
import { BUSINESS_STATUS, AU_STATES } from './bannerEnum.js';

const BannerBusinessSchema = new mongoose.Schema({
  businessId: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true
  },
  name: { 
    type: String, 
    required: true,
    trim: true 
  },
  contact: {
    email: { 
      type: String, 
      required: true, 
      lowercase: true, 
      trim: true
    },
    phone: { 
      type: String,
      trim: true
    }
  },
  abn: {
    type: String,
    trim: true
  },
  billingAddress: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { 
      type: String, 
      enum: ['', ...AU_STATES]  // Allow empty or valid state
    },
    postalCode: { type: String, trim: true }
  },
  status: { 
    type: String, 
    enum: BUSINESS_STATUS, 
    default: "active",
    required: true
  },
  billing: {
    notes: { 
      type: String
    }
  }
}, { 
  timestamps: true 
});

// Indexes
BannerBusinessSchema.index({ status: 1 });
BannerBusinessSchema.index({ 'contact.email': 1 });

const BannerBusiness = mongoose.model('BannerBusiness', BannerBusinessSchema);
export default BannerBusiness;