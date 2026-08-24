/**
 * Integration Test Pre-flight Checks + Fixture Seeding
 *
 * Runs before integration tests to verify:
 * - required environment variables are present
 * - by default, SUPABASE_URL points at localhost
 * - Not running against production
 *
 * Then seeds the fixture user the DB integration tests depend on (see
 * seedTestUser below for why).
 */

import { beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { INTEGRATION_TEST_USER_ID } from './integration-fixtures';

// Node's URL.hostname keeps the brackets on IPv6 literals ('[::1]'), so both
// spellings are listed (Lumen, PR #439 round-4 non-blocking note).
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Reject production environment
if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run integration tests in production environment');
}

// Verify Supabase credentials are available (supports both naming conventions)
const hasSupabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!process.env.SUPABASE_URL || !hasSupabaseKey) {
  throw new Error(
    'Integration tests require SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_KEY).\n' +
      'Set these explicitly (recommended) or via scripts/test-integration-db-local.sh.'
  );
}

// Safety guard: default to local-only integration DB targets unless explicitly overridden.
if (process.env.INK_ALLOW_REMOTE_INTEGRATION_DB !== '1') {
  let hostname: string;
  try {
    hostname = new URL(process.env.SUPABASE_URL).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${process.env.SUPABASE_URL}`);
  }

  if (!LOCALHOST_HOSTS.has(hostname)) {
    throw new Error(
      [
        `Refusing to run integration tests against non-local SUPABASE_URL host: ${hostname}`,
        'Use a local Supabase stack (scripts/test-integration-db-local.sh), or set',
        'INK_ALLOW_REMOTE_INTEGRATION_DB=1 if you intentionally want a remote target.',
      ].join('\n')
    );
  }
}

/**
 * Seed the CANONICAL SYNTHETIC fixture user the DB integration tests FK
 * against (INTEGRATION_TEST_USER_ID from integration-fixtures.ts).
 *
 * The DB integration suites (task-handlers, strategy-*) insert rows whose
 * user_id references users.id. A freshly-migrated isolated Supabase has no
 * user rows, so every one of those inserts died on `task_groups_user_id_fkey`
 * — 11 failures that looked like product bugs but were a missing fixture.
 *
 * The seeded id is the synthetic constant, NEVER a developer's organic
 * ~/.ink/config.json id: the organic id doesn't exist on CI (which made these
 * suites silently skip there — Lumen, PR #439 review) and organic user ids
 * don't belong in test rows.
 *
 * INTENTIONAL (Conor, 2026-08-12): the suites seeded here are token-free —
 * server/DB round-trips, no LLM calls — which is why they run in CI at all.
 * LIVE suites (*.live.*, gated on INK_LIVE_TESTS=1) consume real LLM tokens
 * and are DELIBERATELY excluded from CI as a cost decision, not an oversight.
 *
 * Guards:
 * - LOCALHOST ONLY. We never write fixture rows into a remote database, even
 *   when INK_ALLOW_REMOTE_INTEGRATION_DB=1 — a remote target is assumed to be a
 *   real DB that already has its users.
 * - Idempotent: check first, insert only when missing, so repeat runs and
 *   parallel vitest workers don't collide.
 */
async function seedTestUser(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY)!;

  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    return;
  }
  if (!LOCALHOST_HOSTS.has(hostname)) return;

  const userId = INTEGRATION_TEST_USER_ID;

  const client = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: existing, error: selectError } = await client
    .from('users')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (selectError) {
    // Surface the real cause instead of letting it resurface downstream as a
    // confusing FK violation. "permission denied" here almost always means the
    // service-role key didn't make it through (an empty SUPABASE_SECRET_KEY
    // makes PostgREST fall back to the anon role).
    throw new Error(
      [
        `Integration setup: could not query users on ${hostname}: ${selectError.message}`,
        'If this is "permission denied", SUPABASE_SECRET_KEY is likely empty or not a',
        'service-role key — check the SERVICE_ROLE_KEY export in',
        'scripts/test-integration-db-local.sh.',
      ].join('\n')
    );
  }

  if (existing) return; // Already seeded by a previous run or worker.

  // Minimal row: only `id` is required (everything else is nullable/defaulted).
  // Keeping it minimal avoids tripping the table's UNIQUE constraints on
  // email/username/telegram_id across repeat runs.
  const { error: insertError } = await client.from('users').insert({ id: userId });

  // 23505 = unique_violation: a parallel worker seeded it between our check and
  // insert. That's the desired end state, so treat it as success.
  if (insertError && insertError.code !== '23505') {
    throw new Error(
      `Integration setup: failed to seed fixture user on ${hostname}: ${insertError.message}`
    );
  }
}

// Registered as a hook rather than top-level await: this package compiles to
// CommonJS, where top-level await isn't available. setupFiles run per test file,
// so this fires once per suite — cheap, since it's a single existence check
// after the first insert.
beforeAll(async () => {
  await seedTestUser();
}, 30_000);
