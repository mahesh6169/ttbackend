// utils/events/accountHelpers.js

import stripe from '../../config/stripe.js';
import User from '../../models/userModel.js';


/**
 * Compute Stripe account status based on user data
 * @param {Object} userData - User object or subset with Stripe fields
 * @returns {String} Account status enum value
 */
export const computeStripeAccountStatus = (userData) => {
  // 1. No account at all
  if (!userData.stripeAccountId) return 'no_account'
  
  // 2. CRITICAL - Past due requirements (highest priority)
  if (userData.stripeRequirementsPastDue?.length > 0) return 'account_restricted'
  
  // 3. URGENT - Current requirements need attention
  if (userData.stripeRequirementsCurrentlyDue?.length > 0) return 'action_required'
  
  // 4. Setup not completed
  if (!userData.stripeDetailsSubmitted) return 'incomplete_setup'
  
  // 5. Capabilities not enabled - check why
  if (!userData.stripeChargesEnabled || !userData.stripePayoutsEnabled) {
    // If verification is pending, they're waiting for Stripe review
    if (userData.stripeRequirementsPendingVerification?.length > 0) {
      return 'under_review'
    }
    // Otherwise, capabilities just haven't been enabled yet
    return 'capabilities_pending'
  }
  
  // 6. Everything good!
  return 'fully_active'
}