// Lumen's review regressions for #758 (round 1, at 4eccb405), kept as written:
// a skin-tone variant belongs to its own base, never to the untoned row above
// it. All eight were red against the adjacency mapping.
import { describe, expect, it } from 'vitest';
import { catalogEmoji } from '../reacting/index.js';
import { emojiName, toneVariants } from './index.js';
// @ts-expect-error: the generator is a plain JavaScript developer script.
import { buildCatalog } from '../../../../../scripts/generate-emoji-catalog.mjs';

const FAMILIES = [
  ['\u{1F46F}', 'people with bunny ears'],
  ['\u{1F46F}\u{200D}\u{2642}\u{FE0F}', 'men with bunny ears'],
  ['\u{1F46F}\u{200D}\u{2640}\u{FE0F}', 'women with bunny ears'],
  ['\u{1F93C}', 'people wrestling'],
  ['\u{1F93C}\u{200D}\u{2642}\u{FE0F}', 'men wrestling'],
  ['\u{1F93C}\u{200D}\u{2640}\u{FE0F}', 'women wrestling'],
];

describe('review: mixed tones belong to their own base', () => {
  it.each(FAMILIES)('%s has all 25 variants of %s and none from another family', (emoji, name) => {
    expect(emojiName(emoji)).toBe(name);
    const variants = toneVariants(catalogEmoji().indexOf(emoji));
    expect(variants).toHaveLength(25);
    expect(variants.every((variant) => variant.name.startsWith(`${name}:`))).toBe(true);
    const tonePairs = new Set(
      variants.map((variant) =>
        [...variant.emoji].filter((point) => /[\u{1F3FB}-\u{1F3FF}]/u.test(point)).join('')
      )
    );
    expect(tonePairs.size).toBe(25);
  });
});

const entry = (hex: string, label: string) => ({
  hex,
  seq: hex
    .split(' ')
    .map((point) => String.fromCodePoint(parseInt(point, 16)))
    .join(''),
  label,
  status: 'fully-qualified',
  group: 'People & Body',
  subgroup: 'hand-fingers-closed',
});
const up = entry('1F44D', 'thumbs up');
const down = entry('1F44E', 'thumbs down');
const tonedUp = entry('1F44D 1F3FB', 'thumbs up: light skin tone');
const annotations = {
  names: new Map([up, down, tonedUp].map((e) => [e.seq, e.label])),
  keywords: new Map(),
};
const empty = { names: new Map(), keywords: new Map() };

it('review: a tone does not inherit an unrelated preceding base in the same subgroup', () => {
  const result = buildCatalog([up, down, tonedUp], annotations, empty);
  expect(result.rows[2].toneOf).toBe(0);
});

it('review: a tone with no matching base fails closed, even when another base precedes it', () => {
  expect(() => buildCatalog([down, tonedUp], annotations, empty)).toThrow();
});
