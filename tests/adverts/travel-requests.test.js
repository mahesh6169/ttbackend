// Listings > Travel Companion & Parcels (parcel, travel companion): the category exists,
// a Wanted ad needs no price list, a "Fixed amount" budget (kept in fields) must be 0 or more,
// and these ads expire after 60 days.
import { validateAdvertData } from '../../utils/validators/advertValidator.js';
import { isValidCategoryCombo } from '../../utils/constants/categories.js';
import { getCategoryExpiryDays } from '../../utils/constants/expiryConfig.js';

const address = JSON.stringify({ formattedAddress: '1 Test St, Parramatta NSW 2150' });

const travelAd = (fields, overrides = {}) => ({
  title: 'Parcel Sydney to Hyderabad',
  category: 'Travel Companion & Parcels',
  subcategory: 'Parcel',
  description: 'Small box, about 2 kg.',
  adType: 'wanted',
  pricing: [],
  address,
  fields,
  ...overrides,
});

const check = (data) => validateAdvertData(data, 'user', data.subcategory);

test('Travel Companion & Parcels offers Parcel and Travel Companion', () => {
  expect(isValidCategoryCombo('Travel Companion & Parcels', 'Parcel')).toBe(true);
  expect(isValidCategoryCombo('Travel Companion & Parcels', 'Travel Companion')).toBe(true);
  expect(isValidCategoryCombo('Buy & Sell', 'Parcel')).toBe(false);
});

test('a Wanted parcel request with a fixed budget is accepted without a price list', () => {
  const res = check(travelAd({ fromPlace: 'Sydney / NSW', toPlace: 'India', toCity: 'Hyderabad', budgetType: 'Fixed amount', budgetAmount: 40 }));
  expect(res).toEqual({ valid: true, errors: [] });
});

test('Free and Negotiable budgets need no amount', () => {
  for (const budgetType of ['Favour', 'Negotiable']) {
    const res = check(travelAd({ budgetType }, { subcategory: 'Travel Companion' }));
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

test('Travel Companion & Parcels ads expire after 60 days', () => {
  expect(getCategoryExpiryDays('Parcel')).toBe(60);
  expect(getCategoryExpiryDays('Travel Companion')).toBe(60);
});

test('a travel date must be a plain date; empty is fine', () => {
  const ok = check(travelAd({ travelDate: '2026-12-20', budgetType: 'Negotiable' }));
  expect(ok.valid).toBe(true);
  expect(check(travelAd({ budgetType: 'Negotiable' })).valid).toBe(true);
  const bad = check(travelAd({ travelDate: '20 Dec', budgetType: 'Negotiable' }));
  expect(bad.valid).toBe(false);
  expect(bad.errors.join(' ')).toMatch(/Travel date/);
});

test('From and To are fixed places; India also needs a city, and one end must be in Australia', () => {
  const route = (extra) => check(travelAd({ budgetType: 'Negotiable', ...extra }));
  expect(route({ fromPlace: 'Perth / WA', toPlace: 'Sydney / NSW' }).valid).toBe(true);
  expect(route({ fromPlace: 'India', fromCity: 'Hyderabad', toPlace: 'Sydney / NSW' }).valid).toBe(true);
  expect(route({ fromPlace: 'Sydney / NSW', toPlace: 'India', toCity: 'Chennai' }).valid).toBe(true);
  expect(route({ fromPlace: 'India', fromCity: 'Delhi', toPlace: 'India', toCity: 'Chennai' }).valid).toBe(false);
  expect(route({ fromPlace: 'Atlantis', toPlace: 'Sydney / NSW' }).valid).toBe(false);
  const noCity = route({ fromPlace: 'India', toPlace: 'Sydney / NSW' });
  expect(noCity.valid).toBe(false);
  expect(noCity.errors.join(' ')).toMatch(/from city/);
});
