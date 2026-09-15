/**
 * The request finishes inside the poster's deadline, whatever stalls.
 *
 * ink-disk-monitor.sh gives the ingest POST `--max-time 20`. If the server is
 * still working after that, the checker gives up, declares the pipeline blind
 * and fires a direct Telegram — for an alert this process is still delivering.
 * One incident, two messages, and a fallback that had not fallen back.
 *
 * Three rounds of review found this one stage at a time: sinks (r2), then
 * persistence (r3), then source touch, the ingest RPC, liveness resolution and
 * settlement (r4). The lesson is in the shape of that list. Stage ceilings do
 * not add up to a deadline — five 3s ceilings are still 15s — so the fix is one
 * budget shared by the whole request, and the coverage has to be per stage
 * because any single unbounded await reinstates the bug on its own.
 *
 * These cases were first written as review probes by Lumen and lived outside
 * the repository. They are here because a regression that only exists in a
 * reviewer's scratch directory is not covered, and the next person to touch
 * this file would have had nothing to fail.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';
import type { ParsedAlert } from './alert-policy';

const { sendResponse, sendToInbox } = vi.hoisted(() => ({
  sendResponse: vi.fn(),
  sendToInbox: vi.fn(),
}));
vi.mock('../../channels/gateway.js', () => ({ getChannelGateway: () => ({ sendResponse }) }));
vi.mock('../../mcp/tools/inbox-handlers.js', () => ({ handleSendToInbox: sendToInbox }));
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const USER = 'user-test';
const CLIENT_DEADLINE_MS = 20_000;

const alert = {
  severity: 'critical',
  source: 'synthetic-monitor',
  title: 'Synthetic alert',
  dedupeKey: 'synthetic-condition',
  status: 'alerting',
  cooldownSeconds: 3600,
  notifyAgents: ['echo'],
} as unknown as ParsedAlert;

/** Never settles. The shape of a hung database call. */
const never = () => new Promise(() => {});

interface Harness {
  service: {
    ingest: (userId: string, alert: ParsedAlert) => Promise<unknown>;
    fanOut: unknown;
    supabase: { from: (t: string) => Record<string, unknown> };
  };
  rpc: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const sources = [
    {
      id: 'source-test',
      user_id: USER,
      source: 'synthetic-monitor',
      last_seen_at: new Date(Date.now() - 3_600_000).toISOString(),
      expected_interval_seconds: 300,
      staleness_grace_factor: 2,
      stale_alerted_at: null,
    },
  ];

  const rpc = vi.fn(async (fn: string) => ({
    data:
      fn === 'ingest_alert_event'
        ? [
            {
              event_id: 'event-test',
              is_new: true,
              should_notify: true,
              claim_token: 'claim-test',
              occurrence_count: 2,
            },
          ]
        : [],
    error: null,
  }));

  const client = {
    rpc,
    from: (table: string) => {
      const value =
        table === 'alert_sources'
          ? sources
          : table === 'users'
            ? [{ telegram_id: '555000123' }]
            : [];
      const b: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'not', 'is']) b[name] = () => b;
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: value, error: null });
      b.single = async () => ({ data: value[0] ?? null, error: null });
      b.maybeSingle = b.single;
      b.upsert = async () => ({ error: null });
      b.update = () => b;
      return b;
    },
  };

  const { AlertDispatchService } = await import('./alert-dispatch.service');
  const service = new AlertDispatchService(
    { getClient: () => client } as unknown as DataComposer,
    client as unknown as SupabaseClient
  );
  return { service: service as unknown as Harness['service'], rpc };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Did ingest settle — either way — before the client would have given up? */
async function settlesWithinClientDeadline(run: () => Promise<unknown>): Promise<boolean> {
  let settled = false;
  void run().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS + 1);
  return settled;
}

describe('ingest finishes inside the poster’s deadline', () => {
  it('when the source touch stalls', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const from = h.service.supabase.from.bind(h.service.supabase);
    h.service.supabase.from = (table: string) => {
      const builder = from(table);
      if (table === 'alert_sources') builder.upsert = never;
      return builder;
    };
    vi.spyOn(h.service, 'fanOut' as never).mockResolvedValue([
      { sink: 'user', target: 'telegram', ok: true },
    ] as never);

    expect(await settlesWithinClientDeadline(() => h.service.ingest(USER, alert))).toBe(true);
  });

  it('when the ingest RPC stalls', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const previous = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string) =>
      fn === 'ingest_alert_event' ? (never() as never) : previous(fn)
    );
    vi.spyOn(h.service, 'fanOut' as never).mockResolvedValue([
      { sink: 'user', target: 'telegram', ok: true },
    ] as never);

    expect(await settlesWithinClientDeadline(() => h.service.ingest(USER, alert))).toBe(true);
  });

  it('when the settle RPC stalls', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const previous = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string) =>
      fn === 'mark_alert_notified' ? (never() as never) : previous(fn)
    );
    vi.spyOn(h.service, 'fanOut' as never).mockResolvedValue([
      { sink: 'user', target: 'telegram', ok: true },
    ] as never);

    expect(await settlesWithinClientDeadline(() => h.service.ingest(USER, alert))).toBe(true);
  });

  it('when the diagnostic delivery write stalls', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const from = h.service.supabase.from.bind(h.service.supabase);
    h.service.supabase.from = (table: string) => {
      const builder = from(table);
      if (table === 'alert_events') {
        builder.update = () => {
          const hung: Record<string, unknown> = {};
          for (const name of ['select', 'eq', 'not', 'is']) hung[name] = () => hung;
          hung.then = never;
          return hung;
        };
      }
      return builder;
    };
    vi.spyOn(h.service, 'fanOut' as never).mockResolvedValue([
      { sink: 'user', target: 'telegram', ok: true },
    ] as never);

    expect(await settlesWithinClientDeadline(() => h.service.ingest(USER, alert))).toBe(true);
  });

  it('settles promptly when nothing stalls (control)', async () => {
    vi.useFakeTimers();
    const h = await harness();
    vi.spyOn(h.service, 'fanOut' as never).mockResolvedValue([
      { sink: 'user', target: 'telegram', ok: true },
    ] as never);

    // The control matters: every assertion above would also pass for an ingest
    // that gave up instantly and never delivered anything. This one pins that
    // the budget is a ceiling rather than the normal path.
    let settled = false;
    void h.service.ingest(USER, alert).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(true);
  });
});

