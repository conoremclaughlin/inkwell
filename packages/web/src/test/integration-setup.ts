/**
 * Integration Test Pre-flight Checks
 *
 * Loads env vars from root .env.local and verifies Supabase credentials.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load root .env.local (has SUPABASE_SECRET_KEY)
config({ path: resolve(__dirname, '../../../../.env.local') });

// Also load web-specific .env.local (has SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
config({ path: resolve(__dirname, '../../.env.local') });

// Reject production environment
if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run integration tests in production environment');
}

// Verify Supabase credentials
if (!process.env.SUPABASE_URL) {
  throw new Error(
    'Integration tests require SUPABASE_URL.\n' + 'Ensure .env.local is configured correctly.'
  );
}

if (!process.env.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error(
    'Integration tests require SUPABASE_PUBLISHABLE_KEY.\n' +
      'Ensure packages/web/.env.local is configured correctly.'
  );
}

const hasServiceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!hasServiceKey) {
  throw new Error(
    'Integration tests require SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_KEY) for admin operations.\n' +
      'Ensure root .env.local is configured correctly.'
  );
}
