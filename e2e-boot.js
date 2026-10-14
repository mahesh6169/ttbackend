// Boots the backend for Playwright E2E in the isolated test env. Reuses tests/setup.env.js to load
// .env.test and run the three stream-separation guards (db name _test, sk_test key, NODE_ENV=test),
// then starts the normal server (which connects to the test DB and listens on PORT 5100).
import './tests/setup.env.js';
await import('./server.js');
