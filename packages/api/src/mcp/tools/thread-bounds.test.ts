import { describe, it, expect } from 'vitest';
import { boundThreadTitle, THREAD_TITLE_MAX } from './thread-bounds';

describe('boundThreadTitle', () => {
  it('passes a subject the column would accept through unchanged', () => {
    expect(boundThreadTitle('Review PR #641')).toBe('Review PR #641');
    const atBound = 'x'.repeat(THREAD_TITLE_MAX);
    expect(boundThreadTitle(atBound)).toBe(atBound);
  });

  it('keeps nothing as nothing — an absent subject is not an empty title', () => {
    expect(boundThreadTitle(null)).toBeNull();
    expect(boundThreadTitle(undefined)).toBeNull();
    expect(boundThreadTitle('')).toBeNull();
  });

  it('truncates one character over the bound, ellipsis included in the budget', () => {
    const bounded = boundThreadTitle('x'.repeat(THREAD_TITLE_MAX + 1));
    expect(bounded).not.toBeNull();
    expect([...bounded!].length).toBe(THREAD_TITLE_MAX);
    expect(bounded!.endsWith('…')).toBe(true);
  });

  it('measures code points, because that is what the CHECK constraint counts', () => {
    // 150 astral characters are 300 UTF-16 units but 150 characters to
    // Postgres's char_length, so the constraint takes them whole. Measuring in
    // JS string length would truncate a subject the database would have kept.
    const astral = '𝔸'.repeat(150);
    expect(astral.length).toBeGreaterThan(THREAD_TITLE_MAX);
    expect(boundThreadTitle(astral)).toBe(astral);

    // And the truncation itself counts the same way: 201 astral characters cut
    // to exactly 200, with the kept part still 199 whole characters rather than
    // a run ending in half a surrogate pair.
    const overBound = '𝔸'.repeat(THREAD_TITLE_MAX + 1);
    const bounded = boundThreadTitle(overBound)!;
    expect([...bounded].length).toBe(THREAD_TITLE_MAX);
    expect(bounded.slice(0, -1)).toBe('𝔸'.repeat(THREAD_TITLE_MAX - 1));
  });
});
