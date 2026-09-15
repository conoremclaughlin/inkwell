/**
 * Vitest Setup
 *
 * Runs before all tests to set up the environment
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { fakeProcessEnv } from './fake-env';

const repoRoot = resolve(__dirname, '../../../../');

// Load repo-level env files if present (shell env always wins)
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env.test') });
config({ path: resolve(repoRoot, '.env') });

// Provide safe fallbacks for required vars so unit tests are runnable by default
process.env.NODE_ENV ||= 'test';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY ||= fakeProcessEnv.SUPABASE_PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY ||= fakeProcessEnv.SUPABASE_SECRET_KEY;
process.env.JWT_SECRET ||= fakeProcessEnv.JWT_SECRET;

// Ensure we're not accidentally hitting production
if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run tests in production environment');
}
