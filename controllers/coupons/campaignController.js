import asyncHandler from 'express-async-handler';
import Campaign from '../../models/coupons/campaign.js';
import Store from '../../models/coupons/store.js';
import CouponCode from '../../models/coupons/couponCode.js';
import { campaignCreatedNotification, campaignUpdatedNotification, campaignRemovedNotification } from '../../utils/notifications/coupons/sendCouponNotifications.js';
import { generateSlug, ensureUniqueSlug } from '../../utils/helpers/shared/generateSlug.js';

// Accept an array directly (JSON body) or a JSON string (multipart), else fall back.
const parseArray = (value, fallback = []) => {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

// Keep only well-formed {start, end} windows, sorted earliest-first (by start time),
// capped at 2. "HH:MM" 24h strings sort chronologically as plain strings.
const sanitizeHours = (windows) =>
  parseArray(windows)
    .filter(w => w && w.start && w.end)
    .map(w => ({ start: String(w.start), end: String(w.end) }))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 2);

// @desc    Create new campaign for a store (admin only)
// @route   POST /api/admin/stores/:storeId/campaigns
// @access  Private/Admin
export const createCampaign = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  
  console.log(`🔹 Creating campaign for store: ${storeId}`);

  const {
    campaignName,
    discount,
    discountProduct,
    termsConditions,
    expiryDate,
    maxRedemptions,
    validDays,
    validHours,
    isHidden,
    isActive
  } = req.body;

  // Validate required fields
  if (!campaignName || !discount || !discountProduct || !expiryDate) {
    res.status(400);
    throw new Error('Campaign name, discount, discount product, and expiry date are required');
  }

  // Verify store exists
  const store = await Store.findById(storeId);
  if (!store) {
    res.status(404);
    throw new Error('Store not found');
  }

  // Validate expiry date is in future
  if (new Date(expiryDate) <= new Date()) {
    res.status(400);
    throw new Error('Expiry date must be in the future');
  }

  // Generate slug: storeName-campaignName
  const slugBase = `${store.storeName}-${campaignName}`;
  const baseSlug = generateSlug(slugBase, 60);
  const uniqueSlug = await ensureUniqueSlug(Campaign, baseSlug);

  // Create campaign
  const campaign = await Campaign.create({
    storeId,
    campaignName,
    slug: uniqueSlug,
    discount,
    discountProduct,
    termsConditions: termsConditions || '',
    expiryDate: new Date(expiryDate),
    maxRedemptions: parseInt(maxRedemptions) || 0,
    validDays: parseArray(validDays),
    validHours: sanitizeHours(validHours),
    isHidden: isHidden === 'true' || isHidden === true || false,
    isActive: isActive === 'true' || isActive === true || true,
    totalGenerated: 0,
    totalRedeemed: 0,
    createdBy: req.user.id || req.user._id
  });

  console.log(`✅ Campaign created: ${campaign.campaignName} - ${campaign.discount} on ${campaign.discountProduct}`);

  // Send notification emails (fire-and-forget)
  campaignCreatedNotification({
    campaign,
    store,
    admin: req.user
  }).catch(err => console.error('Campaign notification error:', err));

  res.status(201).json({
    success: true,
    campaign
  });
});