describe('a sink that ran out of time is uncertain, not failed', () => {
  // settleClaim distinguishes the two, but only if the sinks say which
  // happened. The inner 5s catches used to flatten a timeout into an ordinary
  // failure, so a send still in flight was settled as definitely-not-delivered
  // and its claim released to a second dispatcher (PR #539 r3, Lumen).
  for (const sink of ['user', 'agents'] as const) {
    it(`retains the claim when the ${sink} send times out`, async () => {
      vi.useFakeTimers();
      const h = await harness();
      const pending = new Promise<void>(() => {});
      sendResponse.mockReturnValue(pending);
      sendToInbox.mockReturnValue(pending);
      // Warm the mocked dynamic imports so the fake clock starts deterministically.
      await import('../../channels/gateway.js');
      await import('../../mcp/tools/inbox-handlers.js');

      const service = h.service as unknown as {
        notifyUserChannel: (u: string, e: ParsedAlert) => Promise<Array<{ timedOut?: boolean }>>;
        notifyAgents: (u: string, e: ParsedAlert) => Promise<Array<{ timedOut?: boolean }>>;
        settleClaim: (
          id: string,
          token: string,
          sev: string,
          d: Array<{ timedOut?: boolean }>
        ) => Promise<boolean>;
      };

      const work =
        sink === 'user'
          ? service.notifyUserChannel(USER, alert)
          : service.notifyAgents(USER, alert);
      await vi.advanceTimersByTimeAsync(6_000);
      const deliveries = await work;
      await service.settleClaim('event-test', 'claim-test', 'critical', deliveries);

      expect(deliveries[0].timedOut).toBe(true);
      // The claim must ride to TTL rather than be handed to another dispatcher.
      expect(h.rpc.mock.calls.filter((c) => c[0] === 'release_alert_claim')).toHaveLength(0);
    });
  }

  it('still releases the claim when a sink genuinely fails (control)', async () => {
    const h = await harness();
    const service = h.service as unknown as {
      settleClaim: (
        id: string,
        token: string,
        sev: string,
        d: Array<{ ok: boolean; timedOut?: boolean }>
      ) => Promise<boolean>;
    };

    // Without this, "release_alert_claim was not called" would also pass for a
    // settleClaim that never releases anything — which would strand every
    // failed fan-out until TTL and silently undo the retry path.
    await service.settleClaim('event-test', 'claim-test', 'critical', [
      { ok: false, timedOut: false },
    ]);

    expect(h.rpc.mock.calls.filter((c) => c[0] === 'release_alert_claim')).toHaveLength(1);
  });
});

describe('RequestBudget', () => {
  it('hands each stage the smaller of its ceiling and what is left', async () => {
    const { RequestBudget } = await import('./alert-dispatch.service');
    const t0 = 1_000_000;
    const budget = new RequestBudget(18_000, t0);

    // Early on, a stage gets its own ceiling.
    expect(budget.cap(5_000, t0)).toBe(5_000);
    // Late on, it gets only what remains — this is the part that stops stage
    // ceilings from summing past the end of the request.
    expect(budget.cap(5_000, t0 + 16_000)).toBe(2_000);
    expect(budget.remaining(t0 + 19_000)).toBe(0);
    expect(budget.expired(t0 + 19_000)).toBe(true);
    expect(budget.expired(t0 + 17_999)).toBe(false);
  });

  it('never returns a negative cap', async () => {
    const { RequestBudget } = await import('./alert-dispatch.service');
    const t0 = 2_000_000;
    const budget = new RequestBudget(1_000, t0);
    // A negative budget passed to setTimeout fires immediately, which would be
    // survivable; a negative one that underflowed somewhere would not be.
    expect(budget.cap(5_000, t0 + 10_000)).toBe(0);
    expect(budget.remaining(t0 + 10_000)).toBe(0);
  });
});
