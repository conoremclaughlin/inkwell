import { describe, it, expect, vi } from 'vitest';
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

  it('never claims an edit it cannot date did not happen', () => {
    // Lumen's #641 round 2. A future-dated or unparseable title_updated_at
    // made ageLabel return null, and the first cut read that as "no edit" and
    // fell through to the creation-time branch — telling the reader the title
    // had never been edited, with a confident age attached, on a row that
    // records an edit. The row's evidence for "never edited" is the column
    // being unset, and nothing else.
    const lines = (titleUpdatedAt: string) =>
      formatTitleProvenance(titleUpdatedAt, ago(21 * DAY), NOW);
    expect(lines(new Date(NOW + MINUTE).toISOString())).toBe(' (edited, edit time unknown)');
    expect(lines(new Date(NOW + 30 * DAY).toISOString())).toBe(' (edited, edit time unknown)');
    expect(lines('not-a-date')).toBe(' (edited, edit time unknown)');
    // The control: a datable edit still reports its age, and an absent one
    // still reaches the creation-time branch.
    expect(lines(ago(2 * DAY))).toBe(' (set 2d ago)');
    expect(formatTitleProvenance(null, ago(21 * DAY), NOW)).toBe(
      ' (never edited, from the first message 21d ago)'
    );
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

/*
 * The trigger call site used to be guarded here by matching the text of
 * server.ts. That guard existed for one hazard: this branch is stacked on #638,
 * whose fix rewrites the same region of server.ts the call lives in, and no test
 * in this file could see a caller dropped by that merge — they all exercise
 * loadThreadDescriptor directly.
 *
 * The merge has now happened, and it brought the instrument that replaces the
 * guard. `channels/trigger-retry-listener.test.ts` lifts the real default
 * handler out of server.ts by its AST and runs that source in a VM, so the
 * call site can be tested by executing it: see "the thread describes itself in
 * the prompt the SB actually reads" there, which asserts that the description
 * is loaded for the RECIPIENT and that its lines reach the prompt.
 *
 * Measured on the integrated head before removing this: dropping the recipient
 * argument, and deleting the render loop, each failed both the old source-text
 * guard and the new executing tests. Superseded rather than merely duplicated —
 * a source match cannot tell whether the call runs or what it produces.
 */
