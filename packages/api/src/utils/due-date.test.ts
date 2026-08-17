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
