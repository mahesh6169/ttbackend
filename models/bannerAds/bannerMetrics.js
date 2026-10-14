import mongoose from 'mongoose';
import { DEVICE_ENUM, AU_STATES } from './bannerEnum.js';

const BannerMetricsSchema = new mongoose.Schema({
  date: { 
    type: String, 
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/  // Format: YYYY-MM-DD
  },
  adId: { 
    type: String, 
    required: true,
    ref: 'BannerAd'
  },
  businessId: { 
    type: String,
    ref: 'BannerBusiness'
  },
  placementId: { 
    type: String, 
    required: true,
    ref: 'BannerPlacement'
  },
  state: { 
    type: String, 
    required: true,
    validate: {
      validator: function(state) {
        return AU_STATES.includes(state);
      },
      message: 'Invalid state code'
    }
  },
  device: { 
    type: String, 
    enum: DEVICE_ENUM 
  },
  impressions: { 
    type: Number, 
    default: 0,
    min: 0,
    required: true
  },
  clicks: { 
    type: Number, 
    default: 0,
    min: 0,
    required: true
  }
}, { 
  timestamps: true 
});

// Compound unique index for upserts
BannerMetricsSchema.index(
  { date: 1, adId: 1, placementId: 1, state: 1, device: 1 }, 
  { unique: true }
);

// Reporting indexes
BannerMetricsSchema.index({ date: 1, placementId: 1, state: 1 });
BannerMetricsSchema.index({ businessId: 1, date: 1 });
BannerMetricsSchema.index({ adId: 1, date: 1 });
BannerMetricsSchema.index({ date: -1 }); // For recent data queries

// TTL index to auto-delete old metrics after 2 years
BannerMetricsSchema.index({ createdAt: 1 }, { expireAfterSeconds: 63072000 }); // 730 days

const BannerMetrics = mongoose.model('BannerMetrics', BannerMetricsSchema);
export default BannerMetrics;