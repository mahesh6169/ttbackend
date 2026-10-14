// Backend pricing configuration
// Lists ONLY the subcategories that require a price. Keep in sync with the
// frontend components/adverts/fieldSystem/PricingConfig.js - every subcategory
// there (the ones whose form shows a price box) belongs here.
// Anything not listed (services, jobs, etc.) does not require a price.

export const PRICING_CONFIG = {
  'Books, Art & Collectables': { required: true },
  'Baby & Kids': { required: true },
  'Music & Games': { required: true },
  'Cars & Vehicles': { required: true },
  'Fashion & Accessories': { required: true },
  'Health, Sport & Fitness': { required: true },
  'Home & Decor': { required: true },
  'Garden & Outdoor': { required: true },
  'Pet Supplies': { required: true },
  'Building Materials': { required: true },
  'Electronics & Computers': { required: true },
  'Sell, Rent & Share': { required: true },
};

// Check if pricing is required for a subcategory
export const isPricingRequired = (category) => {
  const config = PRICING_CONFIG[category];
  return config ? config.required : false; // Not listed = no price required
};
