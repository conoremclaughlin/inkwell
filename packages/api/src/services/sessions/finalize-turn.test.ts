/**
 * Retry policy for post-turn terminal bookkeeping (pr:558).
 *
 * The loop's one job: outlast a transient DB failure without ever running the
 * boundary steps for a write that did not persist, and without writing over a
 * shutdown that has taken ownership of the session.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  retryTurnFinalization,
  isSessionGoneError,
  supersedePendingFinalization,
  hasPendingFinalization,
} from './finalize-turn.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Deterministic harness: sleep advances a fake clock instead of waiting, and
 * records every delay so backoff is assertable.
 */
function harness(opts: {
  failuresBeforeSuccess?: number;
  error?: () => Error;
  admit?: () => boolean;
  maxTotalMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}) {
  const delays: number[] = [];
  let clock = 0;
  let remainingFailures = opts.failuresBeforeSuccess ?? Number.POSITIVE_INFINITY;

  const attempt = vi.fn(async () => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw (opts.error ?? (() => new Error('An unexpected error occurred')))();
    }
  });
  const onFinalized = vi.fn();

  const promise = retryTurnFinalization({
    sessionId: 'sess-1',
    attempt,
    admit: opts.admit ?? (() => true),
    onFinalized,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    now: () => clock,
    maxTotalMs: opts.maxTotalMs ?? 30 * 60_000,
    initialDelayMs: opts.initialDelayMs ?? 5_000,
    maxDelayMs: opts.maxDelayMs ?? 60_000,
  });

  return { promise, attempt, onFinalized, delays };
}

describe('retryTurnFinalization', () => {
  it('retries with exponential backoff until the write lands', async () => {
    const { promise, attempt, onFinalized, delays } = harness({ failuresBeforeSuccess: 2 });

    await expect(promise).resolves.toBe('finalized');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([5_000, 10_000, 20_000]);
    expect(onFinalized).toHaveBeenCalledTimes(1);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const { promise, delays } = harness({
      failuresBeforeSuccess: 4,
      initialDelayMs: 5_000,
      maxDelayMs: 8_000,
    });

    await expect(promise).resolves.toBe('finalized');
    expect(delays).toEqual([5_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it('never runs the boundary steps for a write that did not persist', async () => {
    const { promise, onFinalized } = harness({ maxTotalMs: 20_000, initialDelayMs: 5_000 });
    await promise;
    expect(onFinalized).not.toHaveBeenCalled();
  });

  it('gives up as exhausted once the budget is spent, leaving the run registered', async () => {
    const { promise, attempt } = harness({
      maxTotalMs: 100,
      initialDelayMs: 50,
      maxDelayMs: 50,
    });

    await expect(promise).resolves.toBe('exhausted');
    // t=0 → sleep(50) → attempt; t=50 → sleep(50) → attempt; t=100 → budget spent.
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('stops as refused the moment shutdown owns the session', async () => {
    let calls = 0;
    const { promise, attempt, onFinalized } = harness({
      admit: () => {
        calls += 1;
        return calls <= 1;
      },
    });

    await expect(promise).resolves.toBe('refused');
    // First attempt admitted (and failed); the second was refused before running.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onFinalized).not.toHaveBeenCalled();
  });

  it('abandons a session whose row is gone instead of retrying forever', async () => {
    const { promise, attempt, onFinalized } = harness({
      error: () => new Error('Session not found: sess-1'),
    });

    await expect(promise).resolves.toBe('gone');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onFinalized).not.toHaveBeenCalled();
  });
});

/**
 * The retry loop outlives the session processing lock, so a NEW turn for the
 * same session must be able to disown it — otherwise the old turn's late
 * write overwrites the new turn's state, clears its registration, and
 * releases its graph claims (Lumen, PR #563 P1).
 */
describe('supersession', () => {
  it('stops as superseded when a new turn disowns the pending loop', async () => {
    let sleeps = 0;
    const onFinalized = vi.fn();
    const promise = retryTurnFinalization({
      sessionId: 'sess-super-1',
      attempt: vi.fn(async () => {
        throw new Error('An unexpected error occurred');
      }),
      admit: () => true,
      onFinalized,
      sleep: async () => {
        sleeps += 1;
        // The new turn arrives while the loop waits out its second delay.
        if (sleeps === 2) supersedePendingFinalization('sess-super-1');
      },
      now: () => 0,
    });

    await expect(promise).resolves.toBe('superseded');
    expect(onFinalized).not.toHaveBeenCalled();
    expect(hasPendingFinalization('sess-super-1')).toBe(false);
  });

  it('a newer loop for the same session supersedes the older one', async () => {
    const aFinalized = vi.fn();
    const bFinalized = vi.fn();

    let releaseA!: () => void;
    const a = retryTurnFinalization({
      sessionId: 'sess-super-2',
      attempt: async () => {
        throw new Error('An unexpected error occurred');
      },
      admit: () => true,
      onFinalized: aFinalized,
      // Parked in its first sleep until we release it.
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseA = resolve;
        }),
      now: () => 0,
    });
    await Promise.resolve(); // let A reach its sleep

    const b = retryTurnFinalization({
      sessionId: 'sess-super-2',
      attempt: async () => {},
      admit: () => true,
      onFinalized: bFinalized,
      sleep: async () => {},
      now: () => 0,
    });

    await expect(b).resolves.toBe('finalized');
    expect(bFinalized).toHaveBeenCalledTimes(1);

    releaseA();
    await expect(a).resolves.toBe('superseded');
    // A's boundary steps never run — they would clear B's registration.
    expect(aFinalized).not.toHaveBeenCalled();
  });

  it('abandons when the row shows another writer took the session (cross-path)', async () => {
    const attempt = vi.fn(async () => {});
    const onFinalized = vi.fn();
    const promise = retryTurnFinalization({
      sessionId: 'sess-super-3',
      attempt,
      admit: () => true,
      onFinalized,
      isStale: async () => true,
      sleep: async () => {},
      now: () => 0,
    });

    await expect(promise).resolves.toBe('superseded');
    expect(attempt).not.toHaveBeenCalled();
    expect(onFinalized).not.toHaveBeenCalled();
  });

  it('an unreadable staleness check falls through to the attempt itself', async () => {
    // The staleness read failing is indistinguishable from the DB flake being
    // retried — it must not abandon a finalization the attempt could land.
    const p = retryTurnFinalization({
      sessionId: 'sess-super-4',
      attempt: vi.fn(async () => {}),
      admit: () => true,
      onFinalized: vi.fn(),
      isStale: async () => {
        throw new Error('fetch failed');
      },
      sleep: async () => {},
      now: () => 0,
    });
    await expect(p).resolves.toBe('finalized');
  });

  it('clears its pending registration on every exit', async () => {
    await retryTurnFinalization({
      sessionId: 'sess-super-5',
      attempt: async () => {},
      admit: () => true,
      onFinalized: vi.fn(),
      sleep: async () => {},
      now: () => 0,
    });
    expect(hasPendingFinalization('sess-super-5')).toBe(false);
  });
});

describe('isSessionGoneError', () => {
  it('recognizes the repository message for a deleted row', () => {
    expect(isSessionGoneError(new Error('Session not found: abc'))).toBe(true);
  });

  it.each([
    new Error('An unexpected error occurred'),
    new Error('fetch failed'),
    'Session not found: abc',
    null,
  ])('treats %o as retryable', (err) => {
    expect(isSessionGoneError(err)).toBe(false);
  });
});
