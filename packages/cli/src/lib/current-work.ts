/**
 * Format the current-work line the server already rendered.
 *
 * The server decides WHAT a session says it is working on — headline, or a
 * truncated context block for a caller entitled to see it — and hands back
 * `currentWork` plus an age. This module only decides how that reads in a
 * terminal, so there is no second copy of the fallback rule here to drift.
 *
 * The age is not optional decoration. A description without one is read as
 * current however old it is: a context block written on 11 Sep, describing
 * round five of a PR, was read on 15 Sep as a live claim about the same PR at
 * round eight. That is the failure this whole field exists to prevent, and a
 * plain-text block is where it is most likely to recur — a dashboard can at
 * least show a label and a layout, while `- 3f2a1b09 (wren) reviewing #652`
 * looks exactly as authoritative whether it is three minutes or three days old.
 *
 * Hence UNKNOWN_AGE. When the server sends no age — rows predating the
 * timestamp columns have none — the renderer says so out loud rather than
 * printing the text bare. Silence here would be indistinguishable from fresh,
 * which is the one reading that must never happen.
 */

/** Shown when the server reports no age. Never render unknown as recent. */
export const UNKNOWN_AGE = 'age unknown';

/** The current-work fields bootstrap and list_sessions put on a session. */
export interface CurrentWorkFields {
  currentWork?: unknown;
  currentWorkAgeLabel?: unknown;
}

/**
 * "reviewing PR #652 (3h ago)", or null when the session has said nothing.
 *
 * Returns null only for genuinely absent text. A session that HAS said
 * something always renders with an age, real or explicitly unknown.
 */
export function formatCurrentWork(session: CurrentWorkFields): string | null {
  const work = typeof session.currentWork === 'string' ? session.currentWork.trim() : '';
  if (!work) return null;

  const age =
    typeof session.currentWorkAgeLabel === 'string' && session.currentWorkAgeLabel.trim()
      ? session.currentWorkAgeLabel.trim()
      : UNKNOWN_AGE;

  return `${work} (${age})`;
}
