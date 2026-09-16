import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  formatEditAge,
  formatTitleProvenance,
  formatThreadDescriptorLines,
} from './thread-descriptor';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatEditAge', () => {
  it('says nothing when there is no usable instant', () => {
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

describe('formatTitleProvenance', () => {
  it('dates an edited title by its edit', () => {
    expect(formatTitleProvenance(ago(4 * DAY), ago(30 * DAY), NOW)).toBe(' (set 4d ago)');
  });

  it('dates an unedited title by the thread, and says it was never edited', () => {
    // The case Lumen's review turned around. I originally emitted "" here,
    // reasoning that the 19.2% of threads that have never been retitled would
    // be noisy to annotate. Backwards: an unedited title is the one MOST in
    // need of a date. This feature's own worked example — a title reading
    // "v1" while the artifact is at v10 — is a creation-time title, and under
    // the old rule it rendered with nothing at all to distrust it by.
    expect(formatTitleProvenance(null, ago(21 * DAY), NOW)).toBe(
      ' (never edited, from the first message 21d ago)'
    );
  });

  it('still says the title is unedited when the thread has no usable creation time', () => {
    // No silent "" fallback: a bare confident `Title:` is the failure mode.
    expect(formatTitleProvenance(null, null, NOW)).toBe(' (never edited, age unknown)');
    expect(formatTitleProvenance(null, 'not-a-date', NOW)).toBe(' (never edited, age unknown)');
  });
});

describe('formatThreadDescriptorLines', () => {
  it('emits nothing for a thread nobody has described', () => {
    // This is today's behaviour, and it must survive: a trigger for an
    // undescribed thread should read exactly as it does now, not gain empty
    // "Title:" scaffolding.
    expect(
      formatThreadDescriptorLines(
        {
          title: null,
          summary: null,
          titleUpdatedAt: null,
          summaryUpdatedAt: null,
          createdAt: ago(3 * DAY),
        },
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
        createdAt: ago(9 * DAY),
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
        createdAt: ago(40 * DAY),
      },
      NOW
    );

    expect(lines).toEqual([
      'Title: Review Requests — ink://specs/review-requests v1 (set 21d ago)',
    ]);
  });

  it('never presents a creation-time title as a bare confident line', () => {
    // Regression for Lumen's #641 finding. All 470 pre-existing titles and
    // every new thread are in exactly this state — title set, title_updated_at
    // NULL — and this is the shape a 21-day-stale title arrives in.
    const lines = formatThreadDescriptorLines(
      {
        title: 'Subject from the first message',
        summary: null,
        titleUpdatedAt: null,
        summaryUpdatedAt: null,
        createdAt: ago(21 * DAY),
      },
      NOW
    );

    expect(lines).toEqual([
      'Title: Subject from the first message (never edited, from the first message 21d ago)',
    ]);
  });

  it('emits only the summary when there is no title', () => {
    const lines = formatThreadDescriptorLines(
      {
        title: null,
        summary: 'Described but never titled',
        titleUpdatedAt: null,
        summaryUpdatedAt: ago(2 * HOUR),
        createdAt: ago(5 * DAY),
      },
      NOW
    );

    expect(lines).toEqual(['Summary of thread: Described but never titled (set 2h ago)']);
  });

  it('marks a summary whose edit time is missing rather than implying it is fresh', () => {
    // Only update_thread writes a summary and it always stamps the time, so
    // this is an anomalous row — written by direct SQL, or by a writer that
    // forgot. Saying so beats letting it read as current.
    const lines = formatThreadDescriptorLines(
      {
        title: null,
        summary: 'Written by something that did not stamp the time',
        titleUpdatedAt: null,
        summaryUpdatedAt: null,
        createdAt: ago(5 * DAY),
      },
      NOW
    );

    expect(lines).toEqual([
      'Summary of thread: Written by something that did not stamp the time (edit time unknown)',
    ]);
  });
});

describe('the trigger call site still passes a recipient', () => {
  /**
   * A source-text check, and deliberately so. The membership argument is what
   * keeps a thread's description away from non-participants, and the ONLY
   * caller is the trigger preamble in server.ts — which cannot be imported
   * here, because that module ends in an unconditional startServer().
   *
   * It exists because of a specific, known hazard rather than as general
   * belt-and-braces. #641 is stacked on #638, and #638's r1 fix rewrites the
   * same region of server.ts that this call lives in — 116 lines deleted from
   * the trigger path. That merge resolution has to re-place this block by hand,
   * and if it drops the call, or keeps it with the old three arguments, every
   * behavioural test in this PR stays green: they exercise loadThreadDescriptor
   * directly, and a caller that no longer exists breaks none of them. A
   * branch-only addition lost in a merge leaves no hunk in either diff to see.
   *
   * It asserts a call shape, not behaviour. If the call site legitimately moves
   * to another module, move this check with it rather than deleting it.
   */
  const serverSource = readFileSync(join(__dirname, '../../server.ts'), 'utf8');

  it('calls loadThreadDescriptor exactly once, with the trigger target', () => {
    const calls = serverSource.match(/loadThreadDescriptor\s*\(([^;]*?)\)\s*;/gs) ?? [];
    expect(calls).toHaveLength(1);
    // The recipient is the fourth argument; without it the loader cannot test
    // membership and the preamble goes back to leaking to any triggered SB.
    expect(calls[0]).toContain('targetSlug');
  });

  it('renders the descriptor lines it loads', () => {
    // The other half of the wiring: loading the descriptor and never emitting
    // it would be a silent no-op rather than a leak, and equally invisible.
    expect(serverSource).toContain('formatThreadDescriptorLines');
  });
});
