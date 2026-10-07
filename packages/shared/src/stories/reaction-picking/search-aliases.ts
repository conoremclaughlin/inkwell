/**
 * Words a person must be able to find an emoji by that the pinned CLDR
 * annotations miss (design ink://designs/reaction-emoji-catalog §3).
 * Hand-written and reviewed; the generator never touches it. An entry exists
 * only where the annotations alone do not find the emoji, and a test fails
 * on any entry they already cover. An alias ranks exactly like a CLDR keyword.
 */

export interface SearchAlias {
  /** The words, matched like keywords: every query word must prefix one of them. */
  phrase: string;
  /** The fully-qualified emoji they find. */
  emoji: string;
  /** Why the entry exists. */
  why: string;
}

export const SEARCH_ALIASES: readonly SearchAlias[] = [
  {
    phrase: 'laughing',
    emoji: '\u{1F602}',
    why: 'v1 quick-row name for face with tears of joy, in both clients; CLDR has "laugh" only',
  },
  {
    phrase: 'thank you',
    emoji: '\u{1F64F}',
    why: 'the Inkling app v1 quick-row name for folded hands; CLDR has "thanks" but not "you"',
  },
];
