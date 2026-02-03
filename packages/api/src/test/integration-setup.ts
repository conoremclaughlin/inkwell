/**
 * Integration Test Pre-flight Checks
 *
 * Runs before integration tests to verify:
 * - Claude CLI is installed and available
 * - Environment variables are loaded
 * - Not running against production
 */

import { execSync } from 'child_process';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local from project root (4 levels up from src/test/)
config({ path: resolve(__dirname, '../../../../.env.local') });

// Verify Claude CLI is available
try {
  execSync('claude --version', { stdio: 'pipe' });
} catch {
  throw new Error(
    'Integration tests require the Claude CLI to be installed.\n' +
    'Install it from https://docs.anthropic.com/en/docs/claude-code\n' +
    'Then run: yarn test:integration'
  );
}

// Reject production environment
if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run integration tests in production environment');
}

// Verify Supabase credentials are available (supports both naming conventions)
const hasSupabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!process.env.SUPABASE_URL || !hasSupabaseKey) {
  throw new Error(
    'Integration tests require SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_KEY).\n' +
    'Ensure .env.local is configured correctly.'
  );
}
