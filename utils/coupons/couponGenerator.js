import mongoose from 'mongoose';
import Campaign from '../../models/coupons/campaign.js';
import Store from '../../models/coupons/store.js';
import CouponCode from '../../models/coupons/couponCode.js';

/**
 * Generate unique coupon code for a user and campaign
 * Format: STOREID-12345 (e.g., A1B2C-12345)
 * Uses atomic operations for data integrity (works in dev and production)
 * @param {String} userId - User ObjectId
 * @param {String} campaignId - Campaign ObjectId
 * @returns {Object} Created coupon code document
 */
export const generateCouponCode = async (userId, campaignId) => {
  try {
    console.log(`🔹 Generating code for user ${userId} and campaign ${campaignId}`);

    // Step 1: Check for existing code (idempotency)
    const existingCode = await CouponCode.findOne({ userId, campaignId });
    if (existingCode) {
      console.log(`✅ User already has code for this campaign: ${existingCode.fullCode}`);
      return existingCode;
    }

    // Step 2: Fetch campaign with validation
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    if (!campaign.isActive) {
      throw new Error('Campaign is not active');
    }

    if (new Date(campaign.expiryDate) < new Date()) {
      throw new Error('Campaign has expired');
    }

    // Step 3: Atomically increment counter with limit check
    let updatedCampaign;
    if (campaign.maxRedemptions > 0) {
      // Atomic increment with condition (prevents exceeding limit)
      updatedCampaign = await Campaign.findOneAndUpdate(
        { 
          _id: campaignId,
          totalGenerated: { $lt: campaign.maxRedemptions }
        },
        { $inc: { totalGenerated: 1 } },
        { new: true }
      );

      if (!updatedCampaign) {
        throw new Error('Campaign has reached maximum code generation limit');
      }
      console.log(`✅ Campaign counter incremented: ${updatedCampaign.totalGenerated}/${campaign.maxRedemptions}`);
    } else {
      // No limit, just increment
      await Campaign.findByIdAndUpdate(
        campaignId,
        { $inc: { totalGenerated: 1 } }
      );
      console.log(`✅ Campaign counter incremented (no limit)`);
    }

    // Step 4: Fetch store
    const store = await Store.findById(campaign.storeId);
    if (!store) {
      // Rollback: decrement counter
      await Campaign.findByIdAndUpdate(campaignId, { $inc: { totalGenerated: -1 } });
      console.log(`⚠️ Store not found, rolled back counter`);
      throw new Error('Store not found');
    }

    // Step 5: Generate unique user code
    const generateUserCode = () => {
      return Math.floor(10000 + Math.random() * 90000).toString();
    };

    let userCode;
    let fullCode;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      userCode = generateUserCode();
      fullCode = `${store.storeIdentifier}-${userCode}`;

      // Check uniqueness
      const existingFullCode = await CouponCode.findOne({ fullCode });
      const existingStoreUserCode = await CouponCode.findOne({ 
        storeId: store._id, 
        userCode 
      });

      if (!existingFullCode && !existingStoreUserCode) {
        console.log(`✅ Generated unique coupon code: ${fullCode} (attempt ${attempts + 1})`);
        break;
      }

      console.log(`⚠️ Coupon code collision detected, retrying... (attempt ${attempts + 1})`);
      attempts++;
    }

    if (attempts >= maxAttempts) {
      // Rollback: decrement counter
      await Campaign.findByIdAndUpdate(campaignId, { $inc: { totalGenerated: -1 } });
      console.log(`❌ Failed to generate unique code after ${maxAttempts} attempts, rolled back counter`);
      throw new Error('Unable to generate unique coupon code after 10 attempts');
    }

    // Step 6: Create coupon code document
    try {
      const couponCode = await CouponCode.create({
        fullCode,
        storeIdentifier: store.storeIdentifier,
        userCode,
        storeId: store._id,
        campaignId: campaign._id,
        userId,
        isRedeemed: false,
        generatedAt: new Date()
      });

      console.log(`✅ Coupon code created successfully: ${fullCode} for user ${userId}`);
      return couponCode;

    } catch (createError) {
      // Rollback: decrement counter if code creation fails
      await Campaign.findByIdAndUpdate(campaignId, { $inc: { totalGenerated: -1 } });
      console.log(`❌ Code creation failed, rolled back counter: ${createError.message}`);
      throw createError;
    }

  } catch (error) {
    console.error('❌ Error generating coupon code:', error.message);
    throw error;
  }
};
