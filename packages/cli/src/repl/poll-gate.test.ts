import { describe, expect, it, vi } from 'vitest';
import { createPollGate } from './poll-gate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (promise chains) settle. */
const flush = () => new Promise((res) => setImmediate(res));

describe('createPollGate', () => {
  it('skips a tick while a poll is in flight', async () => {
    const gate = createPollGate();
    const first = deferred<number>();
    const run1 = gate.run(() => first.promise);

    const fn2 = vi.fn(async () => 2);
    const run2 = gate.run(fn2);
    await expect(run2).resolves.toBeNull();
    expect(fn2).not.toHaveBeenCalled();

    first.resolve(1);
    await expect(run1).resolves.toBe(1);
    await flush();
    expect(gate.active).toBe(0);

    // Gate free again — the next tick runs.
    await expect(gate.run(fn2)).resolves.toBe(2);
  });

  it('queues a forced poll behind the in-flight run instead of overlapping', async () => {
    const gate = createPollGate();
    const first = deferred<string>();
    let concurrent = 0;
    let maxConcurrent = 0;
    const tracked = (fn: () => Promise<string>) => async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await fn();
      } finally {
        concurrent -= 1;
      }
    };

    const run1 = gate.run(tracked(() => first.promise));
    const run2 = gate.run(
      tracked(async () => 'forced'),
      { force: true }
    );
    await flush();
    // Forced call is queued, not started — no overlap.
    expect(concurrent).toBe(1);
    expect(gate.active).toBe(2);

    first.resolve('tick');
    await expect(run1).resolves.toBe('tick');
    await expect(run2).resolves.toBe('forced');
    expect(maxConcurrent).toBe(1);
    expect(gate.active).toBe(0);
  });

  it('forced completion does not release the gate early (ticks skip until ALL runs drain)', async () => {
    const gate = createPollGate();
    const first = deferred<string>();
    const second = deferred<string>();

    const run1 = gate.run(() => first.promise);
    const run2 = gate.run(() => second.promise, { force: true });

    // First run completes; the queued forced run is now executing.
    first.resolve('tick');
    await run1;
    await flush();
    expect(gate.active).toBe(1);

    // A tick during the forced run must still skip — with the old shared
    // boolean, the first finisher cleared the flag and reopened stacking.
    const fn3 = vi.fn(async () => 'tick-3');
    await expect(gate.run(fn3)).resolves.toBeNull();
    expect(fn3).not.toHaveBeenCalled();

    second.resolve('forced');
    await run2;
    await flush();
    expect(gate.active).toBe(0);
    await expect(gate.run(fn3)).resolves.toBe('tick-3');
  });

  it('releases the gate when a poll throws (cleanup)', async () => {
    const gate = createPollGate();
    const boom = new Error('poll failed');
    await expect(gate.run(async () => Promise.reject(boom))).rejects.toThrow('poll failed');
    await flush();
    expect(gate.active).toBe(0);

    // The chain is not poisoned — subsequent runs (tick and forced) work.
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    await expect(gate.run(async () => 'forced-ok', { force: true })).resolves.toBe('forced-ok');
  });

  it('auto-run continuity: work scheduled after the gate does not hold it', async () => {
    // The chat-loop contract: pollInbox holds the gate only for fetch/render
    // (phase 1) and awaits backend auto-run turns AFTER release (phase 2).
    // Polling — and therefore permission-grant delivery — must continue while
    // a turn is in flight, or remote approvals deadlock.
    const gate = createPollGate();
    const backendTurn = deferred<void>();

    const poll = async () => {
      const collected = await gate.run(async () => ({ autoRun: true }));
      if (!collected) return 'skipped';
      if (collected.autoRun) await backendTurn.promise; // phase 2, outside the gate
      return 'processed';
    };

    const poll1 = poll();
    await flush();
    // Phase 1 done, backend turn still running — the gate must be free.
    expect(gate.active).toBe(0);

    const grantPoll = vi.fn(async () => 'grant-delivered');
    await expect(gate.run(grantPoll)).resolves.toBe('grant-delivered');
    expect(grantPoll).toHaveBeenCalledTimes(1);

    backendTurn.resolve();
    await expect(poll1).resolves.toBe('processed');
  });
});
