import { BannerPlacement, BannerAd, BannerBusiness } from '../../models/bannerAds/index.js';

// Validate placements exist
export const validatePlacements = async (placements) => {
  const errors = [];
  
  for (const placementId of placements) {
    const placement = await BannerPlacement.findOne({ placementId });
    
    if (!placement) {
      errors.push(`Placement ${placementId} does not exist`);
    }
  }
  
  return errors;
};

// Validate ad schedule
export const validateSchedule = (startAt, endAt) => {
  const errors = [];
  const now = new Date();
  const start = new Date(startAt);
  const end = new Date(endAt);
  
  if (start >= end) {
    errors.push('End date must be after start date');
  }
  
  if (end < now) {
    errors.push('End date cannot be in the past');
  }
  
  return errors;
};

// Validate creative assets
export const validateCreative = (creative) => {
  const errors = [];
  
  // Check desktop exists (required)
  if (!creative.desktop) {
    errors.push('Desktop creative is required');
    return errors;
  }
  
  // Validate desktop has images
  if (!creative.desktop.images || creative.desktop.images.length === 0) {
    errors.push('Desktop must have at least one image');
  }
  
  // Validate Cloudinary URLs
  const cloudinaryRegex = /^https:\/\/res\.cloudinary\.com\/.+/;
  
  // Check desktop images
  creative.desktop.images?.forEach((img, idx) => {
    if (!cloudinaryRegex.test(img.imageUrl)) {
      errors.push(`Invalid Cloudinary URL for desktop image ${idx + 1}`);
    }
  });
  
  // Check mobile images if present
  creative.mobile?.images?.forEach((img, idx) => {
    if (!cloudinaryRegex.test(img.imageUrl)) {
      errors.push(`Invalid Cloudinary URL for mobile image ${idx + 1}`);
    }
  });
  
  // Check destination URLs
  if (!creative.desktop.destination?.url) {
    errors.push('No destination URL provided for desktop');
  }
  
  return errors;
};

// Generate unique IDs
export const generateBusinessId = async () => {
  const count = await BannerBusiness.countDocuments();
  return `BIZ-${String(count + 1).padStart(4, '0')}`;
};

export const generateAdId = () => {
  const randomStr = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `AD-${randomStr}`;
};

// Check if ad should be paused due to caps
export const checkAdCaps = (ad) => {
  const reasons = [];
  
  if (ad.caps?.maxImpressions && ad.counters?.impressions >= ad.caps.maxImpressions) {
    reasons.push(`Impression cap reached (${ad.counters.impressions}/${ad.caps.maxImpressions})`);
  }
  
  if (ad.caps?.maxClicks && ad.counters?.clicks >= ad.caps.maxClicks) {
    reasons.push(`Click cap reached (${ad.counters.clicks}/${ad.caps.maxClicks})`);
  }
  
  const now = new Date();
  if (new Date(ad.schedule.endAt) < now) {
    reasons.push('Schedule ended');
  }
  
  return {
    shouldPause: reasons.length > 0,
    reasons
  };
};