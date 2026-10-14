import mongoose from 'mongoose';

const couponCodeSchema = new mongoose.Schema(
  {
    fullCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true
    },
    
    storeIdentifier: {
      type: String,
      required: true,
      uppercase: true,
      trim: true
    },
    
    userCode: {
      type: String,
      required: true,
      trim: true
    },
    
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true
    },
    
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true
    },
    
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    
    isRedeemed: {
      type: Boolean,
      default: false
    },
    
    redeemedAt: {
      type: Date,
      default: null
    },
    
    generatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

couponCodeSchema.index({ userId: 1, campaignId: 1 }, { unique: true });
couponCodeSchema.index({ storeId: 1, userCode: 1 }, { unique: true });
couponCodeSchema.index({ campaignId: 1 });
couponCodeSchema.index({ isRedeemed: 1 });

const CouponCode = mongoose.model('CouponCode', couponCodeSchema);

export default CouponCode;
