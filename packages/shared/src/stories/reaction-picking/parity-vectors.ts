/**
 * Fixed cases both copies of the catalog must agree on: this repo's stories
 * and the Inkling app's byte-identical copy (design
 * ink://designs/reaction-emoji-catalog §1). They sit beside the complete-
 * catalog checks, which every copy also runs; these name the cases a
 * regeneration or a hand edit is most likely to break.
 *
 * Every code point is written as a \u{...} escape, so no joiner, selector or
 * control character is invisible in review.
 */

/** normalizeReactionEmoji input → the stored form, or null when refused. */
export const NORMALIZE_VECTORS: ReadonlyArray<readonly [string, string | null]> = [
  // Fully-qualified forms are themselves.
  ['\u{2764}\u{FE0F}', '\u{2764}\u{FE0F}'],
  ['\u{1F44D}', '\u{1F44D}'],
  ['\u{31}\u{FE0F}\u{20E3}', '\u{31}\u{FE0F}\u{20E3}'],
  [
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  ],
  [
    '\u{1F9D1}\u{1F3FB}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F48B}\u{200D}\u{1F9D1}\u{1F3FC}',
    '\u{1F9D1}\u{1F3FB}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F48B}\u{200D}\u{1F9D1}\u{1F3FC}',
  ],
  // Listed legacy spellings are stored fully-qualified.
  ['\u{2764}', '\u{2764}\u{FE0F}'],
  ['\u{31}\u{20E3}', '\u{31}\u{FE0F}\u{20E3}'],
  [
    '\u{1F9D1}\u{1F3FB}\u{200D}\u{2764}\u{200D}\u{1F48B}\u{200D}\u{1F9D1}\u{1F3FC}',
    '\u{1F9D1}\u{1F3FB}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F48B}\u{200D}\u{1F9D1}\u{1F3FC}',
  ],
  // Refused: not one emoji the catalog lists.
  ['', null],
  ['a', null],
  ['\u{1F3FB}', null],
  ['\u{1F600}\u{200D}\u{1F600}', null],
  ['\u{2764}\u{FE0F}\u{2764}\u{FE0F}', null],
  ['\u{2764}\u{FE0F}\u{20}', null],
  ['\u{202E}\u{2764}\u{FE0F}', null],
  ['\u{0}', null],
  // Selector near-misses a permissive rule would repair; the catalog lists none of them.
  ['\u{1F600}\u{FE0F}', null],
  ['\u{2764}\u{FE0E}', null],
  ['\u{2764}\u{FE0F}\u{FE0F}', null],
];

/** A query and an emoji it must find: v1's quick-row words (Myra, a6a2075c). */
export const SEARCH_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['heart', '\u{2764}\u{FE0F}'],
  ['thumbs up', '\u{1F44D}'],
  ['laughing', '\u{1F602}'],
  ['surprised', '\u{1F62E}'],
  ['sad', '\u{1F622}'],
  ['thank you', '\u{1F64F}'],
  ['thanks', '\u{1F64F}'],
];
