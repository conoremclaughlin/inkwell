/**
 * A tick that never happens must leave a trace.
 *
 * Every other alarm in the heartbeat module is raised by a delivery ATTEMPT.
 * When the scheduler does not run at all there is no attempt, so there is no
 * failure row, no streak, and nobody told. On 2026-09-18 that absence swallowed
 * eight consecutive five-minute ticks inside a server that never restarted, and
 * across the retained log 39 of 771 expected ticks were missing with no record
 * of any of them.
 *
 * These tests run the REAL node-cron. That is the whole point of the file. The
 * hook being wired here is not reachable through `schedule()`'s options —
 * `TaskOptions` does not declare `onMissedExecution` and `InlineScheduledTask`
 * copies four option keys by name — so a hook passed that way is dropped in
 * silence. A suite built on `vi.mock('node-cron')` cannot tell the two apart:
 * asserting we handed an argument to a mock proves nothing about whether the
 * library ever calls it. Mocking the scheduler here would test the fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock: logger (the observation point, not the thing under test) ───
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/env.js', async () => ({
  env: { ...(await import('../test/fake-env.js')).fakeEnv },
}));

// ─── Mock: Supabase (init constructs a client; no query runs in these tests) ───
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

import { initHeartbeatService, stopHeartbeatService, getHeartbeatTickHealth } from './heartbeat.js';
import { logger } from '../utils/logger.js';

/** Freeze the event loop the way a suspended host does, without spinning a core. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, polling — never a bare sleep sized to "probably enough". */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

const missedWarnings = () =>
  (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
    String(call[0]).includes('Heartbeat tick missed')
  );

describe('heartbeat scheduler liveness (real node-cron)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopHeartbeatService();
  });

  it('reports a tick that never ran, after the event loop stalls past its slot', async () => {
    let ticks = 0;
    initHeartbeatService({
      interval: '* * * * * *', // every second
      enableLocalCron: true,
      onHeartbeat: async () => {
        ticks += 1;
      },
    });

    // The runner only learns what it expected after it has run once: the first
    // beat is what establishes the next expected slot.
    const started = await waitFor(() => ticks >= 1, 5000);
    expect(started, 'scheduler never produced a first tick').toBe(true);
    expect(getHeartbeatTickHealth().missedTickCount).toBe(0);

    // The stall. Several one-second slots pass with nothing able to run.
    blockEventLoop(3000);

    const reported = await waitFor(() => missedWarnings().length > 0, 5000);
    expect(reported, 'a stall past several slots produced no missed-tick record').toBe(true);

    const health = getHeartbeatTickHealth();
    expect(health.missedTickCount).toBeGreaterThan(0);
    expect(health.lastMissedTickAt).not.toBeNull();

    // The record has to say how long the gap was, or it cannot distinguish a
    // one-slot hiccup from a host asleep for an hour.
    const [, meta] = missedWarnings()[0] as [string, Record<string, unknown>];
    expect(meta.sinceLastTickMs).toBeGreaterThanOrEqual(2000);
    expect(meta.lastTickAt).toEqual(expect.any(String));
    expect(meta.missedTickCount).toBeGreaterThan(0);
  }, 30000);

  it('stays silent while ticks are landing on time', async () => {
    // The control. Without it, a hook that fires unconditionally would pass the
    // test above and alarm on every healthy beat.
    let ticks = 0;
    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {
        ticks += 1;
      },
    });

    const ran = await waitFor(() => ticks >= 3, 8000);
    expect(ran, 'scheduler did not tick three times while unobstructed').toBe(true);
    expect(missedWarnings()).toHaveLength(0);
    expect(getHeartbeatTickHealth().missedTickCount).toBe(0);
    expect(getHeartbeatTickHealth().lastTickAt).toEqual(expect.any(String));
  }, 30000);

  it('separates a live scheduler from a wedged tick', async () => {
    // The other way to go quiet, and the one that reads as healthy if you only
    // look at whether the scheduler fired. A tick hung on an await leaves the
    // cron firing on time — every subsequent fire hits the overlap guard and
    // returns at `debug` level — while no work completes at all.
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;

    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {
        entered += 1;
        await hang;
      },
    });

    try {
      expect(await waitFor(() => entered >= 1, 5000)).toBe(true);
      const firstTickAt = getHeartbeatTickHealth().lastTickAt;
      expect(firstTickAt).toEqual(expect.any(String));

      // The scheduler must demonstrably fire AGAIN while the first tick is
      // still stuck — otherwise this test would also pass on a dead scheduler,
      // which is the very thing it has to tell apart.
      const firedAgain = await waitFor(
        () => getHeartbeatTickHealth().lastTickAt !== firstTickAt,
        5000
      );
      expect(firedAgain, 'scheduler stopped firing; cannot distinguish wedged from dead').toBe(
        true
      );

      const wedged = getHeartbeatTickHealth();
      expect(wedged.lastTickCompletedAt, 'no tick has finished; this must stay null').toBeNull();
      expect(wedged.sinceLastCompletedTickMs).toBeNull();
      // The guard suppressed re-entry rather than piling up concurrent runs.
      expect(entered).toBe(1);
    } finally {
      release();
    }

    expect(await waitFor(() => getHeartbeatTickHealth().lastTickCompletedAt !== null, 5000)).toBe(
      true
    );
  }, 30000);

  it('does not credit the replacement scheduler with a retired in-flight completion', async () => {
    // Lumen's finding on #656, against the reset the same change introduced.
    // Re-init stops the old cron, so it cannot fire again — but a tick already
    // awaiting keeps running, and its `finally` lands AFTER the reset. The
    // successor then reports a completion it never had, beside a `lastTickAt`
    // still null: work finished before any was scheduled.
    //
    // The re-init test below cannot catch this. It resets while the old tick is
    // still suspended and asserts immediately, so the late write happens after
    // its last assertion. This one releases the old work and then looks.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {
        entered();
        await pending;
      },
    });

    try {
      await started;
      // A successor whose own first tick is far in the future, so anything
      // written to its state can only have come from the retired scheduler.
      initHeartbeatService({
        interval: '0 0 1 1 *',
        enableLocalCron: true,
        onHeartbeat: async () => {},
      });
      expect(getHeartbeatTickHealth().lastTickCompletedAt).toBeNull();
    } finally {
      release();
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
    await sleep(50);
    const health = getHeartbeatTickHealth();
    expect(health.lastTickCompletedAt, 'retired tick credited the successor').toBeNull();
    expect(health.lastTickAt).toBeNull();
    expect(health.sinceLastCompletedTickMs).toBeNull();
  }, 30000);

  it('does not inherit the previous scheduler count across re-init', async () => {
    let ticks = 0;
    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {
        ticks += 1;
      },
    });
    expect(await waitFor(() => ticks >= 1, 5000)).toBe(true);
    blockEventLoop(2500);
    expect(await waitFor(() => getHeartbeatTickHealth().missedTickCount > 0, 5000)).toBe(true);

    initHeartbeatService({
      interval: '* * * * * *',
      enableLocalCron: true,
      onHeartbeat: async () => {},
    });

    const health = getHeartbeatTickHealth();
    expect(health.missedTickCount).toBe(0);
    expect(health.lastMissedTickAt).toBeNull();
    expect(health.lastTickAt).toBeNull();
    expect(health.lastTickCompletedAt).toBeNull();
  }, 30000);
});
