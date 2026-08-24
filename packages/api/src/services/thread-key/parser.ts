/**
 * Thread-key parser — spec: ink://specs/thread-key-grammar v2.
 *
 * ONE parser for four consumers: the route matcher, workflow typing, the
 * collision guard, and lease acquisition. Two parsers is how `pr:*` and
 * `inkread:pr:42` diverged in the first place (grammar invariant 3).
 *
 *   key := [ project ":" ] type ":" id
 *
 * Parse is REGISTRY-DRIVEN, never positional: the first segment is a project
 * only when it matches a registered projects.slug OR a project slug alias for
 * the resolved user, AND at least two segments follow. Role is never inferred
 * from colon position alone (grammar §Parse procedure rule 3).
 *
 * The lookup maps every ACCEPTED first segment to the canonical slug it pins:
 * canonical slugs map to themselves, slug aliases (project_slug_aliases) map
 * to their project's canonical slug. `project` in the result is therefore
 * always CANONICAL — exactly what SQL compute_thread_key_pin pins — and the
 * integration parity test holds the two implementations together.
 */

export interface ParsedThreadKey {
  /** Canonical project slug (aliases resolve to it), or null when unprefixed. */
  project: string | null;
  /** First non-project segment. May be unregistered — that is legal. */
  type: string;
  /** Everything after the type separator. Colons permitted. */
  id: string;
  /** The key exactly as stored — the server never rewrites keys (invariant 1). */
  raw: string;
}

/**
 * Parse a thread key against the caller's accepted project prefixes
 * (canonical slugs and aliases, each mapped to the canonical slug — build
 * with ThreadKeyService.projectSlugLookup).
 *
 * Returns null for strings that are not thread keys at all (no colon, empty
 * segments around the first separator). A null is "untyped", not an error —
 * unkeyed sends are legal and simply carry no registry behavior.
 */
export function parseThreadKey(
  key: string,
  slugLookup: ReadonlyMap<string, string>
): ParsedThreadKey | null {
  if (!key) return null;
  const segments = key.split(':');
  if (segments.length < 2) return null;

  // A key needs a non-empty type and a non-empty id ("pr:" and ":42" are not
  // keys). Later segments may be empty only as part of a composite id.
  if (segments[0] === '' || segments[1] === '') return null;

  const canonical = segments.length >= 3 ? slugLookup.get(segments[0]) : undefined;
  if (canonical !== undefined) {
    if (segments[2] === '') return null;
    return {
      project: canonical,
      type: segments[1],
      id: segments.slice(2).join(':'),
      raw: key,
    };
  }

  return {
    project: null,
    type: segments[0],
    id: segments.slice(1).join(':'),
    raw: key,
  };
}
