/**
 * The liveness path — sweep bookkeeping and recovery.
 *
 * Both defects covered here are the same one the claim split was supposed to
 * end: state recording that something happened when it had not.
 *
 *   1. sweepStaleSources() stamped stale_alerted_at for any fulfilled ingest,
 *      including one where every sink failed and released its claim. The source
 *      then looked alreadyAlerted, later sweeps skipped it, and the retry never
 *      came (PR #539 r2, Lumen).
 *
 *   2. A healthy check-in cleared stale_alerted_at but left the liveness
 *      incident open, so a monitor that died, recovered and died again inside
 *      the cooldown deduped onto the old incident and was suppressed.
 *
 * The fake Supabase client below is deliberately thin: these tests are about
 * which writes the service decides to make, not about PostgREST.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertDispatchService } from './alert-dispatch.service';
import type { DataComposer } from '../../data/composer';

const USER = 'user-1';

interface SourceRow {
  id: string;
  user_id: string;
  source: string;
  last_seen_at: string | null;
  expected_interval_seconds: number | null;
  staleness_grace_factor: number;
  stale_alerted_at: string | null;
}

/** Records every update issued against alert_sources. */
interface Harness {
  supabase: SupabaseClient;
  updates: Array<{ table: string; values: Record<string, unknown>; id?: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** What resolve_alert_event should return; [] means "nothing was open". */
  resolveResult: Array<Record<string, unknown>>;
  updateError: { message: string } | null;
}

function makeHarness(sources: SourceRow[]): Harness {
  const h: Partial<Harness> = {
    updates: [],
    rpcCalls: [],
    resolveResult: [],
    updateError: null,
  };

  const selectBuilder = (rows: unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'not', 'is', 'like']) {
      builder[method] = () => builder;
    }
    // Terminal: awaiting the builder yields the rows.
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    builder.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    return builder;
  };

  const supabase = {
    from(table: string) {
      return {
        select: (..._a: unknown[]) => selectBuilder(table === 'alert_sources' ? sources : []),
        update(values: Record<string, unknown>) {
          const chain = {
            eq: (_col: string, id: string) => {
              h.updates!.push({ table, values, id });
              return Promise.resolve({ error: h.updateError });
            },
          };
          return chain;
        },
        upsert: () => Promise.resolve({ error: null }),
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpcCalls!.push({ fn, args });
      if (fn === 'resolve_alert_event') {
        return Promise.resolve({ data: h.resolveResult, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  h.supabase = supabase;
  return h as Harness;
}

const staleSource = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: 'src-1',
  user_id: USER,
  source: 'disk-monitor',
  // Promised every 300s with a 2x grace, so 40 minutes of silence is stale.
  last_seen_at: new Date(Date.now() - 40 * 60_000).toISOString(),
  expected_interval_seconds: 300,
  staleness_grace_factor: 2,
  stale_alerted_at: null,
  ...over,
});

function makeService(h: Harness) {
  const composer = { getClient: () => h.supabase } as unknown as DataComposer;
  return new AlertDispatchService(composer, h.supabase);
}

describe('sweepStaleSources bookkeeping', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stamps stale_alerted_at when the alert was actually delivered', async () => {
    const h = makeHarness([staleSource()]);
    const service = makeService(h);
    vi.spyOn(service, 'ingest').mockResolvedValue({
      accepted: true,
      eventId: 'evt-1',
      status: 'raised',
      isNew: true,
      notified: true,
      occurrenceCount: 1,
      deliveries: [{ sink: 'agents', target: 'myra', ok: true }],
    });

    const result = await service.sweepStaleSources();

    expect(result.raised).toBe(1);
    const stamp = h.updates.find((u) => 'stale_alerted_at' in u.values);
    expect(stamp?.values.stale_alerted_at).toEqual(expect.any(String));
  });

  it('leaves the source unstamped when the raise reached no sink', async () => {
    const h = makeHarness([staleSource()]);
    const service = makeService(h);
    // status 'raised' but notified false: the claim was taken, every sink
    // failed, and the claim was released for the next attempt to pick up.
    vi.spyOn(service, 'ingest').mockResolvedValue({
      accepted: true,
      eventId: 'evt-1',
      status: 'raised',
      isNew: true,
      notified: false,
      occurrenceCount: 1,
      deliveries: [{ sink: 'agents', target: 'myra', ok: false, detail: 'trigger refused' }],
    });

    const result = await service.sweepStaleSources();

    // Nothing was raised as far as anyone heard, so the next sweep must retry.
    // Stamping here is what made the promised retry unreachable.
    expect(result.raised).toBe(0);
    expect(h.updates.filter((u) => 'stale_alerted_at' in u.values)).toHaveLength(0);
  });

  it('treats a deduped raise as handled — someone was already told', async () => {
    const h = makeHarness([staleSource()]);
    const service = makeService(h);
    vi.spyOn(service, 'ingest').mockResolvedValue({
      accepted: true,
      eventId: 'evt-1',
      status: 'deduped',
      isNew: false,
      notified: false,
      occurrenceCount: 3,
      deliveries: [],
    });

    const result = await service.sweepStaleSources();

    expect(result.raised).toBe(1);
    expect(h.updates.filter((u) => 'stale_alerted_at' in u.values)).toHaveLength(1);
  });

  it('does not count a raise whose stamp write failed', async () => {
    const h = makeHarness([staleSource()]);
    h.updateError = { message: 'PostgREST exploded' };
    const service = makeService(h);
    vi.spyOn(service, 'ingest').mockResolvedValue({
      accepted: true,
      eventId: 'evt-1',
      status: 'raised',
      isNew: true,
      notified: true,
      occurrenceCount: 1,
      deliveries: [{ sink: 'agents', target: 'myra', ok: true }],
    });

    const result = await service.sweepStaleSources();

    // PostgREST reports failures in { error } rather than throwing, so an
    // unchecked update read as success.
    expect(result.raised).toBe(0);
  });

  it('skips a source that is not yet stale', async () => {
    const h = makeHarness([
      staleSource({ last_seen_at: new Date(Date.now() - 60_000).toISOString() }),
    ]);
    const service = makeService(h);
    const ingest = vi.spyOn(service, 'ingest');

    const result = await service.sweepStaleSources();

    expect(ingest).not.toHaveBeenCalled();
    expect(result.raised).toBe(0);
  });
});

