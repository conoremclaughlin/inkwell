import { describe, it, expect } from 'vitest';
import {
  describeCurrentWork,
  describeCurrentWorkFromRow,
  formatAge,
  CURRENT_WORK_FALLBACK_MAX,
} from './current-work';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms);

describe('formatAge', () => {
  it('returns null when there is no timestamp', () => {
    // MUST be null, never "just now". Rows predating the timestamp columns have
    // no age, and rendering unknown as recent is the exact failure this guards.
    expect(formatAge(null, NOW)).toBeNull();
    expect(formatAge(undefined, NOW)).toBeNull();
  });

  it('reports the right unit at each boundary', () => {
    expect(formatAge(ago(30_000), NOW)).toBe('just now');
    expect(formatAge(ago(5 * MINUTE), NOW)).toBe('5m ago');
    expect(formatAge(ago(59 * MINUTE), NOW)).toBe('59m ago');
    expect(formatAge(ago(HOUR), NOW)).toBe('1h ago');
    expect(formatAge(ago(47 * HOUR), NOW)).toBe('47h ago');
    expect(formatAge(ago(48 * HOUR), NOW)).toBe('2d ago');
    expect(formatAge(ago(4 * DAY), NOW)).toBe('4d ago');
  });

  it('returns null for an unusable timestamp rather than something absurd', () => {
    expect(formatAge(new Date(NOW + HOUR), NOW)).toBeNull();
    expect(formatAge('not-a-date', NOW)).toBeNull();
  });
});

describe('describeCurrentWork', () => {
  it('prefers a purpose-written headline and marks it as one', () => {
    const view = describeCurrentWork(
      {
        headline: 'Reviewing PR #641 — thread titles',
        headlineUpdatedAt: ago(10 * MINUTE),
        context: 'A much longer scratch board block that should not be shown here.',
        contextUpdatedAt: ago(3 * DAY),
      },
      NOW
    );

    expect(view.currentWork).toBe('Reviewing PR #641 — thread titles');
    expect(view.currentWorkSource).toBe('headline');
    expect(view.currentWorkAgeLabel).toBe('10m ago');
    expect(view.currentWorkTruncated).toBe(false);
  });

  it('falls back to the context for the 736 sessions that predate headlines', () => {
    const view = describeCurrentWork(
      { context: 'Investigating the trigger routing gap', contextUpdatedAt: ago(2 * HOUR) },
      NOW
    );

    expect(view.currentWork).toBe('Investigating the trigger routing gap');
    // The source is reported so a truncated scratch note is never mistaken for
    // a line someone wrote to be read.
    expect(view.currentWorkSource).toBe('context');
    expect(view.currentWorkAgeLabel).toBe('2h ago');
  });

  it('truncates a long context and says that it did', () => {
    const long = 'x'.repeat(400);
    const view = describeCurrentWork({ context: long, contextUpdatedAt: ago(MINUTE) }, NOW);

    expect(view.currentWorkTruncated).toBe(true);
    expect(view.currentWork!.length).toBe(CURRENT_WORK_FALLBACK_MAX);
    expect(view.currentWork!.endsWith('…')).toBe(true);
  });

  it('does not truncate a context that already fits', () => {
    // Control for the case above: without this, a handler that truncated
    // everything would still pass the truncation test.
    const short = 'Short enough to show whole';
    const view = describeCurrentWork({ context: short, contextUpdatedAt: ago(MINUTE) }, NOW);

    expect(view.currentWork).toBe(short);
    expect(view.currentWorkTruncated).toBe(false);
  });

  it('reports an unknown age as null rather than as recent', () => {
    // The real 15 Sep failure: a context block written on 11 Sep, describing
    // round five, read as a live claim about a PR then at round eight. A
    // missing timestamp must read as "unknown", never as "now".
    const view = describeCurrentWork({ context: 'Round five at head ead13bea' }, NOW);

    expect(view.currentWork).toBe('Round five at head ead13bea');
    expect(view.currentWorkAgeLabel).toBeNull();
    expect(view.currentWorkAt).toBeNull();
  });

  it('shows a stale headline as stale rather than hiding it', () => {
    const view = describeCurrentWork(
      { headline: 'Round five at head ead13bea', headlineUpdatedAt: ago(4 * DAY) },
      NOW
    );

    expect(view.currentWork).toBe('Round five at head ead13bea');
    expect(view.currentWorkAgeLabel).toBe('4d ago');
  });

  it('says nothing when the session has said nothing', () => {
    const view = describeCurrentWork({}, NOW);

    expect(view.currentWork).toBeNull();
    expect(view.currentWorkSource).toBeNull();
    expect(view.currentWorkAgeLabel).toBeNull();
  });

  it('treats a whitespace-only headline as absent and falls through', () => {
    const view = describeCurrentWork(
      { headline: '   ', context: 'Real work here', contextUpdatedAt: ago(MINUTE) },
      NOW
    );

    expect(view.currentWorkSource).toBe('context');
    expect(view.currentWork).toBe('Real work here');
  });
});

describe('describeCurrentWorkFromRow', () => {
  const iso = (ms: number) => new Date(NOW - ms).toISOString();

  it('reads the snake_case columns the admin routes actually hold', () => {
    const view = describeCurrentWorkFromRow(
      { headline: 'Reviewing PR #652', headline_updated_at: iso(5 * MINUTE) },
      NOW
    );

    expect(view.currentWork).toBe('Reviewing PR #652');
    expect(view.currentWorkSource).toBe('headline');
    expect(view.currentWorkAgeLabel).toBe('5m ago');
  });

  it('falls back to context and stamps it from context_updated_at', () => {
    const view = describeCurrentWorkFromRow(
      { headline: null, context: 'Scratch note', context_updated_at: iso(3 * HOUR) },
      NOW
    );

    expect(view.currentWorkSource).toBe('context');
    expect(view.currentWorkAgeLabel).toBe('3h ago');
  });

  it('gives a pre-feature row no age rather than a recent one', () => {
    // The shape every row had before the migration: context present, no stamp.
    // This is the 15 Sep near-miss as it reaches the dashboard.
    const view = describeCurrentWorkFromRow(
      { context: 'Round five at head ead13bea', context_updated_at: null },
      NOW
    );

    expect(view.currentWork).toBe('Round five at head ead13bea');
    expect(view.currentWorkAgeLabel).toBeNull();
    expect(view.currentWorkAt).toBeNull();
  });

  it('agrees with describeCurrentWork on the same underlying values', () => {
    // Tested against the camelCase renderer rather than against my expectation
    // of it: two implementations of the fallback would eventually disagree
    // about whether a line is a status or a truncated note, and only a
    // cross-check between them can see that.
    const row = { headline: null, context: 'x'.repeat(400), context_updated_at: iso(MINUTE) };

    expect(describeCurrentWorkFromRow(row, NOW)).toEqual(
      describeCurrentWork(
        { context: 'x'.repeat(400), contextUpdatedAt: new Date(NOW - MINUTE) },
        NOW
      )
    );
  });
});
