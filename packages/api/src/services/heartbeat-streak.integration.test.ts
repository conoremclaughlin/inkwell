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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from '../data/supabase/types';
import {
  FAILURE_STREAK_ORDER_COLUMN,
  selectFailureStreakWindow,
  selectLastDeliveredBeat,
} from './heartbeat';

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

  /**
   * The window that hid the boundary, on the real table.
   *
   * Round nine of Lumen's review. The boundary used to be a by-product of the
   * streak walk, so it inherited that walk's 50-row window — and after fifty
   * failed beats the healthy beat that separates this outage from the last one
   * is simply not in the rows that come back. The walk then reports "no healthy
   * beat", which the store reads as "reuse the open episode", and the episode it
   * reuses is a finished one whose alert already went out. Every retry from
   * there is suppressed.
   *
   * Both halves are asserted here, against real rows, because each alone would
   * be comfortable rather than convincing: that the streak window genuinely
   * truncates (so the bug was real and not a story about LIMIT), and that the
   * boundary query reaches past it anyway (so the fix is real).
   */
  describe('the episode boundary behind a full window of failures', () => {
    const userId = randomUUID();
    const reminderId = randomUUID();
    // Old enough to be pushed out of the window by the failures stacked above.
    const healthyAt = new Date('2026-09-01T00:00:00.000Z');

    beforeAll(async () => {
      await client.from('users').insert({
        id: userId,
        email: `heartbeat-streak-${reminderId}@example.test`,
      } as never);
      await client.from('scheduled_reminders').insert({
        id: reminderId,
        user_id: userId,
        title: 'streak window integration fixture',
        delivery_channel: 'telegram',
        delivery_target: 'chat-1',
        next_run_at: new Date().toISOString(),
        status: 'active',
      } as never);

      // One delivered beat, then a full window of failures on top of it. Exactly
      // FAILURE_STREAK_LOOKBACK failures is the threshold: at 49 the delivered
      // row still makes it into the window, which is the passing control Lumen
      // ran. At 50 it does not.
      await client.from('reminder_history').insert([
        { reminder_id: reminderId, status: 'delivered', triggered_at: healthyAt.toISOString() },
        ...Array.from({ length: 50 }, (_, i) => ({
          reminder_id: reminderId,
          status: 'failed',
          error_message: 'backend not authenticated',
          triggered_at: new Date(healthyAt.getTime() + (i + 1) * 3_600_000).toISOString(),
        })),
      ] as never);
    });

    afterAll(async () => {
      // ON DELETE CASCADE takes the history rows with it.
      await client.from('scheduled_reminders').delete().eq('id', reminderId);
      await client.from('users').delete().eq('id', userId);
    });

    it('truncates the healthy beat out of the streak window', async () => {
      const { data, error } = await selectFailureStreakWindow(client, reminderId);

      expect(error).toBeNull();
      expect(data).toHaveLength(50);
      // Every row in range is a failure, so a walk over them stops at the end of
      // the window and has no healthy beat to report. This is the bug's premise,
      // measured rather than asserted from the LIMIT.
      expect(data!.every((row) => row.status === 'failed')).toBe(true);
    });

    it('finds the healthy beat anyway, because the boundary has no window', async () => {
      const { data, error } = await selectLastDeliveredBeat(client, reminderId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(new Date(data![0].triggered_at!).toISOString()).toBe(healthyAt.toISOString());
    });
  });
});
