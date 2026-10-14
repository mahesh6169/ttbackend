// Platform pricing configuration for events
// This file contains all platform fee-related constants

export const PLATFORM_PRICE_CONFIG = {
  // Default platform fee per ticket when event.platformFee is null
  DEFAULT_PLATFORM_FEE: 0.80,  // $0.80 AUD per ticket
  
  // Default platform fee percentage when event.platformFeePercentage is null
  DEFAULT_PLATFORM_FEE_PERCENTAGE: 0.30,  // 0.30% top-up (on top of Stripe's 1.7%)
  
  // Maximum allowed platform fee (enforced in API validation)
  MAX_PLATFORM_FEE: 20.00,     // $20.00 AUD per ticket
  
  // Minimum allowed platform fee
  MIN_PLATFORM_FEE: 0.00,      // Allow free for special/promotional events
  
  // Maximum allowed platform fee percentage
  MAX_PLATFORM_FEE_PERCENTAGE: 10.00,  // 10% max
  
  // Minimum allowed platform fee percentage
  MIN_PLATFORM_FEE_PERCENTAGE: 0.00,   // 0% min
  
  // Currency (for future use)
  CURRENCY: 'AUD',
  
  // Fee decimal precision
  DECIMAL_PLACES: 2,
  
  // Stripe fee absorption (per order, not per ticket)
  STRIPE_ABSORB: 0.30  // Absorb Stripe's $0.30 fixed fee
};

// Helper function to get effective platform fee for an event
export const getEffectivePlatformFee = (event) => {
  // Get flat fee
  const flatFee = (event.platformFee !== null && event.platformFee !== undefined) 
    ? event.platformFee 
    : PLATFORM_PRICE_CONFIG.DEFAULT_PLATFORM_FEE;
    
  // Get percentage fee
  const percentage = (event.platformFeePercentage !== null && event.platformFeePercentage !== undefined)
    ? event.platformFeePercentage
    : PLATFORM_PRICE_CONFIG.DEFAULT_PLATFORM_FEE_PERCENTAGE;
  
  // Return both components
  return {
    flatFee,
    percentage,
    // Helper: calculate total fee for a given amount
    calculateTotalFee: (totalAmount, ticketCount) => {
      const flatAmount = ticketCount * flatFee;
      const percentageAmount = totalAmount * (percentage / 100);
      return flatAmount + percentageAmount;
    }
  };
};

// Compute platform commission (Stripe application fee) in INTEGER CENTS.
//
// Fix #6: the commission used to be computed in float dollars and rounded once at the very
// end, which could drift by a cent. This does the whole calculation in integer cents — each
// component rounded once, then integer add/subtract — so the result is exact.
//
// Reused as-is by the discount-codes feature: it passes the DISCOUNTED charge amount (in
// cents) as `amountCents`; the formula itself does not change, only the argument.
//
// @param {Number} amountCents    - the amount being charged, in integer cents
// @param {Number} ticketCount    - number of tickets in the order
// @param {Object} effectiveFees  - { flatFee, percentage } from getEffectivePlatformFee(event)
// @returns {Number} application fee in integer cents (>= 0)
export const computeCommissionCents = (amountCents, ticketCount, effectiveFees) => {
  const flatCents = Math.round(ticketCount * effectiveFees.flatFee * 100);            // $0.80/ticket
  const percentageCents = Math.round((amountCents * effectiveFees.percentage) / 100); // e.g. 0.30% of amount
  const absorbCents = Math.round(PLATFORM_PRICE_CONFIG.STRIPE_ABSORB * 100);          // platform absorbs Stripe's $0.30
  return Math.max(0, flatCents + percentageCents - absorbCents);
};

// Validate platform fee amount
export const validatePlatformFee = (fee) => {
  // Check if fee is a valid number
  if (typeof fee !== 'number' || isNaN(fee)) {
    return { isValid: false, error: 'Platform fee must be a valid number' };
  }
  
  // Check minimum
  if (fee < PLATFORM_PRICE_CONFIG.MIN_PLATFORM_FEE) {
    return { isValid: false, error: `Platform fee cannot be less than $${PLATFORM_PRICE_CONFIG.MIN_PLATFORM_FEE}` };
  }
  
  // Check maximum
  if (fee > PLATFORM_PRICE_CONFIG.MAX_PLATFORM_FEE) {
    return { isValid: false, error: `Platform fee cannot exceed $${PLATFORM_PRICE_CONFIG.MAX_PLATFORM_FEE}` };
  }
  
  // Check decimal places (no more than 2 decimal places for cents)
  const decimalPlaces = (fee.toString().split('.')[1] || '').length;
  if (decimalPlaces > PLATFORM_PRICE_CONFIG.DECIMAL_PLACES) {
    return { isValid: false, error: 'Platform fee can have maximum 2 decimal places' };
  }
  
  return { isValid: true };
};

// Validate platform fee percentage
export const validatePlatformFeePercentage = (percentage) => {
  // Check if percentage is a valid number
  if (typeof percentage !== 'number' || isNaN(percentage)) {
    return { isValid: false, error: 'Platform fee percentage must be a valid number' };
  }
  
  // Check minimum
  if (percentage < PLATFORM_PRICE_CONFIG.MIN_PLATFORM_FEE_PERCENTAGE) {
    return { isValid: false, error: `Platform fee percentage cannot be less than ${PLATFORM_PRICE_CONFIG.MIN_PLATFORM_FEE_PERCENTAGE}%` };
  }
  
  // Check maximum
  if (percentage > PLATFORM_PRICE_CONFIG.MAX_PLATFORM_FEE_PERCENTAGE) {
    return { isValid: false, error: `Platform fee percentage cannot exceed ${PLATFORM_PRICE_CONFIG.MAX_PLATFORM_FEE_PERCENTAGE}%` };
  }
  
  // Check decimal places (no more than 2 decimal places)
  const decimalPlaces = (percentage.toString().split('.')[1] || '').length;
  if (decimalPlaces > PLATFORM_PRICE_CONFIG.DECIMAL_PLACES) {
    return { isValid: false, error: 'Platform fee percentage can have maximum 2 decimal places' };
  }
  
  return { isValid: true };
};

// Format fee for display
export const formatPlatformFee = (fee) => {
  return `$${fee.toFixed(2)}`;
};

// Format fee breakdown for display
export const formatPlatformFeeBreakdown = (flatFee, percentage) => {
  if (percentage > 0) {
    return `$${flatFee.toFixed(2)} + ${percentage.toFixed(2)}%`;
  }
  return `$${flatFee.toFixed(2)}`;
};