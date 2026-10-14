// Jest config for this pure-ESM backend. No transform: tests run as native ES modules via
// node --experimental-vm-modules (set in the "test" script). Runs serially (--runInBand from the
// script) so suites sharing the test DB never race; each wipes its collections after every test.
export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.db.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {},
  verbose: true,
};
