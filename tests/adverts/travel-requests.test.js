// Listings > Travel Requests (parcel carrying, travel companion for parents): the category exists,
// a Wanted ad needs no price list, a "Fixed amount" budget (kept in fields) must be 0 or more,
// and these ads expire after 60 days.
import { validateAdvertData } from '../../utils/validators/advertValidator.js';
import { isValidCategoryCombo } from '../../utils/constants/categories.js';
import { getCategoryExpiryDays } from '../../utils/constants/expiryConfig.js';

const address = JSON.stringify({ formattedAddress: '1 Test St, Parramatta NSW 2150' });

const travelAd = (fields, overrides = {}) => ({
  title: 'Parcel Sydney to Hyderabad',
  category: 'Travel Requests',
  subcategory: 'Parcel Carrying',
  description: 'Small box, about 2 kg.',
  adType: 'wanted',
  pricing: [],
  address,
  fields,
  ...overrides,
});

const check = (data) => validateAdvertData(data, 'user', data.subcategory);

test('Travel Requests offers Parcel Carrying and Travel Companion for Parents', () => {
  expect(isValidCategoryCombo('Travel Requests', 'Parcel Carrying')).toBe(true);
  expect(isValidCategoryCombo('Travel Requests', 'Travel Companion for Parents')).toBe(true);
  expect(isValidCategoryCombo('Buy & Sell', 'Parcel Carrying')).toBe(false);
});

test('a Wanted parcel request with a fixed budget is accepted without a price list', () => {
  const res = check(travelAd({ fromPlace: 'NSW', toPlace: 'India', budgetType: 'Fixed amount', budgetAmount: 40 }));
  expect(res).toEqual({ valid: true, errors: [] });
});

test('Free and Negotiable budgets need no amount', () => {
  for (const budgetType of ['Free (favour)', 'Negotiable']) {
    const res = check(travelAd({ budgetType }, { subcategory: 'Travel Companion for Parents' }));
    expect(res).toEqual({ valid: true, errors: [] });
  }
});

test('a Fixed amount budget with no amount or a negative amount is refused', () => {
  for (const budgetAmount of [undefined, '', -5]) {
    const res = check(travelAd({ budgetType: 'Fixed amount', budgetAmount }));
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/Budget amount/);
  }
});

test('Travel Requests ads expire after 60 days', () => {
  expect(getCategoryExpiryDays('Parcel Carrying')).toBe(60);
  expect(getCategoryExpiryDays('Travel Companion for Parents')).toBe(60);
});
