// Backend mirror of the deals category taxonomy (parent group -> subcategory).
// Used to validate partner-store submissions server-side, since stores can be
// created by self-serve users (untrusted input), not only admins.
//
// KEEP IN SYNC with: ttfrontend/components/dailydeals/dealCategories.js
// Structure only — no pricing/expiry/field config (deals has none).

export const DEAL_CATEGORIES = [
  {
    label: 'Food & Dining',
    subcategories: ['Restaurants & Cafes', 'Catering', 'Cakes', 'Chat & Street Food', 'Sweets & Snacks'],
  },
  {
    label: 'Fashion',
    subcategories: ['Clothing & Ethnic Wear', 'Jewellery & Accessories'],
  },
  {
    label: 'Beauty & Wellness',
    subcategories: ['Hair, Makeup & Waxing', 'Massage', 'Yoga'],
  },
  {
    label: 'Health & Medical',
    subcategories: ['Dental', 'Physiotherapy', 'Optometry', 'Pharmacy'],
  },
  {
    label: 'Fitness & Sport',
    subcategories: ['Gym', 'Personal Training', 'Coaching'],
  },
  {
    label: 'Electrical & Electronics',
    subcategories: ['Air Conditioners', 'Solar Panels', 'Laptops & Computers'],
  },
  {
    label: 'Home Services',
    subcategories: ['Landscaping & Gardening', 'Air Conditioning & Refrigeration', 'Cleaning & Maintenance', 'Pest Control'],
  },
  {
    label: 'Vehicle Services',
    subcategories: ['Car Servicing & Repairs'],
  },
  {
    label: 'Real Estate',
    subcategories: ['Real Estate & Buyers Agents', 'Mortgage Brokers'],
  },
  {
    label: 'Party & Entertainment',
    subcategories: ['Decorations', 'Photography & Videography', 'DJ & Audio Visual', 'Entertainers & Performers', 'Party Hire'],
  },
  {
    label: 'Tutoring & Lessons',
    subcategories: ['Driving Lessons', 'Academic Tutoring', 'Music Lessons', 'Dance Lessons', 'Art Classes'],
  },
  {
    label: 'Professional & Business Services',
    subcategories: ['Accounting & Taxation', 'Legal & Immigration', 'Finance', 'Insurance'],
  },
  {
    label: 'Groceries & Shops',
    subcategories: ['Indian Groceries', 'Fruit & Veg', 'Butchers', 'Dairy'],
  },
  {
    label: 'Travel & Tourism',
    subcategories: ['Tour Guides & Operators', 'Travel Agents'],
  },
];

// Subcategories for a given parent label
export function getSubcategories(parentLabel) {
  const group = DEAL_CATEGORIES.find((c) => c.label === parentLabel);
  return group ? group.subcategories : [];
}

// Validate a parent + subcategory combination
export function isValidCategoryCombo(category, subcategory) {
  return getSubcategories(category).includes(subcategory);
}
