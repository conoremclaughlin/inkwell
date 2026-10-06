/**
 * Finding an emoji in the full picker by name (design
 * ink://designs/reaction-emoji-catalog §3). Prefix-only: an emoji matches when
 * every query word, in any order, is the start of a word in its CLDR name, its
 * CLDR keywords or a reviewed search alias. Results rank exact name, then
 * every query word in the name, then the rest, with ties in catalog order.
 * Search finds untoned emoji; a skin-tone variant is reached through its base.
 */

import { catalogEmoji } from '../reacting/index.js';
import { SEARCH_ALIASES } from './search-aliases.js';
import { EMOJI_GROUPS, EMOJI_SEARCH_ROWS, EMOJI_SUBGROUPS } from './search.generated.js';

export { EMOJI_GROUPS } from './search.generated.js';

/** One emoji as the picker shows it. */
export interface PickerEmoji {
  /** Its position in the catalog. */
  index: number;
  /** The fully-qualified sequence a reaction sends. */
  emoji: string;
  /** The CLDR name: the accessible name everywhere. */
  name: string;
  group: string;
  subgroup: string;
}

/** Text as search compares it: no diacritics, lowercase, split into words. */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

interface Searchable {
  index: number;
  nameWords: string[];
  words: string[];
}

let searchable: Searchable[] | null = null;
let indexByEmoji: ReadonlyMap<string, number> | null = null;

function emojiIndex(): ReadonlyMap<string, number> {
  indexByEmoji ??= new Map(catalogEmoji().map((emoji, index) => [emoji, index]));
  return indexByEmoji;
}

function entries(): Searchable[] {
  if (searchable) return searchable;
  const aliasWords = new Map<number, string[]>();
  for (const alias of SEARCH_ALIASES) {
    const index = emojiIndex().get(alias.emoji);
    if (index === undefined)
      throw new Error(`search alias "${alias.phrase}" names an emoji the catalog lacks`);
    aliasWords.set(index, [...(aliasWords.get(index) ?? []), ...searchWords(alias.phrase)]);
  }
  const built: Searchable[] = [];
  EMOJI_SEARCH_ROWS.forEach(([name, keywords, , , toneOf], index) => {
    if (toneOf >= 0) return;
    const nameWords = searchWords(name);
    const words = [...nameWords, ...searchWords(keywords), ...(aliasWords.get(index) ?? [])];
    built.push({ index, nameWords, words: [...new Set(words)] });
  });
  searchable = built;
  return built;
}

/** The picker's view of the emoji at a catalog index. */
export function pickerEmoji(index: number): PickerEmoji {
  const [name, , group, subgroup] = EMOJI_SEARCH_ROWS[index];
  return {
    index,
    emoji: catalogEmoji()[index],
    name,
    group: EMOJI_GROUPS[group],
    subgroup: EMOJI_SUBGROUPS[subgroup],
  };
}

/** The CLDR name of a fully-qualified emoji, or undefined when the catalog lacks it. */
export function emojiName(emoji: string): string | undefined {
  const index = emojiIndex().get(emoji);
  return index === undefined ? undefined : EMOJI_SEARCH_ROWS[index][0];
}

/** The skin-tone variants of an untoned emoji, mixed tones included, in catalog order. */
export function toneVariants(index: number): PickerEmoji[] {
  const variants: PickerEmoji[] = [];
  EMOJI_SEARCH_ROWS.forEach((row, i) => {
    if (row[4] === index) variants.push(pickerEmoji(i));
  });
  return variants;
}

const startsAll = (query: string[], words: string[]) =>
  query.every((q) => words.some((word) => word.startsWith(q)));

/** The emoji a query finds, best first; none for a query with no words. */
export function searchEmoji(query: string): PickerEmoji[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const phrase = words.join(' ');
  const found: Array<{ tier: number; index: number }> = [];
  for (const entry of entries()) {
    if (!startsAll(words, entry.words)) continue;
    const tier =
      entry.nameWords.join(' ') === phrase ? 0 : startsAll(words, entry.nameWords) ? 1 : 2;
    found.push({ tier, index: entry.index });
  }
  found.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return found.map(({ index }) => pickerEmoji(index));
}
