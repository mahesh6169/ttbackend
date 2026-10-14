// /config/stripe.js

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-04-30.basil', // Match your account's API version
});

export default stripe;