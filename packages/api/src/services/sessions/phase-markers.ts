/**
 * Is a session's phase/status string a statement that it is FINISHED?
 *
 * Pure, dependency-free, and deliberately its own module: the predicate is
 * needed both by the MCP session handlers (which decide whether reopening may
 * clear `ended_at`) and by the thread-spine merge (which decides whether to
 * advertise a session as live). Importing a 2000-line tool module into a pure
 * merge to get one string test would be the wrong direction, and copying the
 * test into the merge is how the fleet ends up with several definitions of
 * "finished" that disagree.
 *
 * It already had two homes when this was extracted — memory-handlers'
 * isTerminalPhaseMarker and the CLI's isAttachableSessionSummary — and a
 * third, weaker copy (`phase === 'complete'`, exact match only) had just been
 * written into thread-spines. That copy missed `completed`, missed
 * `complete:<reason>`, and missed any difference in case or whitespace, which
 * is precisely the drift this module exists to stop.
 */

/**
 * Accepts `complete` / `completed`, bare or with a `:<reason>` suffix, after
 * trimming and lowercasing. `completeness` and `completion-review` are NOT
 * terminal — the colon is what separates a marker from a word that merely
 * starts the same way.
 */
export function isTerminalPhaseMarker(value: string | null | undefined): boolean {
  const marker = (value || '').trim().toLowerCase();
  if (!marker) return false;
  return (
    marker === 'complete' ||
    marker.startsWith('complete:') ||
    marker === 'completed' ||
    marker.startsWith('completed:')
  );
}
