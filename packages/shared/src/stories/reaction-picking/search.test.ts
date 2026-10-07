import { describe, expect, it } from 'vitest';
import { EMOJI_CATALOG_VERSION, catalogEmoji } from '../reacting/index.js';
import { SEARCH_VECTORS } from './parity-vectors.js';
import { EMOJI_SEARCH_CATALOG_VERSION, EMOJI_SEARCH_ROWS } from './search.generated.js';
import { SEARCH_ALIASES, emojiName, searchEmoji, searchWords, toneVariants } from './index.js';

const found = (query: string) => searchEmoji(query).map((e) => e.emoji);
const indexOf = (emoji: string) => catalogEmoji().indexOf(emoji);

describe('the search data', () => {
  it('comes from the same catalog as the validation data, one row per emoji', () => {
    expect(EMOJI_SEARCH_CATALOG_VERSION).toBe(EMOJI_CATALOG_VERSION);
    expect(EMOJI_SEARCH_ROWS).toHaveLength(catalogEmoji().length);
  });

  it('names every emoji', () => {
    expect(EMOJI_SEARCH_ROWS.filter(([name]) => name.trim() === '')).toEqual([]);
    expect(emojiName('\u{2764}\u{FE0F}')).toBe('red heart');
    expect(emojiName('\u{1F602}')).toBe('face with tears of joy');
    expect(emojiName('\u{2764}')).toBeUndefined();
  });

  it('points every skin-tone variant at an untoned base', () => {
    const bad = EMOJI_SEARCH_ROWS.filter(
      ([, , , , base]) => base >= 0 && EMOJI_SEARCH_ROWS[base][4] !== -1
    );
    expect(bad).toEqual([]);
    expect(toneVariants(indexOf('\u{1F44D}'))).toHaveLength(5);
    expect(toneVariants(indexOf('\u{1F91D}'))).toHaveLength(25);
    expect(toneVariants(indexOf('\u{1F44D}\u{1F3FB}'))).toEqual([]);
  });
});

describe('searchEmoji', () => {
  it("finds each of v1's quick-row words, all seven covered by the parity vectors", () => {
    expect(SEARCH_VECTORS.map(([query]) => query)).toEqual([
      'heart',
      'thumbs up',
      'laughing',
      'surprised',
      'sad',
      'thank you',
      'thanks',
    ]);
  });

  it('matches word prefixes only, never a substring', () => {
    expect(found('laugh')).toContain('\u{1F602}');
    expect(found('augh')).toEqual([]);
  });

  it('needs every query word, in any order', () => {
    expect(found('up thumbs')).toContain('\u{1F44D}');
    expect(found('thumbs zzz')).toEqual([]);
  });

  it('ranks an exact name first, then the name, then keywords, ties in catalog order', () => {
    // "grinning cat" comes earlier in the catalog, but "cat" is an exact name.
    const cat = found('cat');
    expect(cat[0]).toBe('\u{1F408}');
    expect(indexOf('\u{1F63A}')).toBeLessThan(indexOf('\u{1F408}'));
    // "red heart" has "heart" in its name; a keyword-only match follows every name match.
    const heart = searchEmoji('heart');
    const nameMatches = heart.filter((e) => searchWords(e.name).some((w) => w.startsWith('heart')));
    expect(heart.slice(0, nameMatches.length)).toEqual(nameMatches);
    expect(nameMatches.length).toBeLessThan(heart.length);
    for (const tier of [nameMatches, heart.slice(nameMatches.length)]) {
      const order = tier.map((e) => e.index);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it('ignores case and diacritics', () => {
    // CLDR spells these keywords only with their diacritics: "crêpe", "gyōza".
    expect(found('crepe')).toContain('\u{1F95E}');
    expect(found('CRÊPE')).toContain('\u{1F95E}');
    expect(found('Gyoza')).toContain('\u{1F95F}');
  });

  it('finds untoned emoji only, and nothing for an empty or unknown query', () => {
    expect(found('thumbs up')).not.toContain('\u{1F44D}\u{1F3FB}');
    expect(found('')).toEqual([]);
    expect(found('  ')).toEqual([]);
    expect(found('zzzzqx')).toEqual([]);
  });
});

describe('SEARCH_ALIASES', () => {
  it('adds only words the pinned annotations miss', () => {
    // An alias the CLDR name and keywords already cover is speculative.
    const redundant = SEARCH_ALIASES.filter((alias) => {
      const [name, keywords] = EMOJI_SEARCH_ROWS[indexOf(alias.emoji)];
      const words = [...searchWords(name), ...searchWords(keywords)];
      return searchWords(alias.phrase).every((q) => words.some((w) => w.startsWith(q)));
    });
    expect(redundant).toEqual([]);
  });

  it('names untoned catalog emoji, with a reason each', () => {
    for (const alias of SEARCH_ALIASES) {
      expect(indexOf(alias.emoji)).toBeGreaterThanOrEqual(0);
      expect(EMOJI_SEARCH_ROWS[indexOf(alias.emoji)][4]).toBe(-1);
      expect(alias.why.length).toBeGreaterThan(0);
    }
  });
});
