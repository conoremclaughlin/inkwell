/** Literal, bounded search for authenticated list routes. No RPC or embeddings. */
export type ListSearch = { ok: true; words: string[] } | { ok: false; error: string };

export function parseListSearch(value: unknown): ListSearch {
  if (value === undefined) return { ok: true, words: [] };
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /\p{Cs}/u.test(value)
  ) {
    return {
      ok: false,
      error:
        'search must be valid Unicode text of at most 200 characters, without control characters',
    };
  }
  const words = [...new Set(value.trim().split(/\s+/u).filter(Boolean))];
  if (words.length > 12) return { ok: false, error: 'search must contain at most 12 words' };
  return { ok: true, words };
}

/**
 * Each word must occur in at least one field. Only our fixed column names
 * reach this builder. imatch (~*) supports pg_trgm just like ILIKE, without
 * PostgREST's '*' wildcard alias. Escaping the regex FIRST and the quoted
 * PostgREST value SECOND keeps punctuation literal in both grammars. For
 * these well-formed, control-free Unicode strings, JSON string quoting uses
 * precisely the quote and backslash escapes that PostgREST accepts.
 */
export function listSearchFilter(
  words: string[],
  fields: readonly ('title' | 'content' | 'description')[]
): string {
  const clauses = words.map((word) => {
    const literal = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quoted = JSON.stringify(literal);
    return `or(${fields.map((field) => `${field}.imatch.${quoted}`).join(',')})`;
  });
  return `and(${clauses.join(',')})`;
}
