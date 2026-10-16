import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationRetention } from './retention';

describe('notification retention scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing until explicitly started and reports no content', async () => {
    const purgeExpired = vi.fn().mockResolvedValue(0);
    const report = vi.fn();
    const worker = new NotificationRetention({ purgeExpired }, report, () => 1000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(purgeExpired).not.toHaveBeenCalled();
    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(purgeExpired).toHaveBeenCalledExactlyOnceWith(1000);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      deleted: 0,
      batches: 1,
      backlog: false,
      failed: false,
    });
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds each pass and uses the same cutoff throughout', async () => {
    const purgeExpired = vi.fn().mockResolvedValue(500);
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValue(2000);
    const worker = new NotificationRetention({ purgeExpired }, vi.fn(), now);
    expect(await worker.sweep()).toEqual({
      deleted: 5000,
      batches: 10,
      backlog: true,
      failed: false,
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect(purgeExpired.mock.calls).toEqual(Array.from({ length: 10 }, () => [1000]));
  });

  it('retries backlog promptly, then returns to the ordinary cadence', async () => {
    let calls = 0;
    const purgeExpired = vi.fn(async () => (++calls <= 10 ? 500 : 0));
    const worker = new NotificationRetention({ purgeExpired }, vi.fn());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(purgeExpired).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(purgeExpired).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(purgeExpired).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(59999);
    expect(purgeExpired).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(1);
    expect(purgeExpired).toHaveBeenCalledTimes(12);
    await worker.stop();
  });

  it('joins simultaneous sweeps and drains its one in-flight deletion when stopped', async () => {
    let settle!: (value: number) => void;
    const purgeExpired = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          settle = resolve;
        })
    );
    const worker = new NotificationRetention({ purgeExpired }, vi.fn());
    const first = worker.sweep();
    expect(worker.sweep()).toBe(first);
    const stopped = worker.stop();
    let drained = false;
    void stopped.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    settle(500);
    await stopped;
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(await first).toEqual({ deleted: 500, batches: 1, backlog: true, failed: false });
    worker.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 501, 0.5, NaN])('refuses an invalid deletion count (%s)', async (count) => {
    const worker = new NotificationRetention({ purgeExpired: async () => count }, vi.fn());
    expect(await worker.sweep()).toEqual({ deleted: 0, batches: 0, backlog: false, failed: true });
  });

  it('survives store/report failure without reporting private exception text or tight retry', async () => {
    const purgeExpired = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic private detail'))
      .mockResolvedValue(0);
    const report = vi.fn(() => {
      throw new Error('synthetic reporter error');
    });
    const worker = new NotificationRetention({ purgeExpired }, report);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.calls[0]).toEqual([
      { deleted: 0, batches: 0, backlog: false, failed: true },
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
});
