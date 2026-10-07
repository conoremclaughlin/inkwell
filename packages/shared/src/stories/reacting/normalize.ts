/**
 * Which strings a reaction may be added with (design
 * ink://designs/reaction-emoji-catalog §1). An exact lookup over the pinned
 * catalog: a fully-qualified sequence is itself, a listed minimally-qualified
 * or unqualified sequence is its fully-qualified form, and anything else is
 * refused. Nothing is computed from the input: no selector is stripped and no
 * pattern stands in for the catalog, so a near-miss the catalog does not list
 * is refused rather than repaired.
 *
 * Removal and display never consult this: a stored reaction is shown and
 * removed exactly as stored.
 */

import {
  FULLY_QUALIFIED_HEX,
  MINIMALLY_QUALIFIED_HEX,
  UNQUALIFIED_HEX,
} from './validation.generated.js';

export { EMOJI_CATALOG_PRERELEASE, EMOJI_CATALOG_VERSION } from './validation.generated.js';

function fromHex(hex: string): string {
  return hex
    .split(' ')
    .map((h) => String.fromCodePoint(parseInt(h, 16)))
    .join('');
}

let fullyQualified: readonly string[] | null = null;
let accepted: ReadonlyMap<string, string> | null = null;

/** Every fully-qualified sequence, in catalog order: an emoji's index is its position here. */
export function catalogEmoji(): readonly string[] {
  fullyQualified ??= FULLY_QUALIFIED_HEX.map(fromHex);
  return fullyQualified;
}

function acceptedForms(): ReadonlyMap<string, string> {
  if (accepted) return accepted;
  const emoji = catalogEmoji();
  const map = new Map<string, string>(emoji.map((seq) => [seq, seq]));
  for (const [hex, index] of [...MINIMALLY_QUALIFIED_HEX, ...UNQUALIFIED_HEX]) {
    map.set(fromHex(hex), emoji[index]);
  }
  accepted = map;
  return map;
}

/**
 * The fully-qualified form a new reaction is stored as, or null when the
 * input is not one emoji the catalog lists.
 */
export function normalizeReactionEmoji(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return acceptedForms().get(input) ?? null;
}
