/**
 * Failure-streak query — Integration Tests (real DB)
 *
 * WHY THIS TIER, AND WHY IT EXISTS AT ALL.
 *
 * `consecutiveFailureCount` is the deduplication key for every outage alert:
 * the `consecutive > 1` guard reads it, and so does the `priorFailures > 0`
 * test that sends the all-clear. It sorts `reminder_history` by a column, and
 * on this branch that column was `created_at` — which reminder_history does
 * not have. PostgREST answers 42703, the function's catch reports a streak of
 * 0, and from there everything downstream inverts: every failed beat looks
 * like its own first failure, so an outage alerts on EVERY beat instead of
 * one, and the recovery notice the alert text promises never sends at all.
 *
 * The unit tier passed all 61 tests through that. It could not have done
 * otherwise — `order` there is `vi.fn().mockReturnValue(builder)`, which
 * accepts any string, so a column name is exactly the class of mistake a
 * mocked query builder cannot see. The schema is the only thing that knows,
 * so the test has to ask the schema.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically in CI / when credentials are unavailable.
 */

import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Database } from '../data/supabase/types';
import { FAILURE_STREAK_ORDER_COLUMN } from './heartbeat';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const d = available ? describe : describe.skip;

d('heartbeat failure streak — real schema', () => {
  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  it('sorts reminder_history by a column that exists', async () => {
    // The exact query shape `consecutiveFailureCount` issues, ordered by the
    // constant production orders by. A wrong column name comes back as
    // PostgREST 42703 rather than rows.
    const { error } = await client
      .from('reminder_history')
      .select('status')
      .in('status', ['delivered', 'failed'])
      .order(FAILURE_STREAK_ORDER_COLUMN, { ascending: false })
      .limit(1);

    expect(error).toBeNull();
  });

  it('rejects the column the streak used to sort by', async () => {
    // Pins the failure mode itself: this is what the shipped query did, and
    // what the whole unit tier reported as healthy. If `created_at` is ever
    // added to reminder_history this test goes red — at which point the guard
    // above is the one that still matters, and this one should just be
    // deleted rather than "fixed".
    const { error } = await client
      .from('reminder_history')
      .select('status')
      // @ts-expect-error — deliberately not a column of reminder_history
      .order('created_at', { ascending: false })
      .limit(1);

    expect(error).not.toBeNull();
    expect(error?.code).toBe('42703');
  });

  it('reports an unreadable streak as zero rather than throwing', async () => {
    // The catch in consecutiveFailureCount fails toward alerting, never
    // toward silence. Verifies the error is a resolved `{ error }` and not a
    // rejection, since the whole design depends on that distinction.
    const result = await client
      .from('reminder_history')
      .select('status')
      // @ts-expect-error — deliberately not a column of reminder_history
      .order('definitely_not_a_column', { ascending: false })
      .limit(1);

    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
  });
});
