// utils/validators/advertValidator.js

import { isPricingRequired } from '../constants/pricingConfig.js';
import { isValidCategoryCombo, getAllSubcategories } from '../constants/categories.js';
import { validateTitle } from '../helpers/shared/validateTitle.js';

// Validation configuration
const validationRules = {
    base: {
      requiredFields: ['title', 'category', 'subcategory', 'description'],
      optionalFields: ['fields', 'images'],
      maxImages: 10,
      allowedStatuses: ['active'],
      minPrice: 0,
      expiryDays: 90
    },

    admin: {
      allowedStatuses: ['active', 'inactive', 'pending'],
      expiryDays: 365
    }
  };

  // Helper function to get validation rules
  const getRulesForRole = (role) => {
    const baseRules = { ...validationRules.base };
    if (role === 'admin') {
      return {
        ...baseRules,
        allowedStatuses: validationRules.admin.allowedStatuses,
        expiryDays: validationRules.admin.expiryDays
      };
    }
    return baseRules;
  };

  // Main validation function
  // Note: subcategory parameter is the old flat category value used for config lookups
  export const validateAdvertData = (data, role = 'user', subcategory = '', isUpdate = false) => {
    const rules = getRulesForRole(role);
    const errors = [];

    const isEmpty = (val) => val === undefined || val === null || (typeof val === 'string' && !val.trim());

    // Check required fields
    if (!isUpdate) {
      const requiredFields = [...rules.requiredFields];

      // Add pricing to required fields if:
      // 1. It's not a "wanted" ad AND
      // 2. The subcategory requires pricing
      if (data.adType !== 'wanted' && subcategory && isPricingRequired(subcategory)) {
        requiredFields.push('pricing');
      }

      const missingFields = requiredFields.filter(field => isEmpty(data[field]));
      if (missingFields.length > 0) {
        errors.push(`Missing required fields: ${missingFields.join(', ')}`);
      }
    }

    // Category + Subcategory validation
    if (data.category && data.subcategory) {
      if (!isValidCategoryCombo(data.category, data.subcategory)) {
        errors.push(`Invalid category/subcategory combination: ${data.category} > ${data.subcategory}`);
      }
    } else if (data.subcategory && !data.category) {
      // Subcategory provided without category - validate subcategory exists
      const allSubcategories = getAllSubcategories();
      if (!allSubcategories.includes(data.subcategory)) {
        errors.push(`Invalid subcategory: ${data.subcategory}`);
      }
    }

    // Title validation — shared BLOCK rules (keep in sync with frontend).
    // On update, the controller passes title only when it actually changed
    // (avoids rejecting a legacy title that predates these rules).
    if (data.title !== undefined) {
      const { error: titleError } = validateTitle(data.title);
      if (titleError) errors.push(titleError);
    }

    // Description validation
    if (data.description !== undefined) {
      if (isEmpty(data.description)) errors.push('Description cannot be empty');
    }

    // Category validation
    if (data.category !== undefined && isEmpty(data.category)) {
      errors.push('Category cannot be empty');
    }

    // Pricing validation - skip for wanted ads
    if (data.adType !== 'wanted') {
      const pricingRequired = subcategory && isPricingRequired(subcategory);

      if (pricingRequired && (!data.pricing || data.pricing.length === 0)) {
        errors.push('Pricing is required');
      } else if (data.pricing) {
        if (!Array.isArray(data.pricing)) {
          errors.push('Pricing must be an array');
        } else {
          data.pricing.forEach((price, index) => {
            if (!price.priceType) {
              errors.push(`Pricing[${index}] must have a priceType`);
            }
            if (price.amount !== undefined && price.amount < rules.minPrice) {
              errors.push(`Pricing[${index}] amount must be >= ${rules.minPrice}`);
            }
          });
        }
      }
    }

    // Images validation
    if (data.images !== undefined && !isUpdate) {
      if (!Array.isArray(data.images)) {
        errors.push('Images must be an array');
      } else if (data.images.length > rules.maxImages) {
        errors.push(`Maximum ${rules.maxImages} images allowed`);
      }
    }

    // Address validation - required for all listings
    if (!isUpdate) {
      if (isEmpty(data.address)) {
        errors.push('Address is required');
      } else if (typeof data.address === 'string') {
        try {
          const parsed = JSON.parse(data.address);
          if (!parsed || !parsed.formattedAddress) {
            errors.push('Address is required');
          }
        } catch (e) {
          errors.push('Invalid address format');
        }
      }
    }

    // Status validation
    if (data.status && !rules.allowedStatuses.includes(data.status)) {
      errors.push(`Invalid status. Allowed: ${rules.allowedStatuses.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  };

  // Parse address helper
  export const parseAndValidateAddress = (addressData) => {
    // Normal address validation
    const parsedAddress = addressData ? JSON.parse(addressData) : null;

    if (!parsedAddress || !parsedAddress.location || !Array.isArray(parsedAddress.location.coordinates)) {
      throw new Error('Invalid or missing address coordinates');
    }

    return parsedAddress;
  };

  // Export rules getter for use in other parts of application
  export const getValidationRules = getRulesForRole;
