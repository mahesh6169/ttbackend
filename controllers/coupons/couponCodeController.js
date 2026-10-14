import asyncHandler from 'express-async-handler';
import CouponCode from '../../models/coupons/couponCode.js';
import Campaign from '../../models/coupons/campaign.js';
import Store from '../../models/coupons/store.js';
import User from '../../models/userModel.js';
import { generateCouponCode } from '../../utils/coupons/couponGenerator.js';
import { codeGeneratedNotification, codeRedeemedNotification } from '../../utils/notifications/coupons/sendCouponNotifications.js';
import { isValidToday } from '../../utils/coupons/storeSchedule.js';
import { verifyRecaptcha } from '../../utils/verifyRecaptcha.js';

// Human label for a weekday-restricted campaign, e.g. "Mon, Thu". Empty days => null.
const DAY_LABELS = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun'
};
const ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const formatDays = (validDays) => {
  if (!validDays || validDays.length === 0) return null;
  return ORDER.filter(d => validDays.includes(d)).map(d => DAY_LABELS[d]).join(', ');
};

// @desc    Generate coupon code for user (protected)
// @route   POST /api/coupons/campaigns/:campaignId/generate-code
// @access  Private (authenticated users)
export const generateCode = asyncHandler(async (req, res) => {
  const { campaignId } = req.params;
  const userId = req.user._id;

  // Generate code using utility (with transaction)
  const couponCode = await generateCouponCode(userId, campaignId);

  // Populate related data for email
  const populatedCode = await CouponCode.findById(couponCode._id)
    .populate('campaignId')
    .populate('storeId')
    .populate('userId');

  // Fire-and-forget email notifications
  codeGeneratedNotification({
    couponCode: populatedCode,
    campaign: populatedCode.campaignId,
    store: populatedCode.storeId,
    user: populatedCode.userId
  }).catch(err => console.error('Email notification error:', err));

  res.status(201).json({
    success: true,
    couponCode: populatedCode
  });
});

// @desc    Claim a coupon code as a guest, by email (public)
// @route   POST /api/coupons/claim
// @access  Public (rate-limited; reCAPTCHA verified server-side)
//
// The guest counterpart of generateCode. It opens the coupon path to a logged-out visitor while
// reusing every existing guard: the code + QR are EMAILED (never returned/rendered), so typing a
// stranger's email only gifts THAT inbox a coupon. A guest record is created/reused with no session
// issued; member emails are refused; one-per-campaign holds via the existing unique index; a
// re-claim re-sends the SAME code with counters untouched. Expiry / active / maxRedemptions
// atomicity all come from generateCouponCode unchanged.
export const claimGuestCode = asyncHandler(async (req, res) => {
  const { campaignId, email, captchaToken } = req.body;

  // Bot defence: token presence is checked here (so a missing token is a clear 400 even in test
  // mode, where verifyRecaptcha short-circuits), then the token itself is verified with Google.
  if (!captchaToken) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA token missing' });
  }
  try {
    await verifyRecaptcha(captchaToken);
  } catch (error) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA verification failed' });
  }

  // Email shape (normalised exactly like guest attendance).
  const normalisedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalisedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
    return res.status(400).json({ success: false, message: 'A valid email is required' });
  }

  if (!campaignId) {
    return res.status(400).json({ success: false, message: 'Campaign is required' });
  }

  // Reuse an existing guest record, or create a fresh one (email only, no session). A member email
  // is refused so a code never silently attaches to a full account from outside it.
  const existingUser = await User.findOne({ email: normalisedEmail });
  if (existingUser && existingUser.role !== 'guest') {
    return res.status(409).json({
      success: false,
      code: 'ACCOUNT_EXISTS',
      message: 'This email has an account. Please log in.',
    });
  }
  const guestUser = existingUser || await User.create({ email: normalisedEmail, role: 'guest' });

  // One-per-campaign / graceful re-claim: if this guest already holds a code for the campaign we
  // re-send the SAME code (recovery for a lost email) and leave counters untouched - we do NOT run
  // the generator again. A brand-new claim goes through generateCouponCode, which owns the
  // expiry / active / maxRedemptions-cap guards (atomic).
  const existingCode = await CouponCode.findOne({ userId: guestUser._id, campaignId });
  let couponCode;
  let alreadyClaimed = false;
  if (existingCode) {
    couponCode = existingCode;
    alreadyClaimed = true;
  } else {
    try {
      couponCode = await generateCouponCode(guestUser._id, campaignId);
    } catch (error) {
      // Campaign guard failure (expired / inactive / at cap / not found) => a clean refusal.
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  // Populate for the emails, then fire the SAME notifications a member claim fires (guest gets the
  // code + QR by email; store and admin get their generate-code notices too).
  const populatedCode = await CouponCode.findById(couponCode._id)
    .populate('campaignId')
    .populate('storeId')
    .populate('userId');

  codeGeneratedNotification({
    couponCode: populatedCode,
    campaign: populatedCode.campaignId,
    store: populatedCode.storeId,
    user: populatedCode.userId
  }).catch(err => console.error('Email notification error:', err));

  // Email-only delivery: the response NEVER carries the code or the QR.
  return res.status(alreadyClaimed ? 200 : 201).json({
    success: true,
    alreadyClaimed,
    message: alreadyClaimed
      ? "You've already claimed this coupon - we've sent it to your email again."
      : 'Your coupon code has been sent to your email.'
  });
});

