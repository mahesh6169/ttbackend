import mongoose from 'mongoose';

const BannerPlacementSchema = new mongoose.Schema({
  placementId: { 
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
  dimensions: {
    desktop: {
      width: { type: Number },
      height: { type: Number }
    },
    mobile: {
      width: { type: Number },
      height: { type: Number }
    }
  },
  assignedAds: [{
    adId: {
      type: String,
      required: true
    },
    order: {
      type: Number,
      required: true
    },
    lastServed: {
      type: Date,
      default: null
    }
  }],
  rotationIndex: {
    type: Number,
    default: 0  // Points to which ad in assignedAds array to serve next
  }
}, { 
  timestamps: true 
});

// No additional indexes needed - placementId already has unique index

const BannerPlacement = mongoose.model('BannerPlacement', BannerPlacementSchema);
export default BannerPlacement;