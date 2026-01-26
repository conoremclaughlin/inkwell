/**
 * Vitest Setup
 *
 * Runs before all tests to set up the environment
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local for test environment
config({ path: resolve(__dirname, '../../.env.local') });

// Ensure we're not accidentally hitting production
if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run tests in production environment');
}