// @desc    Get all campaigns (with filters)
// @route   GET /api/admin/campaigns OR /api/admin/stores/:storeId/campaigns OR /api/coupons/stores/:storeId/campaigns
// @access  Public (filtered) or Admin (all)
export const getCampaigns = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const { isActive, isHidden, expired } = req.query;
  const isAdmin = req.user?.role === 'admin';

  // Build filter query
  const filter = {};

  if (storeId) filter.storeId = storeId;

  // Non-admin users only see active, non-hidden, non-expired campaigns
  if (!isAdmin) {
    filter.isActive = true;
    filter.isHidden = false;
    filter.expiryDate = { $gte: new Date() };
  } else {
    // Admin can filter
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }
    if (isHidden !== undefined) {
      filter.isHidden = isHidden === 'true';
    }
    if (expired === 'true') {
      filter.expiryDate = { $lt: new Date() };
    } else if (expired === 'false') {
      filter.expiryDate = { $gte: new Date() };
    }
  }

  const campaigns = await Campaign.find(filter)
    .populate('storeId')
    .populate('createdBy', 'firstName lastName email')
    .sort({ createdAt: -1 });

  // Convert all campaigns to plain objects (required for userHasCode serialization)
  const campaignsWithStats = campaigns.map(campaign => {
    const campaignObj = campaign.toObject();
    if (isAdmin) {
      campaignObj.stats = { 
        totalGenerated: campaign.totalGenerated, 
        totalRedeemed: campaign.totalRedeemed 
      };
    }
    return campaignObj;
  });

  // Check if user has codes for each campaign (if logged in)
  let campaignsWithUserStatus = campaignsWithStats;
  if (req.user) {
    const userId = req.user.id || req.user._id;
    
    // Get all campaign IDs
    const campaignIds = campaigns.map(c => c._id);
    
    // Find all codes for this user for these campaigns
    const userCodes = await CouponCode.find({
      userId,
      campaignId: { $in: campaignIds }
    }).select('campaignId isRedeemed');
    
    // Create a Map of campaign IDs with their redemption status
    const userCampaignMap = new Map(
      userCodes.map(code => [code.campaignId.toString(), code.isRedeemed])
    );
    
    // Add userHasCode and userCodeRedeemed flags to each campaign
    campaignsWithUserStatus = campaignsWithStats.map((campaignObj, index) => {
      const campaign = campaigns[index];
      const campaignIdStr = campaign._id.toString();
      const hasCode = userCampaignMap.has(campaignIdStr);
      const isRedeemed = hasCode ? userCampaignMap.get(campaignIdStr) : false;
      campaignObj.userHasCode = hasCode;
      campaignObj.userCodeRedeemed = isRedeemed;
      return campaignObj;
    });
  } else {
    // Not logged in, add userHasCode: false to all
    campaignsWithUserStatus = campaignsWithStats.map(campaignObj => ({
      ...campaignObj,
      userHasCode: false,
      userCodeRedeemed: false
    }));
  }

  res.status(200).json({
    success: true,
    campaigns: campaignsWithUserStatus
  });
});

// @desc    Get single campaign by ID
// @route   GET /api/admin/campaigns/:id
// @access  Private/Admin
export const getCampaignById = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id)
    .populate('storeId')
    .populate('createdBy', 'firstName lastName email');

  if (!campaign) {
    res.status(404);
    throw new Error('Campaign not found');
  }

  res.status(200).json({
    success: true,
    campaign
  });
});

// @desc    Get single campaign by ID (for public viewing)
// @route   GET /api/coupons/campaigns/:id
// @access  Public
export const getCampaignByIdPublic = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const campaign = await Campaign.findById(id)
    .populate('storeId');

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  // Direct link (slug/views) may PREVIEW a campaign kept out of browse — whether it's
  // inactive or hidden — reachable via its link, like deals. Only expired is blocked.
  const now = new Date();
  if (new Date(campaign.expiryDate) < now) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not available'
    });
  }

  // Check if user has code for this campaign (if logged in)
  let userHasCode = false;
  let userCodeRedeemed = false;
  if (req.user) {
    const userId = req.user.id || req.user._id;
    const userCode = await CouponCode.findOne({
      userId,
      campaignId: campaign._id
    }).select('isRedeemed');
    userHasCode = !!userCode;
    userCodeRedeemed = userCode ? userCode.isRedeemed : false;
  }

  const campaignObj = campaign.toObject();
  campaignObj.userHasCode = userHasCode;
  campaignObj.userCodeRedeemed = userCodeRedeemed;

  res.status(200).json({
    success: true,
    campaign: campaignObj
  });
});

