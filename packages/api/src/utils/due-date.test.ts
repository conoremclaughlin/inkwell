import { describe, it, expect } from 'vitest';
import { resolveDueDate, isBareDate, InvalidDueDateError } from './due-date';

describe('isBareDate', () => {
  it('recognizes a bare calendar date', () => {
    expect(isBareDate('2026-09-14')).toBe(true);
    expect(isBareDate('  2026-09-14  ')).toBe(true);
  });

  it('rejects anything carrying a time', () => {
    expect(isBareDate('2026-09-14T00:00:00Z')).toBe(false);
    expect(isBareDate('2026-09-14T17:00:00-07:00')).toBe(false);
    expect(isBareDate('September 14, 2026')).toBe(false);
  });
});

describe('resolveDueDate — bare dates', () => {
  it('resolves to the end of that day in the given timezone', () => {
    // 23:59:59.999 PDT (UTC-7) on Sep 14 → 06:59:59.999Z on Sep 15.
    expect(resolveDueDate('2026-09-14', 'America/Los_Angeles')).toBe('2026-09-15T06:59:59.999Z');
  });

  it('renders as the intended day for a user west of UTC', () => {
    // The bug this guards: UTC midnight would render as Sep 13 in PDT and mark
    // the task overdue for the whole of Sep 14.
    const iso = resolveDueDate('2026-09-14', 'America/Los_Angeles');
    const localDay = new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
    });
    expect(localDay).toBe('9/14/2026');
    expect(new Date(iso).getTime()).toBeGreaterThan(
      new Date('2026-09-14T23:00:00-07:00').getTime()
    );
  });

  it('handles a zone ahead of UTC', () => {
    // 23:59:59.999 JST (UTC+9) on Sep 14 → 14:59:59.999Z on Sep 14.
    expect(resolveDueDate('2026-09-14', 'Asia/Tokyo')).toBe('2026-09-14T14:59:59.999Z');
  });

  it('uses the offset in effect on that date, not today', () => {
    // Jan 15 is PST (UTC-8): 23:59:59.999 → 07:59:59.999Z on Jan 16.
    expect(resolveDueDate('2026-01-15', 'America/Los_Angeles')).toBe('2026-01-16T07:59:59.999Z');
    // Jul 15 is PDT (UTC-7): 23:59:59.999 → 06:59:59.999Z on Jul 16.
    expect(resolveDueDate('2026-07-15', 'America/Los_Angeles')).toBe('2026-07-16T06:59:59.999Z');
  });

  it('lands correctly on a spring-forward DST boundary', () => {
    // 2026-03-08 is the US spring-forward day; end of day is already PDT.
    expect(resolveDueDate('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-09T06:59:59.999Z');
  });

  it('lands correctly on a fall-back DST boundary', () => {
    // 2026-11-01 is the US fall-back day; end of day is PST.
    expect(resolveDueDate('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-02T07:59:59.999Z');
  });

  it('treats UTC as end of the UTC day', () => {
    expect(resolveDueDate('2026-09-14', 'UTC')).toBe('2026-09-14T23:59:59.999Z');
  });

  it('falls back to UTC for an unusable timezone rather than failing the write', () => {
    expect(resolveDueDate('2026-09-14', 'Not/AZone')).toBe('2026-09-14T23:59:59.999Z');
    expect(resolveDueDate('2026-09-14', '')).toBe('2026-09-14T23:59:59.999Z');
  });

  it('rejects a date that does not exist', () => {
    expect(() => resolveDueDate('2026-02-30', 'UTC')).toThrow(InvalidDueDateError);
    expect(() => resolveDueDate('2026-13-01', 'UTC')).toThrow(InvalidDueDateError);
  });

  it('accepts a real leap day', () => {
    expect(resolveDueDate('2028-02-29', 'UTC')).toBe('2028-02-29T23:59:59.999Z');
  });
});

