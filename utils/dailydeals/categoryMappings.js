/**
 * Category Mappings for Daily Deals Search
 * Maps common search terms to deal categories
 *
 * Keep in sync with: ttfrontend/utils/dailydeals/categoryMappings.js
 */

// Keys are taxonomy values (parent labels or subcategory labels) from
// ttfrontend/components/dailydeals/dealCategories.js. Search matches either field.
const CATEGORY_MAPPINGS = {
  // Food & Dining
  'Restaurants & Cafes': ['restaurants', 'restaurant', 'cafe', 'cafes', 'coffee', 'food', 'dining'],
  'Catering': ['catering', 'caterer'],
  'Cakes': ['cake', 'cupcakes', 'macarons', 'donuts', 'cookies'],
  'Sweets & Snacks': ['sweets', 'snacks', 'pani', 'puri', 'samosa'],
  'Chat & Street Food': ['chat', 'chaat'],

  // Fashion
  'Clothing & Ethnic Wear': ['clothing', 'clothes', 'saree', 'sari', 'ethnic', 'kurta', 'lehenga'],
  'Jewellery & Accessories': ['jewellery', 'jewelry', 'jewel', 'gold', 'accessories'],

  // Beauty & Wellness
  'Hair, Makeup & Waxing': [
    'threading', 'tinting', 'facial', 'makeup', 'make-up',
    'hair', 'waxing', 'skin', 'bleach', 'manicure', 'pedicure'
  ],
  'Massage': ['massage', 'spa'],
  'Yoga': ['yoga'],

  // Health & Medical
  'Dental': ['dental', 'dentist', 'teeth'],
  'Physiotherapy': ['physio', 'physiotherapy'],
  'Optometry': ['optometry', 'optometrist', 'glasses'],
  'Pharmacy': ['pharmacy', 'chemist', 'medicine'],

  // Fitness & Sport
  'Gym': ['gym', 'fitness', 'workout'],
  'Personal Training': ['trainer', 'pt'],
  'Coaching': ['coaching', 'coach'],

  // Electrical & Electronics
  'Air Conditioners': ['aircon', 'ac', 'cooling'],
  'Solar Panels': ['solar'],
  'Laptops & Computers': ['laptop', 'laptops', 'computer', 'computers', 'pc'],

  // Home Services
  'Landscaping & Gardening': ['landscaping', 'gardening', 'garden', 'lawn'],
  'Air Conditioning & Refrigeration': ['refrigeration', 'fridge', 'refrigerator'],
  'Cleaning & Maintenance': ['cleaning', 'cleaner', 'maintenance'],
  'Pest Control': ['pest'],

  // Vehicle Services
  'Car Servicing & Repairs': ['mechanic'],

  // Real Estate
  'Real Estate & Buyers Agents': ['property', 'realestate'],
  'Mortgage Brokers': ['mortgage', 'broker'],

  // Party & Entertainment
  'Decorations': ['decoration', 'decorations', 'decor'],
  'Photography & Videography': ['photography', 'photographer', 'videography'],
  'DJ & Audio Visual': ['dj'],
  'Entertainers & Performers': ['entertainer', 'performer', 'entertainment'],
  'Party Hire': ['party'],

  // Tutoring & Lessons
  'Academic Tutoring': ['tutor', 'tutoring', 'academic', 'maths', 'english'],
  'Music Lessons': ['music', 'singing', 'guitar', 'piano'],
  'Dance Lessons': ['dance', 'dancing'],
  'Art Classes': ['art', 'painting'],
  'Driving Lessons': ['driving'],

  // Professional & Business Services
  'Accounting & Taxation': ['accounting', 'accountant', 'tax', 'taxation'],
  'Legal & Immigration': ['legal', 'lawyer', 'immigration', 'visa', 'migration'],
  'Finance': ['finance', 'financial'],
  'Insurance': ['insurance'],

  // Groceries & Shops
  'Indian Groceries': ['groceries', 'grocery'],
  'Fruit & Veg': ['fruit', 'vegetables', 'produce'],
  'Butchers': ['butcher', 'butchers', 'meat', 'halal'],
  'Dairy': ['dairy', 'milk'],

  // Travel & Tourism
  'Tour Guides & Operators': ['tour', 'tours'],
  'Travel Agents': ['travel', 'flights', 'holiday'],
};

/**
 * Normalize word for plural handling
 * snacks → snack, groceries → grocery
 */
const normalize = (word) => {
  if (word.endsWith('ies') && word.length > 4) {
    return word.slice(0, -3) + 'y';  // groceries → grocery
  }
  if (word.endsWith('s') && word.length > 3) {
    return word.slice(0, -1);  // snacks → snack
  }
  return word;
};

/**
 * Check if a word matches any term in the list (with plural handling)
 */
const matchesTerm = (word, terms) => {
  const normalizedWord = normalize(word);
  return terms.some(term => {
    const normalizedTerm = normalize(term);
    return term === word || normalizedTerm === normalizedWord;
  });
};

/**
 * Get categories that match a search term
 * Splits into words and checks each word (with plural handling)
 *
 * @param {string} searchTerm - User's search input
 * @returns {string[]} - Matching category names
 */
export const getCategories = (searchTerm) => {
  if (!searchTerm) return [];

  const words = searchTerm.toLowerCase().trim().split(/\s+/);
  const matchedCategories = new Set();

  for (const word of words) {
    for (const [category, terms] of Object.entries(CATEGORY_MAPPINGS)) {
      if (matchesTerm(word, terms)) {
        matchedCategories.add(category);
      }
    }
  }

  return Array.from(matchedCategories);
};

export default CATEGORY_MAPPINGS;