// @desc    Get single campaign by slug (for public sharing)
// @route   GET /api/coupons/campaigns/slug/:slug
// @access  Public
export const getCampaignBySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;

  const campaign = await Campaign.findOne({ slug })
    .populate('storeId');

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  // Direct link (slug/views) may PREVIEW a campaign kept out of browse — whether it's
  // inactive or hidden — reachable via its link, like deals. Only expired is blocked.
  const now = new Date();
  if (new Date(campaign.expiryDate) < now) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not available'
    });
  }

  // Check if user has code for this campaign (if logged in)
  let userHasCode = false;
  let userCodeRedeemed = false;
  if (req.user) {
    const userId = req.user.id || req.user._id;
    const userCode = await CouponCode.findOne({
      userId,
      campaignId: campaign._id
    }).select('isRedeemed');
    userHasCode = !!userCode;
    userCodeRedeemed = userCode ? userCode.isRedeemed : false;
  }

  const campaignObj = campaign.toObject();
  campaignObj.userHasCode = userHasCode;
  campaignObj.userCodeRedeemed = userCodeRedeemed;

  if (campaignObj.storeId?.logo?.publicId) {
    campaignObj.storeId.logo.ogImageUrl = `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${campaignObj.storeId.logo.publicId}`;
    campaignObj.ogImageUrl = campaignObj.storeId.logo.ogImageUrl;
  } else if (campaignObj.storeId?.logo?.url) {
    campaignObj.ogImageUrl = campaignObj.storeId.logo.url;
  } else {
    campaignObj.ogImageUrl = null;
  }

  res.status(200).json({
    success: true,
    campaign: campaignObj
  });
});

// @desc    Update campaign (admin only, with restrictions)
// @route   PUT /api/admin/campaigns/:id
// @access  Private/Admin
export const updateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).populate('storeId');

  if (!campaign) {
    res.status(404);
    throw new Error('Campaign not found');
  }

  const {
    campaignName,
    discount,
    discountProduct,
    termsConditions,
    expiryDate,
    maxRedemptions,
    validDays,
    validHours,
    isHidden,
    isActive
  } = req.body;

  // Track changes for email notification
  const changes = {};

  // Update campaign name (allowed)
  if (campaignName !== undefined && campaignName.trim() !== campaign.campaignName) {
    changes.campaignName = {
      old: campaign.campaignName,
      new: campaignName.trim()
    };
    campaign.campaignName = campaignName.trim();
  }

  // Update discount (allowed)
  if (discount !== undefined && discount.trim() !== campaign.discount) {
    changes.discount = {
      old: campaign.discount,
      new: discount.trim()
    };
    campaign.discount = discount.trim();
  }

  // Update discount product (allowed)
  if (discountProduct !== undefined && discountProduct.trim() !== campaign.discountProduct) {
    changes.discountProduct = {
      old: campaign.discountProduct,
      new: discountProduct.trim()
    };
    campaign.discountProduct = discountProduct.trim();
  }

  // Update terms & conditions (allowed)
  if (termsConditions !== undefined && termsConditions !== campaign.termsConditions) {
    changes.termsConditions = {
      old: campaign.termsConditions,
      new: termsConditions
    };
    campaign.termsConditions = termsConditions;
  }

  // Update expiry date (can only EXTEND, not shorten)
  if (expiryDate) {
    const newExpiryDate = new Date(expiryDate);
    const oldExpiryDate = new Date(campaign.expiryDate);
    
    if (newExpiryDate < oldExpiryDate) {
      res.status(400);
      throw new Error('Cannot shorten expiry date. You can only extend it.');
    }
    
    // Only track if date actually changed
    if (newExpiryDate.getTime() !== oldExpiryDate.getTime()) {
      changes.expiryDate = {
        old: campaign.expiryDate,
        new: newExpiryDate
      };
      campaign.expiryDate = newExpiryDate;
    }
  }

  // Update max redemptions (can only INCREASE, not decrease)
  if (maxRedemptions !== undefined) {
    const newMax = parseInt(maxRedemptions);
    if (newMax < campaign.totalGenerated) {
      res.status(400);
      throw new Error(`Cannot set max redemptions below current generated codes (${campaign.totalGenerated})`);
    }
    
    // Only track if value actually changed
    if (newMax !== campaign.maxRedemptions) {
      changes.maxRedemptions = {
        old: campaign.maxRedemptions,
        new: newMax
      };
      campaign.maxRedemptions = newMax;
    }
  }

  // Update valid days + hours (freely editable, no notification)
  if (validDays !== undefined) {
    campaign.validDays = parseArray(validDays);
  }
  if (validHours !== undefined) {
    campaign.validHours = sanitizeHours(validHours);
  }

  // Update visibility/active status (allowed, but don't notify)
  if (isHidden !== undefined) {
    campaign.isHidden = isHidden === 'true' || isHidden === true;
  }
  if (isActive !== undefined) {
    campaign.isActive = isActive === 'true' || isActive === true;
  }

  const updatedCampaign = await campaign.save();

  console.log(`✅ Campaign updated: ${updatedCampaign._id}`);

  // Send notification if there are relevant changes
  if (Object.keys(changes).length > 0) {
    campaignUpdatedNotification({
      campaign: updatedCampaign,
      store: campaign.storeId,
      admin: req.user,
      changes
    }).catch(err => console.error('Campaign update notification error:', err));
  }

  res.status(200).json({
    success: true,
    campaign: updatedCampaign
  });
});

