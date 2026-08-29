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
      claim_token: string | null;
      occurrence_count: number;
    }>;
    // The severity travels with the row so settling can report what it was
    // dispatching without every call site restating it.
    return { ...rows[0], severity: args.severity ?? 'warning' };
  };

  type IngestResult = Awaited<ReturnType<typeof ingest>>;

  /**
   * Ingest only takes the *claim*; the dispatcher records the outcome. These
   * two mirror what AlertDispatchService.settleClaim() does after fan-out, so
   * a test that means "this alert was delivered" has to say so — the same way
   * production does. Before the claim split, ingest implied delivery on its
   * own, which is exactly the conflation that let an all-sinks-failed dispatch
   * start an hour of cooldown.
   *
   * Both take the whole ingest result rather than an id, because settling is
   * fenced on the claim token: a dispatcher may only settle the claim it
   * actually holds.
   */
  const markNotified = async (row: IngestResult) => {
    const { error } = await client.rpc('mark_alert_notified', {
      p_event_id: row.event_id,
      p_claim_token: row.claim_token,
      p_severity: row.severity,
    } as never);
    if (error) throw new Error(error.message);
  };

  const releaseClaim = async (row: IngestResult) => {
    const { error } = await client.rpc('release_alert_claim', {
      p_event_id: row.event_id,
      p_claim_token: row.claim_token,
    } as never);
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
    await markNotified(first);
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
    await markNotified(first);
    const improved = await ingest({ dedupeKey: k, severity: 'warning' });

    expect(improved.should_notify).toBe(false);
  });

  it('re-notifies once the cooldown has elapsed', async () => {
    const k = key('cooldown-expiry');
    const first = await ingest({ dedupeKey: k });
    await markNotified(first);

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
    await markNotified(first);
    const second = await ingest({ dedupeKey: k, cooldownSeconds: 0 });
    expect(second.should_notify).toBe(true);
  });

  it('resolves exactly once, then opens a fresh incident on recurrence', async () => {
    const k = key('resolve');
    const first = await ingest({ dedupeKey: k });
    // was_notified below now means a sink genuinely delivered, so the test has
    // to say that happened rather than let ingest imply it.
    await markNotified(first);
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
      await releaseClaim(first);

      const second = await ingest({ dedupeKey: k });
      expect(second.should_notify).toBe(true);
      expect(second.occurrence_count).toBe(2);
      // Still one incident — retrying the notification must not fork the row.
      expect(await openRowsFor(k)).toHaveLength(1);
    });

    it('does not announce recovery for an incident that was never delivered', async () => {
      const k = key('never-delivered');

      const first = await ingest({ dedupeKey: k });
      await releaseClaim(first);

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

      await markNotified(first);

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
      await markNotified(first);

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

  /**
   * Claim ownership and the delivered-severity fence (PR #539 r3, Lumen).
   *
   * Escalation deliberately runs two dispatchers at once, which made "a
   * notification went out recently" a claim about the wrong thing. The round-two
   * design could not tell WHICH severity had been delivered, nor WHO held the
   * claim, so a warning could settle a critical's claim and then lend the
   * critical its cooldown.
   */
  describe('claims are owned, and cooldowns are earned per severity', () => {
    it('does not suppress a critical whose fan-out failed while a warning succeeded', async () => {
      const k = key('severity-fence');

      // 1. warning claims; its dispatcher (A) starts a fan-out.
      const warning = await ingest({ dedupeKey: k, severity: 'warning' });
      expect(warning.should_notify).toBe(true);

      // 2. critical arrives mid-flight and claims too (escalation overrides).
      const critical = await ingest({ dedupeKey: k, severity: 'critical' });
      expect(critical.should_notify).toBe(true);
      expect(critical.claim_token).not.toBe(warning.claim_token);

      // 3. A succeeds — but it delivered the WARNING, not the critical.
      await markNotified(warning);

      // 4. B's critical fan-out fails and releases its own claim.
      await releaseClaim(critical);

      // 5. The next critical must claim again. Before the fence it saw
      //    severity=critical plus a recent last_notified_at and went quiet, so
      //    the critical was never delivered at all — the user heard only the
      //    warning and then silence.
      const retry = await ingest({ dedupeKey: k, severity: 'critical' });
      expect(retry.should_notify).toBe(true);
    });

    it('records a superseded dispatcher’s delivery without clearing the live claim', async () => {
      const k = key('supersede-settle');

      const warning = await ingest({ dedupeKey: k, severity: 'warning' });
      const critical = await ingest({ dedupeKey: k, severity: 'critical' });

      // The superseded dispatcher settles. Its delivery is real and must be
      // recorded, but the claim it is settling is no longer its own.
      await markNotified(warning);

      const { data } = await client
        .from('alert_events')
        .select('notify_claim_token, last_delivered_severity, last_notified_at')
        .eq('id', critical.event_id)
        .single();

      expect(data?.last_notified_at).not.toBeNull();
      expect(data?.last_delivered_severity).toBe('warning');
      // The critical is still in flight and still owns the claim.
      expect(data?.notify_claim_token).toBe(critical.claim_token);
    });

    it('ignores a settle from a stale token', async () => {
      const k = key('stale-settle');

      const first = await ingest({ dedupeKey: k });
      expect(first.should_notify).toBe(true);

      // Reap the claim the way the TTL does, handing it to a successor.
      const { error } = await client
        .from('alert_events')
        .update({ notify_claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
        .eq('id', first.event_id);
      if (error) throw new Error(error.message);

      const successor = await ingest({ dedupeKey: k });
      expect(successor.should_notify).toBe(true);
      expect(successor.claim_token).not.toBe(first.claim_token);

      // The reaped holder wakes up and releases. It must not free the
      // successor's claim — two live dispatchers is what the claim prevents.
      await releaseClaim(first);

      const { data } = await client
        .from('alert_events')
        .select('notify_claim_token')
        .eq('id', first.event_id)
        .single();
      expect(data?.notify_claim_token).toBe(successor.claim_token);
    });

    it('keeps the delivered severity at its high-water mark', async () => {
      const k = key('delivered-high-water');

      const critical = await ingest({ dedupeKey: k, severity: 'critical' });
      await markNotified(critical);

      // A later, lesser delivery must not demote the record and thereby
      // re-open the fence for a severity that already got through.
      const info = await ingest({ dedupeKey: k, severity: 'info', cooldownSeconds: 0 });
      await markNotified(info);

      const { data } = await client
        .from('alert_events')
        .select('last_delivered_severity')
        .eq('id', critical.event_id)
        .single();
      expect(data?.last_delivered_severity).toBe('critical');
    });

    it('grants exactly one claim token when concurrent posts race', async () => {
      const k = key('concurrent-claim');

      // The dedupe race, now also asserted on the claim: six posts, one
      // incident, and exactly one dispatcher authorised to notify.
      const results = await Promise.all(Array.from({ length: 6 }, () => ingest({ dedupeKey: k })));

      expect(results.every((r) => r.event_id === results[0].event_id)).toBe(true);
      const claimants = results.filter((r) => r.should_notify);
      expect(claimants).toHaveLength(1);
      expect(claimants[0].claim_token).not.toBeNull();
      // Non-claimants must carry no token to settle with.
      expect(results.filter((r) => !r.should_notify).every((r) => r.claim_token === null)).toBe(
        true
      );
      expect(await openRowsFor(k)).toHaveLength(1);
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
