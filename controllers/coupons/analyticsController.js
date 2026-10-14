import asyncHandler from 'express-async-handler';
import Campaign from '../../models/coupons/campaign.js';
import CouponCode from '../../models/coupons/couponCode.js';

// @desc    Get all codes for a specific campaign
// @route   GET /api/admin/campaigns/:campaignId/codes
// @access  Private/Admin
export const getCampaignCodes = asyncHandler(async (req, res) => {
  const { campaignId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  console.log(`🔹 Fetching codes for campaign: ${campaignId} (page ${page}, limit ${limit})`);

  // Verify campaign exists and populate store
  const campaign = await Campaign.findById(campaignId).populate('storeId', 'storeName storeIdentifier');
  if (!campaign) {
    res.status(404);
    throw new Error('Campaign not found');
  }

  // Get total count
  const totalCodes = await CouponCode.countDocuments({ campaignId });

  // Get paginated codes for this campaign
  const codes = await CouponCode.find({ campaignId })
    .populate('userId', 'firstName lastName email')
    .sort({ generatedAt: -1 })
    .skip(skip)
    .limit(limit);

  res.status(200).json({
    success: true,
    campaign: {
      _id: campaign._id,
      campaignName: campaign.campaignName,
      discount: campaign.discount,
      discountProduct: campaign.discountProduct,
      expiryDate: campaign.expiryDate,
      isActive: campaign.isActive,
      storeId: campaign.storeId,
      stats: {
        totalGenerated: campaign.totalGenerated || 0,
        totalRedeemed: campaign.totalRedeemed || 0
      }
    },
    codes: codes.map(code => ({
      _id: code._id,
      fullCode: code.fullCode,
      userId: code.userId
        ? {
            name: `${code.userId.firstName || ''} ${code.userId.lastName || ''}`.trim() || 'Unknown user',
            email: code.userId.email
          }
        : { name: 'Deleted user', email: null },
      isRedeemed: code.isRedeemed,
      generatedAt: code.generatedAt,
      redeemedAt: code.redeemedAt
    })),
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(totalCodes / limit),
      totalCodes: totalCodes,
      codesPerPage: limit,
      total: totalCodes
    }
  });
});
