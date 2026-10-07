import { describe, expect, it } from 'vitest';
import {
  EMOJI_COMPONENT_COUNT,
  FULLY_QUALIFIED_HEX,
  MINIMALLY_QUALIFIED_HEX,
  UNQUALIFIED_HEX,
} from './validation.generated.js';
import { catalogEmoji, EMOJI_CATALOG_VERSION, normalizeReactionEmoji } from './index.js';

const fromHex = (hex: string) =>
  hex
    .split(' ')
    .map((h) => String.fromCodePoint(parseInt(h, 16)))
    .join('');

describe('the pinned catalog', () => {
  it('has the counts emoji-test.txt declares for Unicode 18.0', () => {
    expect(FULLY_QUALIFIED_HEX).toHaveLength(3963);
    expect(MINIMALLY_QUALIFIED_HEX).toHaveLength(1029);
    expect(UNQUALIFIED_HEX).toHaveLength(243);
    expect(EMOJI_COMPONENT_COUNT).toBe(9);
    expect(EMOJI_CATALOG_VERSION).toMatch(/^unicode-18\.0\+cldr-\S+$/);
  });

  it('bounds every fully-qualified sequence at 15 UTF-16 units and 10 code points', () => {
    const emoji = catalogEmoji();
    expect(Math.max(...emoji.map((e) => e.length))).toBe(15);
    expect(Math.max(...emoji.map((e) => [...e].length))).toBe(10);
  });

  it('lists each sequence once, and no alias is itself fully-qualified', () => {
    const emoji = new Set(catalogEmoji());
    expect(emoji.size).toBe(FULLY_QUALIFIED_HEX.length);
    const aliases = [...MINIMALLY_QUALIFIED_HEX, ...UNQUALIFIED_HEX].map(([hex]) => fromHex(hex));
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases.filter((alias) => emoji.has(alias))).toEqual([]);
  });
});

describe('normalizeReactionEmoji, over the complete catalog', () => {
  it('keeps every fully-qualified sequence as itself', () => {
    const wrong = catalogEmoji().filter((emoji) => normalizeReactionEmoji(emoji) !== emoji);
    expect(wrong).toEqual([]);
  });

  it('stores every listed alias as its fully-qualified form', () => {
    const emoji = catalogEmoji();
    const wrong = [...MINIMALLY_QUALIFIED_HEX, ...UNQUALIFIED_HEX].filter(
      ([hex, index]) => normalizeReactionEmoji(fromHex(hex)) !== emoji[index]
    );
    expect(wrong).toEqual([]);
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 1, ['\u{2764}\u{FE0F}'], { emoji: '\u{2764}\u{FE0F}' }]) {
      expect(normalizeReactionEmoji(value)).toBeNull();
    }
  });
});
