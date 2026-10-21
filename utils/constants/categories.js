// utils/constants/categories.js
// Single source of truth for category hierarchy (backend mirror)

export const CATEGORIES = [
  {
    label: 'Real Estate',
    subcategories: [
      'Sell, Rent & Share',
      'Real Estate & Buyers Agents',
    ],
  },
  {
    label: 'Buy & Sell',
    subcategories: [
      'Cars & Vehicles',
      'Home & Decor',
      'Garden & Outdoor',
      'Electronics & Computers',
      'Baby & Kids',
      'Health, Sport & Fitness',
      'Music & Games',
      'Fashion & Accessories',
      'Books, Art & Collectables',
      'Pet Supplies',
      'Building Materials',
    ],
  },
  {
    label: 'Home Services',
    subcategories: [
      'Electricians',
      'Painters',
      'Plumbing & Gas',
      'Landscaping & Gardening',
      'Air Conditioning & Refrigeration',
      'Home Repairs & Improvements',
      'Cabinet Makers',
      'Handyman & Flatpacks',
      'Packers & Movers',
      'Sewing & Alterations',
      'Cleaning & Maintenance',
      'Pest Control',
      'Domestic Help',
      'Water Filtration & Purification',
    ],
  },
  {
    label: 'Vehicle Services',
    subcategories: [
      'Car Servicing & Repairs',
    ],
  },
  {
    label: 'Beauty & Wellness',
    subcategories: [
      'Hair, Makeup & Waxing',
      'Massage',
      'Yoga',
    ],
  },
  {
    label: 'Food & Catering',
    subcategories: [
      'Restaurants & Cafes',
      'Catering',
      'Cakes',
      'Chat & Street Food',
      'Sweets & Snacks',
    ],
  },
  {
    label: 'Party & Entertainment',
    subcategories: [
      'Decorations',
      'Photography & Videography',
      'DJ & Audio Visual',
      'Entertainers & Performers',
      'Party Hire',
    ],
  },
  {
    label: 'Tutoring & Lessons',
    subcategories: [
      'Driving Lessons',
      'Academic Tutoring',
      'Music Lessons',
      'Dance Lessons',
      'Art Classes',
      'Sports Coaching',
    ],
  },
  {
    label: 'Groceries & Shops',
    subcategories: [
      'Indian Groceries',
      'Fruit & Veg',
      'Butchers',
      'Plant Nursery',
    ],
  },
  {
    label: 'Child & Aged Care',
    subcategories: [
      'Childcare & Babysitting',
      'Aged Parent Care',
    ],
  },
  {
    label: 'Professional & Business Services',
    subcategories: [
      'Accounting & Taxation',
      'Legal & Immigration',
      'Financial & Insurance',
    ],
  },
  {
    label: 'Transport & Logistics',
    subcategories: [
      'Courier & Delivery',
      'Taxi & Transfers',
    ],
  },
  {
    label: 'Digital & IT Services',
    subcategories: [
      'Computer & Mobile Repairs',
      'Business IT',
      'Website Design',
    ],
  },
  {
    label: 'Employment',
    subcategories: [
      'Full Time',
      'Casual',
      'Part Time',
    ],
  },
  {
    label: 'Travel & Tourism',
    subcategories: [
      'Tour Guides & Operators',
      'Travel Agents',
    ],
  },
  {
    label: 'Travel Requests',
    subcategories: [
      'Parcel Carrying',
      'Travel Companion for Parents',
    ],
  },
  {
    label: 'Marketing & Advertising',
    subcategories: [
      'Logo Services',
    ],
  },
  {
    label: 'Cultural & Community',
    subcategories: [
      'Matrimony',
      'Priest & Pooja',
      'Marriage Celebrants',
    ],
  },
];

// Subcategories that are items/listings, not services
// Used to determine if "Notify me" checkbox should appear (Step 3)
const NON_SERVICE_SUBCATEGORIES = [
  // Buy & Sell (all items)
  'Cars & Vehicles',
  'Home & Decor',
  'Garden & Outdoor',
  'Electronics & Computers',
  'Baby & Kids',
  'Health, Sport & Fitness',
  'Music & Games',
  'Fashion & Accessories',
  'Books, Art & Collectables',
  'Pet Supplies',
  'Building Materials',
  // Real Estate (property listings)
  'Sell, Rent & Share',
  // Employment (job listings)
  'Full Time',
  'Casual',
  'Part Time',
  // Food & Catering (fixed location - customers come to them)
  'Restaurants & Cafes',
];

// Travel Requests sub-categories (budget is stored in fields: budgetType / budgetAmount)
export const TRAVEL_REQUEST_SUBCATEGORIES = [
  'Parcel Carrying',
  'Travel Companion for Parents',
];

// Get all parent category names
export function getAllParentCategories() {
  return CATEGORIES.map((cat) => cat.label);
}

// Get subcategories for a given parent category
export function getSubcategories(parentCategory) {
  const category = CATEGORIES.find((cat) => cat.label === parentCategory);
  return category ? category.subcategories : [];
}

// Get all subcategories as a flat list
export function getAllSubcategories() {
  return CATEGORIES.flatMap((cat) => cat.subcategories);
}

// Reverse lookup: given a subcategory, find its parent category
export function getParentForSubcategory(subcategory) {
  for (const cat of CATEGORIES) {
    if (cat.subcategories.includes(subcategory)) {
      return cat.label;
    }
  }
  return null;
}

// Check if a subcategory represents a service (vs items/listings)
export function isServiceSubcategory(subcategory) {
  return !NON_SERVICE_SUBCATEGORIES.includes(subcategory);
}

// Check if a category + subcategory combo is valid
export function isValidCategoryCombo(category, subcategory) {
  const validSubcategories = getSubcategories(category);
  return validSubcategories.includes(subcategory);
}

// Subcategories that need Community/Language field
const COMMUNITY_SUBCATEGORIES = [
  'Matrimony',
  'Priest & Pooja',
  'Marriage Celebrants',
];

// Check if a subcategory needs community/language field
export function needsCommunityField(subcategory) {
  return COMMUNITY_SUBCATEGORIES.includes(subcategory);
}

// Export arrays for reference
export { NON_SERVICE_SUBCATEGORIES, COMMUNITY_SUBCATEGORIES };
