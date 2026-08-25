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

  /**
   * Ingest only takes the *claim*; the dispatcher records the outcome. These
   * two mirror what AlertDispatchService.settleClaim() does after fan-out, so
   * a test that means "this alert was delivered" has to say so — the same way
   * production does. Before the claim split, ingest implied delivery on its
   * own, which is exactly the conflation that let an all-sinks-failed dispatch
   * start an hour of cooldown.
   */
  const markNotified = async (eventId: string) => {
    const { error } = await client.rpc('mark_alert_notified', { p_event_id: eventId } as never);
    if (error) throw new Error(error.message);
  };

  const releaseClaim = async (eventId: string) => {
    const { error } = await client.rpc('release_alert_claim', { p_event_id: eventId } as never);
    if (error) throw new Error(error.message);
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
    const first = await ingest({ dedupeKey: k });
    await markNotified(first.event_id);
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
    const first = await ingest({ dedupeKey: k, severity: 'critical' });
    await markNotified(first.event_id);
    const improved = await ingest({ dedupeKey: k, severity: 'warning' });

    expect(improved.should_notify).toBe(false);
  });

  it('re-notifies once the cooldown has elapsed', async () => {
    const k = key('cooldown-expiry');
    const first = await ingest({ dedupeKey: k });
    await markNotified(first.event_id);

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
    const first = await ingest({ dedupeKey: k, cooldownSeconds: 0 });
    await markNotified(first.event_id);
    const second = await ingest({ dedupeKey: k, cooldownSeconds: 0 });
    expect(second.should_notify).toBe(true);
  });

  it('resolves exactly once, then opens a fresh incident on recurrence', async () => {
    const k = key('resolve');
    const first = await ingest({ dedupeKey: k });
    // was_notified below now means a sink genuinely delivered, so the test has
    // to say that happened rather than let ingest imply it.
    await markNotified(first.event_id);
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

  /**
   * The claim/delivery split (PR #539 r2, Lumen). Ingest takes the right to
   * attempt; only a real delivery starts the cooldown. Both cases below were
   * broken when one column meant both things.
   */
  describe('claim is not delivery', () => {
    it('retries on the next occurrence when every sink failed', async () => {
      const k = key('all-sinks-failed');

      const first = await ingest({ dedupeKey: k });
      expect(first.should_notify).toBe(true);

      // Fan-out happened and nothing got out. The dispatcher releases rather
      // than marks. Previously ingest had already written last_notified_at,
      // so this condition went quiet for an hour on the strength of a
      // notification nobody received.
      await releaseClaim(first.event_id);

      const second = await ingest({ dedupeKey: k });
      expect(second.should_notify).toBe(true);
      expect(second.occurrence_count).toBe(2);
      // Still one incident — retrying the notification must not fork the row.
      expect(await openRowsFor(k)).toHaveLength(1);
    });

    it('does not announce recovery for an incident that was never delivered', async () => {
      const k = key('never-delivered');

      const first = await ingest({ dedupeKey: k });
      await releaseClaim(first.event_id);

      const { data, error } = await client.rpc('resolve_alert_event', {
        p_user_id: TEST_USER_ID!,
        p_dedupe_key: k,
      } as never);
      if (error) throw new Error(error.message);

      const rows = data as unknown as Array<{ was_notified: boolean }>;
      expect(rows).toHaveLength(1);
      // The incident closed, but nobody ever heard it open. Announcing the
      // recovery would make "Recovered: X" the first and only word about X.
      expect(rows[0].was_notified).toBe(false);
    });

    it('holds the claim while a dispatch is in flight, then frees it on success', async () => {
      const k = key('claim-held');

      const first = await ingest({ dedupeKey: k });
      expect(first.should_notify).toBe(true);

      // Claim still held (no settle yet): a second post must not start a
      // parallel fan-out for the same incident.
      const during = await ingest({ dedupeKey: k });
      expect(during.should_notify).toBe(false);

      await markNotified(first.event_id);

      const { data } = await client
        .from('alert_events')
        .select('notify_claimed_at, last_notified_at')
        .eq('id', first.event_id)
        .single();
      expect(data?.notify_claimed_at).toBeNull();
      expect(data?.last_notified_at).not.toBeNull();
    });

    it('returns should_notify as a real boolean, never null', async () => {
      // Three-valued logic caught this in CI. Once a delivery is recorded the
      // claim is cleared to NULL, so a deduped ingest keeps that NULL — and
      // `NULL = now()` is NULL, not false. The service assigns the result to a
      // `boolean` and it survived only because null is falsy in JS.
      //
      // Named explicitly so nobody relaxes the toBe(false) assertions above to
      // toBeFalsy() and silently restores the ambiguity: toBeFalsy() passes on
      // null, which is exactly the value this pins against.
      const k = key('boolean-contract');

      const first = await ingest({ dedupeKey: k });
      expect(first.should_notify).toBe(true);
      await markNotified(first.event_id);

      const deduped = await ingest({ dedupeKey: k });
      expect(deduped.should_notify).toBe(false);
      expect(deduped.should_notify).not.toBeNull();
      expect(typeof deduped.should_notify).toBe('boolean');
    });

    it('lets an escalation through even while another dispatch holds the claim', async () => {
      const k = key('escalation-vs-claim');

      const first = await ingest({ dedupeKey: k, severity: 'warning' });
      expect(first.should_notify).toBe(true);
      // Deliberately no settle — a fan-out is notionally still running.

      const escalated = await ingest({ dedupeKey: k, severity: 'critical' });
      // Two messages about a worsening incident is the acceptable direction
      // to err. Silence, because a lesser-severity send happened to be in
      // flight, is not.
      expect(escalated.should_notify).toBe(true);
    });

    it('reaps a claim whose holder died, so the condition is not wedged', async () => {
      const k = key('claim-ttl');

      const first = await ingest({ dedupeKey: k });
      expect(first.should_notify).toBe(true);

      // Simulate a dispatcher that crashed mid-fan-out: claim taken, never
      // settled. Without a TTL this condition would never notify again.
      const { error } = await client
        .from('alert_events')
        .update({ notify_claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
        .eq('id', first.event_id);
      if (error) throw new Error(error.message);

      const after = await ingest({ dedupeKey: k });
      expect(after.should_notify).toBe(true);
    });
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
