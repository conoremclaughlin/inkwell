/**
 * Session keys.
 *
 * A session key is the typed, routable name of a session: `wren:inkwell:main`,
 * `review`, `wren/inkwell/main`. It is what an SB names its own session with
 * (`update_session_state({ sessionKey })`) and what a sender addresses it by
 * (`send_to_inbox({ recipientSlug, sessionKey })`). The spelling is decided
 * here and nowhere else, so the setter, the send path and the hook route
 * agree: a key set as " Wren:Inkwell:Main " and addressed as
 * "wren:inkwell:main" is one key.
 *
 * Storage: the `sessions.alias` column, under its older name. The column is
 * the only place that name survives; in TypeScript, tool schemas and
 * documents the pair is `sessionKey` / `sessionAlias` (deprecated input).
 *
 * Separator: colons (Conor, 2026-10-01, ink://specs/key-schemes v3). A
 * slash is still an allowed character inside a name (branch-like names), not
 * a separator.
 */
export const SESSION_KEY_MAX_LENGTH = 80;

const SESSION_KEY_PATTERN = /^[a-z0-9][a-z0-9:/._-]*$/;

export type SessionKeyNormalisation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Trim and lowercase a key; an empty result means "clear the key".
 * Refuses anything the pattern does not allow rather than quietly reshaping
 * it: a key that round-trips through two spellings is a key that misses.
 */
export function normaliseSessionKey(input: string): SessionKeyNormalisation {
  const value = input.trim().toLowerCase();
  if (value === '') return { ok: true, value: '' };
  if (value.length > SESSION_KEY_MAX_LENGTH) {
    return {
      ok: false,
      reason: `sessionKey is longer than ${SESSION_KEY_MAX_LENGTH} characters`,
    };
  }
  if (!SESSION_KEY_PATTERN.test(value)) {
    return {
      ok: false,
      reason:
        'sessionKey may contain only lowercase letters, digits, ":", "/", ".", "_" and "-", ' +
        'and must start with a letter or digit (e.g. "wren:inkwell:main")',
    };
  }
  return { ok: true, value };
}

/**
 * The `ilike` pattern for an exact, case-insensitive match on a stored key.
 *
 * Lookups must match keys the previous setter stored unnormalised (`Main`)
 * when addressed by their normalised spelling (`main`); the DB has no
 * case-insensitive equality, and `ilike` is the PostgREST operator that
 * gives one once the pattern metacharacters a key may contain (`_`, and the
 * escape itself) are escaped. `%` is not a key character, but escaping it
 * costs nothing and makes the helper safe for any string.
 */
export function sessionKeyMatchPattern(key: string): string {
  return key.replace(/[\\%_]/g, (char) => `\\${char}`);
}
