import { describe, expect, it } from 'vitest';
import { parseListSearch, listSearchFilter } from './list-search';

describe('bounded literal list search', () => {
  it('treats missing and whitespace-only input as ordinary listing', () => {
    expect(parseListSearch(undefined)).toEqual({ ok: true, words: [] });
    expect(parseListSearch('  \u3000 ')).toEqual({ ok: true, words: [] });
  });
  it('splits Unicode whitespace and preserves non-Latin text and punctuation', () => {
    expect(parseListSearch('  東京\u3000café 東京  ')).toEqual({
      ok: true,
      words: ['東京', 'café'],
    });
  });
  it.each([
    null,
    {},
    ['garden'],
    'x'.repeat(201),
    'a\u0000b',
    'a\nb',
    Array.from({ length: 13 }, (_, i) => `word${i}`).join(' '),
  ])('rejects malformed or unbounded input: %j', (value) => {
    expect(parseListSearch(value).ok).toBe(false);
  });
  it('requires every word across either field, not one entire-field phrase', () => {
    expect(listSearchFilter(['garden', 'paper'], ['title', 'content'])).toBe(
      'and(or(title.imatch."garden",content.imatch."garden"),or(title.imatch."paper",content.imatch."paper"))'
    );
  });
  it('quotes PostgREST syntax and escapes regex syntax independently', () => {
    const value = 'a,(b)."c"\\d*%_+?[]{}^$|';
    const filter = listSearchFilter([value], ['title']);
    // Recover exactly one quoted PostgREST value; no unquoted injected clauses.
    const encoded = filter.slice('and(or(title.imatch.'.length, -2);
    const regex = JSON.parse(encoded) as string;
    expect(new RegExp(regex, 'i').test(value)).toBe(true);
    expect(new RegExp(regex, 'i').test('unrelated text')).toBe(false);
    expect(regex).toContain('\\*%_');
  });
});
