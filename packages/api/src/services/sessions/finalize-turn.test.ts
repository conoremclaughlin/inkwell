/**
 * Retry policy for post-turn terminal bookkeeping (pr:558).
 *
 * The loop's one job: outlast a transient DB failure without ever running the
 * boundary steps for a write that did not persist, and without writing over a
 * shutdown that has taken ownership of the session.
 */

import { describe, it, expect, vi } from 'vitest';
import { retryTurnFinalization, isSessionGoneError } from './finalize-turn.js';

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