// @desc    Get user's codes
// @route   GET /api/coupons/my-codes
// @access  Private (authenticated users)
export const getMyCodes = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const codes = await CouponCode.find({ userId })
    .populate({
      path: 'campaignId',
      populate: { path: 'storeId' }
    })
    .populate('storeId')
    .sort({ generatedAt: -1 });

  res.status(200).json({
    success: true,
    codes
  });
});

// @desc    Validate a coupon code (public endpoint)
// @route   POST /api/coupons/validate
// @access  Public
export const validateCode = asyncHandler(async (req, res) => {
  const { fullCode } = req.body;

  if (!fullCode) {
    res.status(400);
    throw new Error('Code is required');
  }

  // Find code
  const couponCode = await CouponCode.findOne({ fullCode: fullCode.toUpperCase() })
    .populate('userId', 'firstName lastName email')
    .populate('storeId')
    .populate('campaignId');

  if (!couponCode) {
    return res.status(400).json({
      success: false,
      validation: {
        isValid: false,
        message: 'Code not found'
      }
    });
  }

  // Check if already redeemed
  if (couponCode.isRedeemed) {
    return res.status(200).json({
      success: true,
      validation: {
        isValid: false,
        message: `Already redeemed on ${new Date(couponCode.redeemedAt).toLocaleDateString('en-AU')}`
      }
    });
  }

  // Check if campaign expired
  if (new Date(couponCode.campaignId.expiryDate) < new Date()) {
    return res.status(200).json({
      success: true,
      validation: {
        isValid: false,
        message: 'Campaign has expired'
      }
    });
  }

  // Check the campaign's valid weekdays, judged in the store's local timezone.
  if (!isValidToday(couponCode.campaignId.validDays, couponCode.storeId)) {
    const daysLabel = formatDays(couponCode.campaignId.validDays);
    return res.status(200).json({
      success: true,
      validation: {
        isValid: false,
        message: daysLabel ? `Not valid today — valid ${daysLabel}` : 'Not valid today'
      }
    });
  }

  // Code is valid
  res.status(200).json({
    success: true,
    validation: {
      isValid: true,
      message: 'Code is valid',
      userName: `${couponCode.userId.firstName} ${couponCode.userId.lastName}`,
      discount: couponCode.campaignId.discount,
      discountProduct: couponCode.campaignId.discountProduct,
      termsConditions: couponCode.campaignId.termsConditions,
      expiryDate: couponCode.campaignId.expiryDate,
      // Advisory only — the worker sees the intended days/hours; never a hard block.
      validDays: couponCode.campaignId.validDays || [],
      validHours: couponCode.campaignId.validHours || [],
      storeName: couponCode.storeId.storeName
    }
  });
});

// @desc    Redeem a coupon code (public endpoint)
// @route   POST /api/coupons/redeem
// @access  Public
export const redeemCode = asyncHandler(async (req, res) => {
  const { fullCode } = req.body;

  if (!fullCode) {
    res.status(400);
    throw new Error('Code is required');
  }

  // Find code
  const couponCode = await CouponCode.findOne({ fullCode: fullCode.toUpperCase() })
    .populate('userId', 'firstName lastName email')
    .populate('storeId')
    .populate('campaignId');

  if (!couponCode) {
    res.status(404);
    throw new Error('Invalid code');
  }

  // Check if already redeemed
  if (couponCode.isRedeemed) {
    res.status(400);
    throw new Error(`Code already redeemed on ${new Date(couponCode.redeemedAt).toLocaleDateString('en-AU')}`);
  }

  // Check if campaign expired
  if (new Date(couponCode.campaignId.expiryDate) < new Date()) {
    res.status(400);
    throw new Error('Campaign has expired');
  }

  // Enforce the campaign's valid weekdays in the store's local timezone. Hours are
  // never checked here — they are display-only.
  if (!isValidToday(couponCode.campaignId.validDays, couponCode.storeId)) {
    const daysLabel = formatDays(couponCode.campaignId.validDays);
    res.status(400);
    throw new Error(daysLabel ? `Not valid today — valid ${daysLabel}` : 'Not valid today');
  }

  // Atomically mark as redeemed — ONLY if it is still unredeemed.
  // Single source of truth for the redeem: closes the race where two concurrent
  // requests both pass the isRedeemed check above and both save.
  const redeemedAt = new Date();
  const redeemed = await CouponCode.findOneAndUpdate(
    { _id: couponCode._id, isRedeemed: false },
    { $set: { isRedeemed: true, redeemedAt } },
    { new: true }
  );

  // Lost the race — another device redeemed it a moment ago
  if (!redeemed) {
    res.status(400);
    throw new Error('This code was just redeemed on another device');
  }

  // Reflect the persisted state on the populated object used below (response + email)
  couponCode.isRedeemed = true;
  couponCode.redeemedAt = redeemedAt;

  // Increment campaign totalRedeemed counter and get updated campaign
  const updatedCampaign = await Campaign.findByIdAndUpdate(
    couponCode.campaignId._id,
    { $inc: { totalRedeemed: 1 } },
    { new: true }
  );
  console.log(`✅ Campaign totalRedeemed incremented for campaign: ${couponCode.campaignId._id}`);

  // Fire-and-forget email notifications (use updated campaign with correct stats)
  codeRedeemedNotification({
    couponCode,
    campaign: updatedCampaign,
    store: couponCode.storeId,
    user: couponCode.userId
  }).catch(err => console.error('Email notification error:', err));

  res.status(200).json({
    success: true,
    message: 'Code redeemed successfully',
    couponCode
  });
});
