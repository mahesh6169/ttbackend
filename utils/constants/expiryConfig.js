// Category-based expiry configuration for adverts
// All users (including admin) follow the same expiry rules based on category

export const CATEGORY_EXPIRY_DAYS = {
  // Short expiry for time-sensitive categories (30 days)
  'Full Time': 30,
  'Casual': 30,
  'Part Time': 30,

  // Medium expiry for services (180 days / 6 months)
  'Driving Lessons': 365,
  'Home Repairs & Improvements': 365,
  'Car Servicing & Repairs': 365,
  'Electricians': 365,
  'Plumbing & Gas': 365,
  'Landscaping & Gardening': 365,
  'Air Conditioning & Refrigeration': 365,
  'Water Filtration & Purification': 365,
  'Computer & Mobile Repairs': 365,
  'Cabinet Makers': 365,
  'Handyman & Flatpacks': 365,
  'Sewing & Alterations': 365,
  'Packers & Movers': 365,
  'Accounting & Taxation': 365,
  'Real Estate & Buyers Agents': 365,
  'Restaurants & Cafes': 365,
  'Catering': 365,
  'Cakes': 365,
  'Chat & Street Food': 365,
  'Sweets & Snacks': 365,
  'DJ & Audio Visual': 365,
  'Decorations': 365,
  'Entertainers & Performers': 365,
  'Party Hire': 365,
  'Painters': 365,
  'Cleaning & Maintenance': 365,
  'Pest Control': 365,
  'Photography & Videography': 365,
  'Hair, Makeup & Waxing': 365,
  'Massage': 365,
  'Yoga': 365,
  'Priest & Pooja': 365,
  'Matrimony': 365,
  'Marriage Celebrants': 365,
  'Courier & Delivery': 365,
  'Taxi & Transfers': 365,
  'Academic Tutoring': 365,
  'Music Lessons': 365,
  'Dance Lessons': 365,
  'Art Classes': 365,
  'Sports Coaching': 365,
  
  // Long expiry for property and vehicles (365 days / 1 year)
  'Sell, Rent & Share': 365,
  'Cars & Vehicles': 365,

  // Standard expiry for products (365 days / 1 year)
  'Books, Art & Collectables': 180,
  'Baby & Kids': 180,
  'Music & Games': 180,
  'Fashion & Accessories': 180,
  'Health, Sport & Fitness': 180,
  'Home & Decor': 180,
  'Garden & Outdoor': 180,
  'Pet Supplies': 180,
  'Building Materials': 180,
  'Electronics & Computers': 180,

  // Professional services (365 days / 1 year)
  'Legal & Immigration': 365,
  'Financial & Insurance': 365,
  'Logo Services': 365,
  'Business IT': 365,
  'Website Design': 365,
  'Tour Guides & Operators': 365,
  'Travel Agents': 365,
  'Indian Groceries': 365,
  'Fruit & Veg': 365,
  'Butchers': 365,
  'Plant Nursery': 365,

  // Child & Aged Care
  'Childcare & Babysitting': 365,
  'Aged Parent Care': 365,
  'Domestic Help': 365
};

// Get expiry days for a category
export const getCategoryExpiryDays = (category) => {
  return CATEGORY_EXPIRY_DAYS[category] || 365; // Default to 1 year if category not found
};