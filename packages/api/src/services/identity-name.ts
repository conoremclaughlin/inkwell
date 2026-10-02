/**
 * The name an identity goes by, for anything that tells an SB who it is or
 * shows a client its name.
 *
 * An inkling the person has not named yet stores a placeholder ("Unnamed
 * inkling") as its name, and goes by no name until it is named
 * (metadata.named === false). For it this answers null, and each caller words
 * that itself. Every other identity goes by its stored name. Keyed off the
 * stored flag, never off the placeholder text.
 *
 * Records of what was stored (identity history, restore) keep the stored
 * value; this is for reads that present an identity as itself.
 */

export function isUnnamed(row: { metadata?: unknown }): boolean {
  return (row.metadata as { named?: unknown } | null | undefined)?.named === false;
}

export function nameOf(row: { name: string; metadata?: unknown }): string | null {
  return isUnnamed(row) ? null : row.name;
}
