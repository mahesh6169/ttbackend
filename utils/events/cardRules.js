// Which cards can pay for event tickets (feature 1016): Australian-issued Visa, Mastercard or Amex.
// Credit, debit and prepaid are all fine (no funding check). Checked twice: when the buyer clicks
// Pay (check-card, before Stripe holds any money) and again just before the money is taken
// (fulfilPaidOrder), so a card that slipped past the first check is released, never charged.
import stripe from '../../config/stripe.js';

export const ACCEPTED_CARD_BRANDS = ['visa', 'mastercard', 'amex'];
export const ACCEPTED_CARD_COUNTRY = 'AU';
export const CARD_NOT_ACCEPTED_MESSAGE =
  'Sorry, we only accept Australian-issued Visa, Mastercard or Amex. Please try another card.';

// card = a Stripe PaymentMethod's `card` object ({ brand, country, ... }).
export const isCardAccepted = (card) =>
  !!card &&
  ACCEPTED_CARD_BRANDS.includes(String(card.brand || '').toLowerCase()) &&
  String(card.country || '').toUpperCase() === ACCEPTED_CARD_COUNTRY;

// The card behind a payment method (id or expanded object), on the organiser's Stripe account.
// Returns null when there is no card to look at.
export const cardOf = async (paymentMethod, stripeAccount) => {
  if (!paymentMethod) return null;
  if (typeof paymentMethod === 'object') return paymentMethod.card || null;
  const pm = await stripe.paymentMethods.retrieve(paymentMethod, {}, { stripeAccount });
  return pm?.card || null;
};
