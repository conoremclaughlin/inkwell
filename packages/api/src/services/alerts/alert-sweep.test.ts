/**
 * The sweep scheduler.
 *
 * These tests exist because the first version of this feature shipped a
 * correct sweepStaleSources() that nothing ever scheduled. Every unit test
 * passed; the liveness half of the alerting schema did nothing. So what is
 * asserted here is deliberately unglamorous — that the ticker starts, that
 * "disabled" is only ever a choice someone made, and that a slow pass cannot
 * stack on itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveSweepIntervalMs,
  startStalenessSweep,
  DEFAULT_SWEEP_SECONDS,
  type SweepRunner,
} from './alert-sweep';

describe('resolveSweepIntervalMs', () => {
  it('defaults when unconfigured', () => {
    expect(resolveSweepIntervalMs(undefined)).toBe(DEFAULT_SWEEP_SECONDS * 1000);
    expect(resolveSweepIntervalMs('')).toBe(DEFAULT_SWEEP_SECONDS * 1000);
  });

  it('honours an explicit interval', () => {
    expect(resolveSweepIntervalMs(60)).toBe(60_000);
    expect(resolveSweepIntervalMs('90')).toBe(90_000);
  });

  it('treats zero and negative as an explicit disable', () => {
    expect(resolveSweepIntervalMs(0)).toBeNull();
    expect(resolveSweepIntervalMs('0')).toBeNull();
    expect(resolveSweepIntervalMs(-1)).toBeNull();
  });

  it('falls back to the default on an unparseable value rather than disabling', () => {
    // A typo in an env var must not silently switch monitoring off. Failing
    // toward "still watching" is the only safe direction for this knob.
    expect(resolveSweepIntervalMs('every-five-minutes')).toBe(DEFAULT_SWEEP_SECONDS * 1000);
  });
});

describe('startStalenessSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runner = (impl: () => Promise<{ checked: number; raised: number }>): SweepRunner => ({
    sweepStaleSources: vi.fn(impl),
  });

  it('actually ticks — the regression that started this', async () => {
    const alerts = runner(async () => ({ checked: 3, raised: 0 }));
    const timer = startStalenessSweep(alerts, 60);
    expect(timer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(2);

    clearInterval(timer!);
  });

  it('returns null and never ticks when disabled', async () => {
    const alerts = runner(async () => ({ checked: 0, raised: 0 }));
    const timer = startStalenessSweep(alerts, 0);

    expect(timer).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(alerts.sweepStaleSources).not.toHaveBeenCalled();
  });

  it('skips a tick rather than stacking when the previous pass is still running', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    const alerts = runner(async () => {
      await inFlight;
      return { checked: 1, raised: 1 };
    });
    const timer = startStalenessSweep(alerts, 60);

    // First tick starts and hangs.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(1);

    // Three more intervals pass while it is still working. Each raises
    // incidents and stamps stale_alerted_at, so overlapping passes would
    // re-raise sources the first pass has not finished marking.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);

    // Freed up, the next tick runs normally.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(2);

    clearInterval(timer!);
  });

  it('keeps ticking after a pass throws', async () => {
    // A sweep that dies on one bad row must not take monitoring down with it.
    const alerts = runner(vi.fn().mockRejectedValueOnce(new Error('supabase blew up')));
    (alerts.sweepStaleSources as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('supabase blew up')
    );
    (alerts.sweepStaleSources as ReturnType<typeof vi.fn>).mockResolvedValue({
      checked: 2,
      raised: 0,
    });

    const timer = startStalenessSweep(alerts, 60);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(alerts.sweepStaleSources).toHaveBeenCalledTimes(2);

    clearInterval(timer!);
  });
});
