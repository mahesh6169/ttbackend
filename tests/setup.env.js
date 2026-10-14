// Runs BEFORE any test module is imported (jest setupFiles). Loads the isolated test env and
// enforces the three absolute stream-separation guards. If any guard fails the whole run aborts
// loudly - a test process must never be able to reach dev data or live Stripe.
import { config } from 'dotenv';
import path from 'path';

// Load .env.test from the backend root (jest cwd). dotenv does not override already-set vars.
config({ path: path.resolve(process.cwd(), '.env.test') });

// Guard 1: database name must end with _test.
const dbName = (process.env.MONGO_URI || '').split('?')[0].split('/').pop();
if (!dbName.endsWith('_test')) {
  throw new Error(`[TEST GUARD] MONGO_URI database must end with "_test" (got "${dbName}"). Refusing to run.`);
}

// Guard 2: Stripe key must be a test key.
if (!(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test')) {
  throw new Error('[TEST GUARD] STRIPE_SECRET_KEY must be an sk_test key. Refusing to run.');
}

// Guard 3: NODE_ENV must be test.
if (process.env.NODE_ENV !== 'test') {
  throw new Error(`[TEST GUARD] NODE_ENV must be "test" (got "${process.env.NODE_ENV}"). Refusing to run.`);
}

console.log(`✅ [TEST GUARD] passed - db "${dbName}", Stripe test key, NODE_ENV=test`);
