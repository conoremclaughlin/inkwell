import { parseThreadKey } from './parser';

/**
 * Catch a project prefix that has been pinned as a type.
 *
 * AGENTS.md tells agents to prefix any cross-project thread key —
 * `inktrade:pr:42`, `cnr:issue:7`. Both parsers, TS and SQL, accept a first
 * segment as a project ONLY when it is a registered slug or alias. When it is
 * not registered, `cnr:issue:7` does not fail; it pins as type=`cnr`,
 * id=`issue:7`, and behaves as an unknown type from then on.
 *
 * Two things make that worth interrupting for:
 *
 *  - It is silent. Following the convention correctly produces a wrong
 *    identity and nothing anywhere says so.
 *  - It is permanent. `pin_thread_key_before_insert` stamps
 *    key_project/key_type/key_id at creation and they are immutable after, so
 *    registering the project later does NOT repair threads already created.
 *
 * The pin itself comes from `parseThreadKey`, never from a second set of rules
 * here. An earlier revision re-split the key inline and immediately drifted:
 * it called `cnr:issue:` malformed, while the real parser (and SQL) pin it as
 * type=`cnr`, id=`issue:`. This layer decides only whether an unprefixed parse
 * looks *unintended*; what the key became is the parser's answer.
 */

/**
 * Cheap structural precheck: could this key possibly warn?
 *
 * A key with fewer than three segments has no room for a project prefix, so
 * the answer is already no before any registry is consulted. `pr:545` is the
 * commonest new-thread shape there is, and reading the project and type
 * registries to conclude nothing would be a database round-trip on every
 * first send.
 *
 * Lives beside the detector so the segment rule stays in one place rather than
 * being restated by each caller that wants to skip the lookup.
 */
export function mayHaveProjectPrefix(key: string): boolean {
  if (!key) return false;
  return key.split(':').length >= 3;
}

export interface UnregisteredProjectPrefix {
  /** The first segment, which looks intended as a project. */
  suspectedProject: string;
  /** What the key is actually pinned as — straight from the parser. */
  pinnedAsType: string;
  pinnedAsId: string;
}

/**
 * Returns a description of the misparse, or null when the key is fine or
 * merely unusual.
 *
 * The positive signal is deliberately narrow, because a warning that fires on
 * ordinary keys stops being read:
 *
 *   1. the key parses, and parsed WITHOUT a project;
 *   2. the first segment is not itself a known type — `thread:perf:audit` is
 *      a typed key whose id contains a colon, not a prefix;
 *   3. the SECOND segment IS a known type — this is the evidence that a
 *      prefix was intended. Unknown types are legal and their ids may contain
 *      colons, so `incident:2026:08:25` and `custom:compound:id` are ordinary
 *      keys, not mistakes.
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
  const parsed = parseThreadKey(key, slugLookup);

  // Not a thread key at all, or a registered project that parsed as intended.
  if (!parsed) return null;
  if (parsed.project !== null) return null;

  const segments = key.split(':');
  if (segments.length < 3) return null;

  const [first, second] = segments;

  // A known type in front is the ordinary shape of an unprefixed key.
  if (knownTypes.has(first)) return null;

  // Without a known type in second position there is nothing to suggest the
  // first segment was meant as a project rather than as the type it became.
  if (!knownTypes.has(second)) return null;

  return {
    suspectedProject: first,
    pinnedAsType: parsed.type,
    pinnedAsId: parsed.id,
  };
}

/**
 * Sentence for the caller. Kept next to the detector so the wording and the
 * condition cannot drift apart.
 *
 * Written in the present tense and about an accomplished fact: by the time
 * anything reads this, the thread exists and the pin is set. Telling the
 * sender to "register before sending" would be advice they can no longer take,
 * so it names the only recovery that works — register the slug, then use a
 * different key, because re-sending this one reuses the pin that already
 * exists.
 */
export function describeUnregisteredProjectPrefix(
  key: string,
  found: UnregisteredProjectPrefix
): string {
  return (
    `"${key}" is pinned as type "${found.pinnedAsType}" with id "${found.pinnedAsId}", ` +
    `not as a project-scoped key, because "${found.suspectedProject}" is not a registered ` +
    `project. Thread identity is set when the thread is created and cannot be changed ` +
    `afterwards — registering the project now will not re-scope this thread. To scope ` +
    `future work to it: register the slug (save_project with slug "${found.suspectedProject}", ` +
    `or add it as a slug alias), then start a NEW thread key. Re-sending "${key}" reuses ` +
    `this existing pin.`
  );
}
