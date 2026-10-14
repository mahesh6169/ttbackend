import mongoose from 'mongoose';
import { BANNER_STATUS, DESTINATION_TYPE, AU_STATES } from './bannerEnum.js';

// Destination sub-schema
const DestinationSchema = new mongoose.Schema({
  type: { 
    type: String, 
    enum: DESTINATION_TYPE, 
    required: true 
  },
  url: { 
    type: String, 
    required: false
  }
}, { _id: false });

// Image sub-schema - just URL and order for carousel images
const ImageSchema = new mongoose.Schema({
  imageUrl: { 
    type: String, 
    required: true
  },
  order: {
    type: Number,
    default: 0
  },
  originalFilename: {
    type: String,
    required: false
  }
}, { _id: false });

// Resolution sub-schema for desktop/mobile
const ResolutionSchema = new mongoose.Schema({
  images: {
    type: [ImageSchema],
    required: true,
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'At least one image is required'
    }
  },
  altText: {
    type: String,
    required: true
  },
  destination: {
    type: DestinationSchema,
    required: true
  }
}, { _id: false });

// Variant sub-schema for creative with separate desktop/mobile
const VariantSchema = new mongoose.Schema({
  desktop: {
    type: ResolutionSchema,
    required: true
  },
  mobile: {
    type: ResolutionSchema,
    required: false
  }
}, { _id: false });

const BannerAdSchema = new mongoose.Schema({
  adId: { 
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
  businessId: { 
    type: String, 
    required: true,
    ref: 'BannerBusiness'
  },
  placements: { 
    type: [String], 
    required: true,
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'At least one placement is required'
    }
  },
  
  targetStates: { 
    type: [String], 
    default: []
  },
  
  schedule: {
    startAt: { 
      type: Date, 
      required: true 
    },
    endAt: { 
      type: Date, 
      required: true
    }
  },
  
  status: { 
    type: String, 
    enum: BANNER_STATUS, 
    default: "paused",
    required: true
  },

  creative: {
    type: VariantSchema,
    required: true
  },


  caps: {
    maxImpressions: { 
      type: Number
    },
    maxClicks: { 
      type: Number
    }
  },

  counters: {
    impressions: { 
      type: Number, 
      default: 0
    },
    clicks: { 
      type: Number, 
      default: 0
    }
  }
}, { 
  timestamps: true 
});


// Indexes
BannerAdSchema.index({ status: 1, 'schedule.startAt': 1, 'schedule.endAt': 1 });
BannerAdSchema.index({ placements: 1 });
BannerAdSchema.index({ targetStates: 1 });
BannerAdSchema.index({ businessId: 1 });
BannerAdSchema.index({ 'counters.impressions': 1, 'caps.maxImpressions': 1 });
BannerAdSchema.index({ 'counters.clicks': 1, 'caps.maxClicks': 1 });

const BannerAd = mongoose.model('BannerAd', BannerAdSchema);
export default BannerAd;