/**
 * An SB's own values and relationships, as its prompt carries them.
 *
 * Both live on the identity record and are written by the SB over time; the
 * shared values are its workspace's and arrive separately. Until Oct 7 2026
 * no prompt rendered either: bootstrap's agent info left them out, and
 * context-builder mapped them without printing them, so only the dashboard
 * showed them. Conor, 6:05 PM: "I think it's quite a cool way for things to
 * grow" (thread:inkling-starter-space).
 *
 * Bootstrap appends this to the identity document it returns; context-builder
 * renders it when the child does not call bootstrap itself. One renderer, so
 * the two paths cannot word it differently.
 */

/** The record's values: non-empty strings, in the order stored. */
export function ownValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** The record's relationships: who, and what they are to this SB. */
export function ownRelationships(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([who, what]): [string, string] => [who.trim(), what.trim()])
    .filter(([who, what]) => who.length > 0 && what.length > 0);
}

/** The sections, or null when the record holds neither. */
export function ownValuesAndRelationships(identity: {
  values?: unknown;
  relationships?: unknown;
}): string | null {
  const sections: string[] = [];
  const values = ownValues(identity.values);
  if (values.length > 0) {
    sections.push(['## My values', '', ...values.map((value) => `- ${value}`)].join('\n'));
  }
  const relationships = ownRelationships(identity.relationships);
  if (relationships.length > 0) {
    sections.push(
      [
        '## My relationships',
        '',
        ...relationships.map(([who, what]) => `- **${who}:** ${what}`),
      ].join('\n')
    );
  }
  return sections.length > 0 ? sections.join('\n\n') : null;
}

/** The identity document: the description, then the SB's own values and relationships. */
export function identityDocument(identity: {
  description?: unknown;
  values?: unknown;
  relationships?: unknown;
}): string | null {
  const description = typeof identity.description === 'string' ? identity.description.trim() : '';
  const own = ownValuesAndRelationships(identity);
  const parts = [description, own].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join('\n\n') : null;
}
