import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitOpenError, createSupabaseRetry, isTransientSupabaseError } from './supabase-retry';

describe('isTransientSupabaseError', () => {
  it('treats PGRST002 as transient (schema cache unreachable)', () => {
    expect(isTransientSupabaseError({ code: 'PGRST002' })).toBe(true);
  });

  it('treats Postgres cannot_connect_now / admin_shutdown as transient', () => {
    expect(isTransientSupabaseError({ code: '57P03' })).toBe(true);
    expect(isTransientSupabaseError({ code: '57P01' })).toBe(true);
  });

  it('treats 5xx HTTP status as transient', () => {
    expect(isTransientSupabaseError({ status: 500 })).toBe(true);
    expect(isTransientSupabaseError({ status: 503 })).toBe(true);
    expect(isTransientSupabaseError({ status: 599 })).toBe(true);
  });

  it('treats 429 rate-limit as transient', () => {
    expect(isTransientSupabaseError({ status: 429 })).toBe(true);
  });

  it('treats fetch/network errors as transient', () => {
    expect(isTransientSupabaseError(new Error('fetch failed'))).toBe(true);
    expect(isTransientSupabaseError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientSupabaseError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT treat 4xx (besides 429) or PGRST116 as transient', () => {
    expect(isTransientSupabaseError({ status: 400 })).toBe(false);
    expect(isTransientSupabaseError({ status: 404 })).toBe(false);
    expect(isTransientSupabaseError({ code: 'PGRST116' })).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(isTransientSupabaseError(null)).toBe(false);
    expect(isTransientSupabaseError('oops')).toBe(false);
    expect(isTransientSupabaseError(undefined)).toBe(false);
  });
});

describe('createSupabaseRetry', () => {
  // Deterministic jitter — Math.random() returns 0 so delay is always 0.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the result on first success without retrying', async () => {
    const retry = createSupabaseRetry();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retry.run(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retry.getState().consecutiveFailures).toBe(0);
  });

  it('retries transient failures up to maxAttempts and eventually succeeds', async () => {
    const retry = createSupabaseRetry();
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ code: 'PGRST002' })
      .mockResolvedValueOnce('recovered');
    await expect(retry.run(fn, { maxAttempts: 4 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    // Success should reset the breaker state.
    expect(retry.getState().consecutiveFailures).toBe(0);
  });

  it('rethrows non-transient errors without retrying', async () => {
    const retry = createSupabaseRetry();
    const err = { status: 404, message: 'not found' };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry.run(fn)).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retry.getState().consecutiveFailures).toBe(0);
  });

  it('rethrows after exhausting attempts on persistent transient failure', async () => {
    const retry = createSupabaseRetry({ failureThreshold: 100 }); // don't trip breaker
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry.run(fn, { maxAttempts: 3 })).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('opens the circuit after failureThreshold consecutive transient failures', async () => {
    const retry = createSupabaseRetry({ failureThreshold: 2, cooldownMs: 5000 });
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);

    // First call: 2 transient failures → breaker trips, throws err.
    await expect(retry.run(fn, { maxAttempts: 5 })).rejects.toEqual(err);
    expect(retry.getState().consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(retry.getState().openUntil).toBeGreaterThan(Date.now());

    // Second call: breaker open → CircuitOpenError, no call to fn.
    const callsBefore = fn.mock.calls.length;
    await expect(retry.run(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(callsBefore);
  });

  it('closes the breaker after a successful call', async () => {
    const retry = createSupabaseRetry({ failureThreshold: 2, cooldownMs: 0 });
    const err = { status: 503 };

    // Trip it.
    await expect(retry.run(() => Promise.reject(err), { maxAttempts: 5 })).rejects.toEqual(err);
    expect(retry.getState().consecutiveFailures).toBeGreaterThanOrEqual(2);

    // cooldownMs: 0 → openUntil is in the past almost immediately.
    await new Promise((r) => setTimeout(r, 1));

    await expect(retry.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(retry.getState().consecutiveFailures).toBe(0);
    expect(retry.getState().openUntil).toBe(0);
  });

  it('respects AbortSignal between attempts', async () => {
    const retry = createSupabaseRetry();
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort(new Error('user cancelled'));
      throw { status: 503 };
    });
    await expect(
      retry.run(fn, { maxAttempts: 5, signal: controller.signal, initialDelayMs: 1 })
    ).rejects.toMatchObject({ message: 'user cancelled' });
    // First attempt runs, then the next sleep aborts.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
