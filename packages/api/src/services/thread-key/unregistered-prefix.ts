/**
 * Catch a project prefix that is about to be pinned as a type.
 *
 * AGENTS.md tells agents to prefix any cross-project thread key —
 * `inktrade:pr:42`, `cnr:issue:7`. Both parsers, TS and SQL, accept a first
 * segment as a project ONLY when it is a registered slug or alias. When it is
 * not registered, `cnr:issue:7` does not fail; it pins as
 * type=`cnr`, id=`issue:7`, which routes and behaves as an unknown type.
 *
 * Two things make that worth interrupting for:
 *
 *  - It is silent. Following the convention correctly produces a wrong
 *    identity and nothing anywhere says so.
 *  - It is permanent. `pin_thread_key_before_insert` stamps
 *    key_project/key_type/key_id at creation and they are immutable after, so
 *    registering the project later does NOT repair threads already created.
 *    The only moment this is cheap to fix is before the first send.
 *
 * The signal has to be narrow or it is noise. A first segment is only
 * suspicious when it is neither a registered project NOR a known thread-key
 * type — `thread:perf:audit` is three segments with a legitimate type in
 * front, and must stay quiet.
 */

export interface UnregisteredProjectPrefix {
  /** The first segment, which looks intended as a project. */
  suspectedProject: string;
  /** What the key will actually be pinned as if this send proceeds. */
  pinnedAsType: string;
  pinnedAsId: string;
}

/**
 * Returns a description of the misparse a key is heading for, or null when the
 * key is fine — registered project, known type, or too few segments to be
 * ambiguous at all.
 *
 * `knownTypes` should be the effective thread-key types for the user;
 * `slugLookup` the accepted project prefixes (canonical slugs and aliases),
 * as built by ThreadKeyService.projectSlugLookup.
 */
export function detectUnregisteredProjectPrefix(
  key: string,
  slugLookup: ReadonlyMap<string, string>,
  knownTypes: ReadonlySet<string>
): UnregisteredProjectPrefix | null {
  if (!key) return null;

  const segments = key.split(':');
  // Fewer than three segments cannot carry a project prefix, so there is no
  // ambiguity to warn about.
  if (segments.length < 3) return null;
  if (segments[0] === '' || segments[1] === '' || segments[2] === '') return null;

  const first = segments[0];

  // Registered project (or alias) — this key parses exactly as intended.
  if (slugLookup.has(first)) return null;

  // A known type in front is the ordinary shape of an unprefixed key whose id
  // happens to contain a colon. Not a project prefix.
  if (knownTypes.has(first)) return null;

  return {
    suspectedProject: first,
    pinnedAsType: first,
    pinnedAsId: segments.slice(1).join(':'),
  };
}

/**
 * Operator-facing sentence for the detection. Kept next to the detector so the
 * wording and the condition cannot drift apart.
 */
export function describeUnregisteredProjectPrefix(
  key: string,
  found: UnregisteredProjectPrefix
): string {
  return (
    `"${found.suspectedProject}" is not a registered project, so ${key} will be recorded ` +
    `as type "${found.pinnedAsType}" with id "${found.pinnedAsId}" rather than as a ` +
    `project-scoped key. Thread identity is pinned at creation and cannot be changed ` +
    `afterwards. If "${found.suspectedProject}" is meant to be a project, register it ` +
    `(save_project with that slug, or add it as a slug alias) before sending, or drop ` +
    `the prefix.`
  );
}
