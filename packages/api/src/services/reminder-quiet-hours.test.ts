import { describe, expect, it } from 'vitest';
import { isStrategyWatchdog, mayRunDuringQuietHours } from './reminder-quiet-hours.js';

describe('isStrategyWatchdog', () => {
  it('is true only for metadata.strategyWatchdog === true', () => {
    expect(isStrategyWatchdog({ strategyWatchdog: true, groupId: 'g1' })).toBe(true);
    expect(isStrategyWatchdog({ strategyWatchdog: 'true' })).toBe(false);
    expect(isStrategyWatchdog({ strategyWatchdog: false })).toBe(false);
    expect(isStrategyWatchdog({})).toBe(false);
    expect(isStrategyWatchdog(null)).toBe(false);
    expect(isStrategyWatchdog(undefined)).toBe(false);
    expect(isStrategyWatchdog([{ strategyWatchdog: true }])).toBe(false);
  });
});

describe('mayRunDuringQuietHours', () => {
  it('needs the switch on', () => {
    expect(mayRunDuringQuietHours({ run_during_quiet_hours: true, metadata: null })).toBe(true);
    expect(mayRunDuringQuietHours({ run_during_quiet_hours: false, metadata: null })).toBe(false);
    expect(mayRunDuringQuietHours({ run_during_quiet_hours: null, metadata: null })).toBe(false);
    expect(mayRunDuringQuietHours({})).toBe(false);
  });

  it('holds a watchdog even when its row has the switch set', () => {
    expect(
      mayRunDuringQuietHours({
        run_during_quiet_hours: true,
        metadata: { strategyWatchdog: true },
      })
    ).toBe(false);
  });
});
