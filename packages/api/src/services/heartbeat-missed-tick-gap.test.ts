/**
 * The gap a missed-tick record reports, under both drain orderings.
 *
 * `heartbeat-missed-tick.test.ts` next door runs real node-cron against a real
 * blocked event loop, which is the right way to test that the wiring fires at
 * all. It cannot test THIS, because the thing that varies is the order node-cron
 * drains its queue when the loop unblocks, and that is timing — it came out the
 * same way six times out of six locally while CI hit the other one and failed
 * with `expected 2 to be >= 2000`.
 *
 * So node-cron is faked here, purely to hold the handler and let the two
 * orderings be played deliberately:
 *
 *   A. missed events drain BEFORE the recovery tick — `lastTickAt` is still the
 *      last healthy tick
 *   B. the recovery tick drains FIRST — `lastTickAt` is now milliseconds old,
 *      and the naive subtraction reports a 2ms gap for a three-second stall
 *
 * B is the CI failure, reproduced as an ordering rather than as a race.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/env.js', async () => ({
  env: { ...(await import('../test/fake-env.js')).fakeEnv },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

/**
 * A stand-in for the cron task that keeps the handlers so a test can fire them
 * in a chosen order. It deliberately implements `on`/`start`/`stop` only —
 * anything else production starts calling should fail loudly here rather than
 * be silently absorbed.
 */
const handlers = new Map<string, () => void | Promise<void>>();
let scheduledCallback: (() => Promise<void>) | null = null;

// heartbeat.ts does `import * as cron from 'node-cron'`, so the mock exports
// `schedule` at the top level — a `default` wrapper here would leave
// `cron.schedule` undefined and every test would fail on the call, not on the
// behaviour.
vi.mock('node-cron', () => ({
  schedule: (_expr: string, cb: () => Promise<void>) => {
    scheduledCallback = cb;
    return {
      on: (event: string, handler: () => void | Promise<void>) => {
        handlers.set(event, handler);
      },
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
    };
  },
}));

const { initHeartbeatService, stopHeartbeatService } = await import('./heartbeat.js');
const { logger } = await import('../utils/logger.js');

const missedRecords = () =>
  (logger.warn as ReturnType<typeof vi.fn>).mock.calls
    .filter((call) => String(call[0]).includes('Heartbeat tick missed'))
    .map((call) => call[1] as Record<string, unknown>);

/** Run the scheduled cron callback, i.e. one tick. */
const tick = async () => {
  expect(scheduledCallback, 'production never scheduled a callback').not.toBeNull();
  await scheduledCallback!();
};

const missed = async () => {
  const handler = handlers.get('execution:missed');
  expect(handler, 'production never registered an execution:missed handler').toBeDefined();
  await handler!();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('missed-tick gap, under both drain orderings', () => {
  beforeEach(() => {
    handlers.clear();
    scheduledCallback = null;
    vi.clearAllMocks();
    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {},
    });
  });

  afterEach(() => stopHeartbeatService());

  it('A: reports the stall when the missed events drain first', async () => {
    await tick(); // a healthy tick
    await sleep(60); // stand-in for the stall
    await missed();

    const [record] = missedRecords();
    expect(record.sinceLastTickMs as number).toBeGreaterThanOrEqual(50);
  });

  it('B: the stall is in lastTickGapMs when the recovery tick drains first', async () => {
    // This is the CI failure. sinceLastTickMs is genuinely tiny here — the last
    // tick WAS a millisecond ago — and that is the honest number for what it
    // names. The silence is the interval the recovery tick closed.
    await tick(); // the last healthy tick
    await sleep(60); // the stall
    await tick(); // the RECOVERY tick lands first
    await missed(); // ...and only then does the missed event drain

    const [record] = missedRecords();
    expect(record.sinceLastTickMs as number).toBeLessThan(50);
    expect(record.lastTickGapMs as number).toBeGreaterThanOrEqual(50);
  });

  it('does not reuse a previous larger stall for a new shorter one', async () => {
    // Lumen's case, and the reason max() of the two is wrong: a 10s stall
    // followed by a 3s one must report 3s for the second miss. max() reports
    // 10s, because the first stall's interval is still the larger number and
    // has nothing to do with the miss being recorded.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
      await missed();
      expect(missedRecords().at(-1)?.sinceLastTickMs).toBe(10000);

      await tick(); // recovery for the 10s stall
      vi.setSystemTime(new Date('2026-01-01T00:00:13Z'));
      await missed();
      expect(missedRecords().at(-1)?.sinceLastTickMs).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every record in a burst carries the gap, not just the first', async () => {
    // The old assertion read missedRecords()[0] and assumed it was the big one.
    // Nothing guarantees which member of a burst lands first, so all of them
    // have to be right.
    await tick();
    await sleep(60);
    await tick();
    await missed();
    await missed();
    await missed();

    const records = missedRecords();
    expect(records).toHaveLength(3);
    for (const [i, record] of records.entries()) {
      // One stall, so exactly one of the two intervals carries it — which one
      // depends on the drain order this run happened to take.
      const widest = Math.max(
        (record.sinceLastTickMs as number) ?? 0,
        (record.lastTickGapMs as number) ?? 0
      );
      expect(widest, `record ${i}`).toBeGreaterThanOrEqual(50);
    }
  });

  it('does not invent a gap before any tick has run', async () => {
    // A miss detected before the first tick has nothing to measure from, and
    // must say so rather than report a gap measured from the epoch.
    await missed();
    expect(missedRecords()[0].sinceLastTickMs).toBeNull();
    expect(missedRecords()[0].lastTickGapMs).toBeNull();
    expect(missedRecords()[0].lastTickAt).toBeNull();
  });

  it('does not report a gap across a re-initialised scheduler', async () => {
    // Re-init is a new process's worth of history; the previous scheduler's
    // tick must not become the baseline for the new one's first miss.
    //
    // What this actually pins is `lastTickAt = null` on re-init — removing it
    // turns two of these red. The matching `previousTickAt = null` is NOT
    // observable: with lastTickAt null the gap is null whatever previousTickAt
    // holds, and the first new tick overwrites it anyway. It stays as hygiene,
    // not because a test catches it, and writing a test that appeared to catch
    // it would be dressing up a mutation this code is already immune to.
    await tick();
    await sleep(60);
    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {},
    });
    await missed();

    const records = missedRecords();
    expect(records[records.length - 1].sinceLastTickMs).toBeNull();
  });

  it('counts each missed slot', async () => {
    await tick();
    await missed();
    await missed();
    const records = missedRecords();
    expect(records.map((r) => r.missedTickCount)).toEqual([1, 2]);
  });
});
