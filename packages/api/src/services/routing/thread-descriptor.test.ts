import { describe, it, expect, vi } from 'vitest';
import { formatEditAge, formatThreadDescriptorLines } from './thread-descriptor';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatEditAge', () => {
  it('says nothing when the field has never been edited', () => {
    // 19.2% of real threads are in this state. Annotating every one of them
    // would add noise to the line the annotation exists to clarify.
    expect(formatEditAge(null, NOW)).toBe('');
    expect(formatEditAge(undefined, NOW)).toBe('');
  });

  it('reports minutes, hours and days at the right boundaries', () => {
    expect(formatEditAge(ago(5 * MINUTE), NOW)).toBe(' (set 5m ago)');
    expect(formatEditAge(ago(59 * MINUTE), NOW)).toBe(' (set 59m ago)');
    expect(formatEditAge(ago(HOUR), NOW)).toBe(' (set 1h ago)');
    expect(formatEditAge(ago(47 * HOUR), NOW)).toBe(' (set 47h ago)');
    expect(formatEditAge(ago(48 * HOUR), NOW)).toBe(' (set 2d ago)');
    expect(formatEditAge(ago(4 * DAY), NOW)).toBe(' (set 4d ago)');
  });

  it('says nothing rather than something absurd for an unusable timestamp', () => {
    // A future timestamp would otherwise render "(set -3m ago)", which reads as
    // a bug in the thread rather than in the clock.
    expect(formatEditAge(new Date(NOW + HOUR).toISOString(), NOW)).toBe('');
    expect(formatEditAge('not-a-date', NOW)).toBe('');
  });
});

describe('formatThreadDescriptorLines', () => {
  it('emits nothing for a thread nobody has described', () => {
    // This is today's behaviour, and it must survive: a trigger for an
    // undescribed thread should read exactly as it does now, not gain empty
    // "Title:" scaffolding.
    expect(
      formatThreadDescriptorLines(
        { title: null, summary: null, titleUpdatedAt: null, summaryUpdatedAt: null },
        NOW
      )
    ).toEqual([]);
    expect(formatThreadDescriptorLines(null, NOW)).toEqual([]);
  });

  it('carries the summary and its age onto the line an SB reads first', () => {
    const lines = formatThreadDescriptorLines(
      {
        title: 'Legibility commission',
        summary: 'Reply routing shipped in #638; thread titles in progress.',
        titleUpdatedAt: ago(4 * DAY),
        summaryUpdatedAt: ago(30 * MINUTE),
      },
      NOW
    );

    expect(lines).toEqual([
      'Title: Legibility commission (set 4d ago)',
      'Summary of thread: Reply routing shipped in #638; thread titles in progress. (set 30m ago)',
    ]);
  });

  it('shows a stale description as stale rather than as current', () => {
    // The spec:review-requests case: a title asserting v1 while the artifact is
    // at v10. The age is what lets a reader distrust it.
    const lines = formatThreadDescriptorLines(
      {
        title: 'Review Requests — ink://specs/review-requests v1',
        summary: null,
        titleUpdatedAt: ago(21 * DAY),
        summaryUpdatedAt: null,
      },
      NOW
    );

    expect(lines).toEqual([
      'Title: Review Requests — ink://specs/review-requests v1 (set 21d ago)',
    ]);
  });

  it('emits a title with no age when it still holds its creation-time value', () => {
    const lines = formatThreadDescriptorLines(
      {
        title: 'Subject from the first message',
        summary: null,
        titleUpdatedAt: null,
        summaryUpdatedAt: null,
      },
      NOW
    );

    expect(lines).toEqual(['Title: Subject from the first message']);
  });

  it('emits only the summary when there is no title', () => {
    const lines = formatThreadDescriptorLines(
      {
        title: null,
        summary: 'Described but never titled',
        titleUpdatedAt: null,
        summaryUpdatedAt: ago(2 * HOUR),
      },
      NOW
    );

    expect(lines).toEqual(['Summary of thread: Described but never titled (set 2h ago)']);
  });
});
