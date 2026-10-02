import { describe, it, expect, vi } from 'vitest';
import { createdAtMicros } from './heartbeat-notification-store.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The drain merges rows read by separate queries, so it orders them by
 * `created_at` itself. PostgREST returns microseconds with trailing zeros
 * trimmed, which neither `Date.parse` (milliseconds) nor a text comparison
 * orders exactly.
 */
describe('createdAtMicros', () => {
  it('reads every microsecond digit', () => {
    expect(createdAtMicros('2026-10-02T19:56:23.480415+00:00')).toBe(
      Date.parse('2026-10-02T19:56:23Z') * 1000 + 480_415
    );
  });

  it('orders timestamps that differ below a millisecond', () => {
    // Date.parse alone gives these the same value.
    expect(Date.parse('2026-10-02T19:56:23.480100+00:00')).toBe(
      Date.parse('2026-10-02T19:56:23.480900+00:00')
    );
    expect(createdAtMicros('2026-10-02T19:56:23.4801+00:00')).toBeLessThan(
      createdAtMicros('2026-10-02T19:56:23.4809+00:00')
    );
  });

  it('reads a trimmed fraction as the value it stands for', () => {
    expect(createdAtMicros('2026-10-02T19:56:23.5+00:00')).toBe(
      createdAtMicros('2026-10-02T19:56:23.500000+00:00')
    );
    expect(createdAtMicros('2026-10-02T19:56:23.5+00:00')).toBeGreaterThan(
      createdAtMicros('2026-10-02T19:56:23.48+00:00')
    );
    expect(createdAtMicros('2026-10-02T19:56:23+00:00')).toBeLessThan(
      createdAtMicros('2026-10-02T19:56:23.000001+00:00')
    );
  });

  it('honours the offset', () => {
    expect(createdAtMicros('2026-10-02T12:56:23.000002-07:00')).toBe(
      createdAtMicros('2026-10-02T19:56:23.000002+00:00')
    );
  });
});
