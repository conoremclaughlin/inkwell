import { describe, it, expect } from 'vitest';
import { formatCurrentWork, UNKNOWN_AGE } from './current-work.js';

describe('formatCurrentWork', () => {
  it('renders the work with its age', () => {
    expect(
      formatCurrentWork({ currentWork: 'Reviewing PR #652', currentWorkAgeLabel: '3h ago' })
    ).toBe('Reviewing PR #652 (3h ago)');
  });

  it('says the age is unknown rather than printing the text bare', () => {
    // The whole point. In a plain-text block an undated line reads as current,
    // so a missing age must be stated, not omitted. A row predating the
    // timestamp columns is the common case, not an edge one.
    expect(formatCurrentWork({ currentWork: 'Round five at head ead13bea' })).toBe(
      `Round five at head ead13bea (${UNKNOWN_AGE})`
    );
  });

  it('never renders an unknown age as recent', () => {
    // The 15 Sep failure mode, asserted directly: a four-day-old note read as a
    // live claim. Whatever UNKNOWN_AGE says, it must not say "now".
    const rendered = formatCurrentWork({ currentWork: 'Round five', currentWorkAgeLabel: null })!;

    expect(rendered).not.toMatch(/just now|\d+[mhd] ago/);
  });

  it('treats a blank age label as unknown', () => {
    expect(formatCurrentWork({ currentWork: 'Work', currentWorkAgeLabel: '   ' })).toBe(
      `Work (${UNKNOWN_AGE})`
    );
  });

  it('returns null when the session has said nothing', () => {
    expect(formatCurrentWork({})).toBeNull();
    expect(formatCurrentWork({ currentWork: null })).toBeNull();
    expect(formatCurrentWork({ currentWork: '   ' })).toBeNull();
  });

  it('ignores a non-string currentWork rather than printing [object Object]', () => {
    expect(formatCurrentWork({ currentWork: { text: 'nope' } })).toBeNull();
  });
});