describe('liveness recovery', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves the liveness incident when a source checks in', async () => {
    const h = makeHarness([]);
    const service = makeService(h);

    await service.checkIn(USER, { source: 'disk-monitor', expectedIntervalSeconds: 300 });

    const resolve = h.rpcCalls.find((c) => c.fn === 'resolve_alert_event');
    // Clearing stale_alerted_at only re-arms the sweep. Without closing the
    // incident, a second death inside the cooldown deduped onto the first and
    // went unreported.
    expect(resolve).toBeDefined();
    expect(resolve?.args.p_dedupe_key).toBe('alert-liveness:disk-monitor');
  });

  it('announces recovery only when the silence was itself announced', async () => {
    const h = makeHarness([]);
    h.resolveResult = [
      {
        event_id: 'evt-1',
        severity: 'critical',
        title: 'Monitor "disk-monitor" has gone silent',
        occurrence_count: 2,
        first_seen_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        was_notified: false,
      },
    ];
    const service = makeService(h);
    const fanOut = vi.spyOn(
      service as unknown as { fanOut: (...a: unknown[]) => unknown },
      'fanOut'
    );

    await service.checkIn(USER, { source: 'disk-monitor' });

    // Recovering from an alarm nobody heard is not news.
    expect(fanOut).not.toHaveBeenCalled();
  });

  it('does not try to resolve liveness for the liveness source itself', async () => {
    const h = makeHarness([]);
    const service = makeService(h);

    await service.checkIn(USER, { source: 'alert-liveness' });

    expect(h.rpcCalls.filter((c) => c.fn === 'resolve_alert_event')).toHaveLength(0);
  });
});
