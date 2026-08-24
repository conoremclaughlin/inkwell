/**
 * Alert ingest — Integration Tests
 *
 * The dedupe, cooldown and escalation rules live in SQL
 * (`ingest_alert_event` / `resolve_alert_event`), so the unit tests over
 * `alert-policy.ts` cannot reach them. Without this suite the heart of the
 * feature would be exercised only by hand.
 *
 * The concurrency case is the one that matters most. Ingest is written as a
 * single INSERT ... ON CONFLICT precisely so two checkers posting the same
 * condition at once cannot lose alarms to a duplicate-key error — the same
 * read-then-write race fixed in #536. That property is invisible to a
 * sequential test, so it is asserted directly.
 *
 * Requires:
 *   - .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY
 *
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';

const projectRoot = resolve(__dirname, '../../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const TEST_USER_ID: string | undefined = INTEGRATION_TEST_USER_ID;
const canRun = !!SUPABASE_URL && !!SUPABASE_KEY && !!TEST_USER_ID;

/**
 * Sibling suites share the seeded integration user and vitest runs files in
 * parallel, so every dedupe key is namespaced to this run. Without it, two
 * suites raising "the same" condition would collapse onto one incident and
 * assert against each other's occurrence counts.
 */
const RUN = `itest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const key = (name: string) => `${RUN}:${name}`;

describe.skipIf(!canRun)('alert ingest SQL (integration)', () => {
  let client: SupabaseClient;

  const ingest = async (args: {
    dedupeKey: string;
    severity?: 'info' | 'warning' | 'critical';
    title?: string;
    cooldownSeconds?: number;
    source?: string;
  }) => {
    const { data, error } = await client.rpc('ingest_alert_event', {
      p_user_id: TEST_USER_ID!,
      p_source: args.source ?? 'itest-monitor',
      p_severity: args.severity ?? 'warning',
      p_title: args.title ?? 'Integration test alert',
      p_dedupe_key: args.dedupeKey,
      p_cooldown_seconds: args.cooldownSeconds ?? 3600,
    } as never);
    if (error) throw new Error(error.message);
    const rows = data as unknown as Array<{
      event_id: string;
      is_new: boolean;
      should_notify: boolean;
      occurrence_count: number;
    }>;
    return rows[0];
  };

  const openRowsFor = async (dedupeKey: string) => {
    const { data, error } = await client
      .from('alert_events')
      .select('id, occurrence_count, severity, resolved_at')
      .eq('user_id', TEST_USER_ID!)
      .eq('dedupe_key', dedupeKey)
      .is('resolved_at', null);
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  beforeAll(() => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.from('alert_events').delete().like('dedupe_key', `${RUN}:%`);
    await client.from('alert_sources').delete().like('source', 'itest-%');
  });

  it('raises a new incident and notifies', async () => {
    const k = key('first-raise');
    const result = await ingest({ dedupeKey: k });
    expect(result.is_new).toBe(true);
    expect(result.should_notify).toBe(true);
    expect(result.occurrence_count).toBe(1);
  });

  it('collapses a repeat onto the same incident and stays silent inside the cooldown', async () => {
    const k = key('cooldown');
    await ingest({ dedupeKey: k });
    const second = await ingest({ dedupeKey: k });

    expect(second.is_new).toBe(false);
    expect(second.should_notify).toBe(false);
    expect(second.occurrence_count).toBe(2);
    // A 5-minute cron must not become 288 messages a day.
    expect(await openRowsFor(k)).toHaveLength(1);
  });

  it('re-notifies immediately on escalation, even mid-cooldown', async () => {
    const k = key('escalation');
    await ingest({ dedupeKey: k, severity: 'warning' });
    const escalated = await ingest({ dedupeKey: k, severity: 'critical' });

    // A condition getting worse is new information; the cooldown must not
    // suppress it.
    expect(escalated.should_notify).toBe(true);
    expect(escalated.occurrence_count).toBe(2);
  });

  it('does not re-notify on de-escalation', async () => {
    const k = key('de-escalation');
    await ingest({ dedupeKey: k, severity: 'critical' });
    const improved = await ingest({ dedupeKey: k, severity: 'warning' });

    expect(improved.should_notify).toBe(false);
  });

  it('re-notifies once the cooldown has elapsed', async () => {
    const k = key('cooldown-expiry');
    await ingest({ dedupeKey: k });

    // Backdate rather than sleep an hour.
    const { error } = await client
      .from('alert_events')
      .update({ last_notified_at: new Date(Date.now() - 2 * 3600_000).toISOString() })
      .eq('user_id', TEST_USER_ID!)
      .eq('dedupe_key', k)
      .is('resolved_at', null);
    if (error) throw new Error(error.message);

    const after = await ingest({ dedupeKey: k });
    expect(after.should_notify).toBe(true);
  });

  it('honours a zero cooldown by notifying every time', async () => {
    const k = key('zero-cooldown');
    await ingest({ dedupeKey: k, cooldownSeconds: 0 });
    const second = await ingest({ dedupeKey: k, cooldownSeconds: 0 });
    expect(second.should_notify).toBe(true);
  });

  it('resolves exactly once, then opens a fresh incident on recurrence', async () => {
    const k = key('resolve');
    await ingest({ dedupeKey: k });
    await ingest({ dedupeKey: k });

    const { data: firstResolve, error: e1 } = await client.rpc('resolve_alert_event', {
      p_user_id: TEST_USER_ID!,
      p_dedupe_key: k,
    } as never);
    if (e1) throw new Error(e1.message);
    const resolvedRows = firstResolve as unknown as Array<{
      occurrence_count: number;
      was_notified: boolean;
    }>;
    expect(resolvedRows).toHaveLength(1);
    expect(resolvedRows[0].occurrence_count).toBe(2);
    expect(resolvedRows[0].was_notified).toBe(true);

    // Recovery is announced once, no matter how many 'ok' posts arrive.
    const { data: secondResolve, error: e2 } = await client.rpc('resolve_alert_event', {
      p_user_id: TEST_USER_ID!,
      p_dedupe_key: k,
    } as never);
    if (e2) throw new Error(e2.message);
    expect(secondResolve as unknown as unknown[]).toHaveLength(0);

    // The same condition recurring is a new incident, not a resurrection.
    const recurrence = await ingest({ dedupeKey: k });
    expect(recurrence.is_new).toBe(true);
    expect(recurrence.occurrence_count).toBe(1);
    expect(await openRowsFor(k)).toHaveLength(1);
  });

  it('loses no alarms when the same condition is posted concurrently', async () => {
    const k = key('concurrent');
    const CONCURRENCY = 8;

    // Read-then-write would refuse all but one of these with a duplicate key
    // error on alert_events_open_dedupe_idx, silently dropping the rest.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => ingest({ dedupeKey: k }))
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? '')).toEqual([]);

    const open = await openRowsFor(k);
    expect(open).toHaveLength(1);
    // Every observation counted — the contract is that no post is dropped.
    expect(open[0].occurrence_count).toBe(CONCURRENCY);

    // Exactly one of the concurrent posts wins the right to notify; the rest
    // are suppressed by the cooldown rather than each sending a message.
    const notified = results.filter((r) => r.status === 'fulfilled' && r.value.should_notify);
    expect(notified).toHaveLength(1);
  });

  it('keeps distinct conditions in distinct incidents', async () => {
    const a = key('distinct-a');
    const b = key('distinct-b');
    await ingest({ dedupeKey: a });
    await ingest({ dedupeKey: b });

    expect(await openRowsFor(a)).toHaveLength(1);
    expect(await openRowsFor(b)).toHaveLength(1);
  });
});