describe('resolveDueDate — qualified timestamps', () => {
  it('normalizes an offset timestamp to UTC, ignoring the user timezone', () => {
    expect(resolveDueDate('2026-09-14T17:00:00-07:00', 'Asia/Tokyo')).toBe(
      '2026-09-15T00:00:00.000Z'
    );
  });

  it('passes a Z timestamp through', () => {
    expect(resolveDueDate('2026-09-14T00:00:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-09-14T00:00:00.000Z'
    );
  });

  it('rejects an unparseable value', () => {
    expect(() => resolveDueDate('next Tuesday', 'UTC')).toThrow(InvalidDueDateError);
    expect(() => resolveDueDate('2026-09-32T00:00:00Z', 'UTC')).toThrow(InvalidDueDateError);
  });

  it('rejects an empty value', () => {
    expect(() => resolveDueDate('   ', 'UTC')).toThrow(InvalidDueDateError);
  });
});

describe('resolveDueDate — DST transitions end the day when the day ends (r1 P2)', () => {
  /** Local calendar day of an instant in a zone, as YYYYMMDD. */
  function localDay(iso: string, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const f = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    return f('year') * 10_000 + f('month') * 100 + f('day');
  }

  /** The boundary property that DEFINES end-of-day, robust across tzdata. */
  function assertLastInstantOfDay(value: string, zone: string, expectDay: number) {
    const resolved = resolveDueDate(value, zone);
    const t = new Date(resolved).getTime();
    expect(localDay(resolved, zone)).toBe(expectDay);
    expect(localDay(new Date(t + 1).toISOString(), zone)).toBeGreaterThan(expectDay);
  }

  it('a spring-forward gap night (America/Godthab) still resolves to the LAST instant of the day', () => {
    // The old wall-clock arithmetic produced an instant rendering locally as
    // 22:59:59 — overdue an hour before the day ended.
    assertLastInstantOfDay('2026-03-28', 'America/Godthab', 20260328);
  });

  it('a fall-back overlap night (America/Santiago) resolves past BOTH occurrences', () => {
    assertLastInstantOfDay('2026-04-04', 'America/Santiago', 20260404);
  });

  it('an ordinary day still ends at local 23:59:59.999', () => {
    expect(resolveDueDate('2026-09-14', 'America/Los_Angeles')).toBe('2026-09-15T06:59:59.999Z');
  });
});

describe('resolveDueDate — strict timestamps only (r1 P2)', () => {
  it('rejects an offsetless timestamp — the deadline must not depend on the API host TZ', () => {
    expect(() => resolveDueDate('2026-09-14T17:00:00', 'UTC')).toThrow(InvalidDueDateError);
  });

  it('rejects impossible calendar fields instead of normalizing them', () => {
    expect(() => resolveDueDate('2026-02-30T00:00:00Z', 'UTC')).toThrow(InvalidDueDateError);
    expect(() => resolveDueDate('2026-09-14T24:30:00Z', 'UTC')).toThrow(InvalidDueDateError);
  });

  it('rejects locale strings', () => {
    expect(() => resolveDueDate('09/14/2026', 'UTC')).toThrow(InvalidDueDateError);
  });

  it('accepts compact offsets and normalizes exactly', () => {
    expect(resolveDueDate('2026-09-14T17:00:00+0530', 'UTC')).toBe('2026-09-14T11:30:00.000Z');
  });

  it('rejects impossible UTC offsets', () => {
    expect(() => resolveDueDate('2026-09-14T17:00:00+19:00', 'UTC')).toThrow(InvalidDueDateError);
    // The minute component is base-60 — a 99-minute field must not total
    // into an accepted offset (r2), including under the 14:00 cap.
    expect(() => resolveDueDate('2026-09-14T17:00:00+00:99', 'UTC')).toThrow(InvalidDueDateError);
    expect(() => resolveDueDate('2026-09-14T17:00:00+12:60', 'UTC')).toThrow(InvalidDueDateError);
    // The ISO maximum itself stays valid.
    expect(resolveDueDate('2026-09-14T17:00:00+14:00', 'UTC')).toBe('2026-09-14T03:00:00.000Z');
  });
});