// @desc    Delete campaign (admin only)
// @route   DELETE /api/admin/campaigns/:id
// @access  Private/Admin
export const deleteCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);

  if (!campaign) {
    res.status(404);
    throw new Error('Campaign not found');
  }

  // Check if campaign is active AND not expired
  const isExpired = new Date(campaign.expiryDate) < new Date();
  if (campaign.isActive && !isExpired) {
    return res.status(400).json({
      success: false,
      message: 'Cannot delete active campaign. Please mark as inactive first or wait for expiry.'
    });
  }

  // Warn customers holding still-valid un-redeemed codes that the offer is gone.
  // Only when the campaign wasn't expired (expired codes were already dead).
  // Fetched BEFORE the cascade delete so we still have the codes + holders.
  if (!isExpired) {
    const unredeemedCodes = await CouponCode.find({
      campaignId: campaign._id,
      isRedeemed: false
    }).populate('userId', 'firstName email');

    if (unredeemedCodes.length > 0) {
      const store = await Store.findById(campaign.storeId).select('storeName');
      if (store) {
        // Fire-and-forget so it doesn't block the delete.
        campaignRemovedNotification({ campaign, store, codes: unredeemedCodes })
          .catch(err => console.error('Campaign removal notification error:', err));
      }
    }
  }

  // Campaign is inactive or expired - safe to delete
  // Cascade delete: Delete all related coupon codes
  const deletedCodes = await CouponCode.deleteMany({
    campaignId: campaign._id
  });

  await campaign.deleteOne();

  console.log(`✅ Campaign deleted: ${campaign._id}`);
  console.log(`✅ Cascade deleted ${deletedCodes.deletedCount} coupon code(s)`);

  res.status(200).json({
    success: true,
    message: 'Campaign deleted successfully',
    deletedCodes: deletedCodes.deletedCount
  });
});

// @desc    Get all active campaigns for sitemap
// @route   GET /api/coupons/campaigns/sitemap
// @access  Public
export const getSitemapCampaigns = asyncHandler(async (req, res) => {
  try {
    const campaigns = await Campaign.find({
      isActive: true,
      isHidden: false,
      expiryDate: { $gte: new Date() }
    })
      .select('slug _id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50000)
      .lean();
    return res.status(200).json(campaigns);
  } catch (error) {
    console.error('Error fetching campaigns for sitemap:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});
