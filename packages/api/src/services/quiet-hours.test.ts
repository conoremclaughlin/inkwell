/**
 * Quiet hours: the deferral that looked like lag.
 *
 * Conor's Spravato fasting prep was scheduled 07:30 against a 09:00 deadline
 * and delivered at 08:06 (2026-09-02). The scheduler had not fallen behind —
 * it ticked every five minutes and found the reminder due eight consecutive
 * times without delivering, because it was inside quiet hours. Read as lag, it
 * produced the rule "schedule against the lag", which does nothing: a held
 * reminder releases when the window ends whatever time it was set for.
 */

import { describe, expect, it } from 'vitest';
import {
  effectiveDeliveryTime,
  isWithinQuietHours,
  localTimeOfDay,
  quietHoursDeferralWarning,
} from './quiet-hours';

/** Myra's operating window, and the one that held the reminder. */
const overnight = { start: '22:00', end: '08:00', timezone: 'America/Los_Angeles' };

describe('localTimeOfDay', () => {
  it('reads the wall clock in the USER’s zone, not the process default', () => {
    // 15:30Z is 08:30 in Los Angeles and 17:30 in Berlin. The bug this replaces
    // used the server's own clock and would have answered the same for both.
    const instant = new Date('2026-09-02T15:30:00Z');
    expect(localTimeOfDay(instant, 'America/Los_Angeles')).toBe('08:30');
    expect(localTimeOfDay(instant, 'Europe/Berlin')).toBe('17:30');
    expect(localTimeOfDay(instant, 'UTC')).toBe('15:30');
  });

  it('falls back to UTC on an unusable zone rather than throwing', () => {
    // A scheduler that dies on a bad config string is worse than one that
    // mis-times a window.
    expect(localTimeOfDay(new Date('2026-09-02T15:30:00Z'), 'Not/AZone')).toBe('15:30');
  });
});

describe('isWithinQuietHours', () => {
  it('holds the 07:30 reminder that started all this', () => {
    expect(isWithinQuietHours(new Date('2026-09-02T14:30:00Z'), overnight)).toBe(true);
  });

  it('releases after the window ends', () => {
    // 15:05Z = 08:05 PDT, the tick the reminder actually went out on.
    expect(isWithinQuietHours(new Date('2026-09-02T15:05:00Z'), overnight)).toBe(false);
  });

  it('wraps midnight', () => {
    expect(isWithinQuietHours(new Date('2026-09-02T08:00:00Z'), overnight)).toBe(true); // 01:00
    expect(isWithinQuietHours(new Date('2026-09-02T20:00:00Z'), overnight)).toBe(false); // 13:00
  });

  it('treats a same-day window as a plain range', () => {
    const daytime = { start: '09:00', end: '17:00', timezone: 'UTC' };
    expect(isWithinQuietHours(new Date('2026-09-02T12:00:00Z'), daytime)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-09-02T08:59:00Z'), daytime)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-09-02T17:00:00Z'), daytime)).toBe(false);
  });

  it('is inactive when either bound is missing', () => {
    const t = new Date('2026-09-02T14:30:00Z');
    expect(isWithinQuietHours(t, { start: '22:00', end: null })).toBe(false);
    expect(isWithinQuietHours(t, { start: null, end: '08:00' })).toBe(false);
    expect(isWithinQuietHours(t, {})).toBe(false);
  });

  it('reads equal bounds as no quiet hours, not as always-quiet', () => {
    // Via the wrap branch, 08:00–08:00 would otherwise mute every reminder
    // forever — a config typo that silences the whole system.
    const t = new Date('2026-09-02T14:30:00Z');
    expect(isWithinQuietHours(t, { start: '08:00', end: '08:00', timezone: 'UTC' })).toBe(false);
  });
});

describe('effectiveDeliveryTime', () => {
  it('returns the asked-for time when it is outside the window', () => {
    const t = new Date('2026-09-02T20:00:00Z');
    expect(effectiveDeliveryTime(t, overnight).toISOString()).toBe(t.toISOString());
  });

  it('reports the window boundary for a held reminder', () => {
    const deferred = effectiveDeliveryTime(new Date('2026-09-02T14:30:00Z'), overnight);
    expect(localTimeOfDay(deferred, overnight.timezone)).toBe('08:00');
  });

  /**
   * THE POINT. Three different scheduled times inside the window all deliver at
   * the same moment — which is why "schedule earlier" buys nothing, and why the
   * 90-minute margin on the real reminder was irrelevant rather than sufficient.
   */
  it('gives the same delivery time however early it was scheduled', () => {
    const times = [
      '2026-09-02T14:30:00Z', // 07:30 PDT
      '2026-09-02T13:00:00Z', // 06:00 PDT
      '2026-09-02T12:00:00Z', // 05:00 PDT
    ].map((iso) => effectiveDeliveryTime(new Date(iso), overnight).toISOString());

    expect(new Set(times).size).toBe(1);
  });
});

describe('quietHoursDeferralWarning', () => {
  it('says nothing when the time will be honoured', () => {
    expect(quietHoursDeferralWarning(new Date('2026-09-02T20:00:00Z'), overnight)).toBeNull();
  });

  it('names the asked-for time, the real one, and the rule that actually works', () => {
    const warning = quietHoursDeferralWarning(new Date('2026-09-02T14:30:00Z'), overnight);

    expect(warning).not.toBeNull();
    expect(warning!.message).toContain('07:30');
    expect(warning!.message).toContain('08:00');
    // The correction Myra retracted her own rule for — stated where the next
    // caller will read it, not left in a thread.
    expect(warning!.message).toContain('Scheduling it earlier does not help');
    expect(warning!.deferredTo).toBe(
      effectiveDeliveryTime(new Date('2026-09-02T14:30:00Z'), overnight).toISOString()
    );
  });

  it('is silent when no quiet hours are configured', () => {
    expect(quietHoursDeferralWarning(new Date('2026-09-02T14:30:00Z'), {})).toBeNull();
  });
});
