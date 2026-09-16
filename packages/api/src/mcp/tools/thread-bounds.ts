/**
 * Brevity bounds for a thread's title and summary, and the one place that
 * applies them to a title derived from something else.
 *
 * Its own module rather than a corner of thread-handlers.ts because
 * findOrCreateThread (inbox-handlers.ts) is a writer of `inbox_threads.title`
 * and needs the bound, while thread-handlers.ts pulls in the studio lease and
 * overflow services. A constraint that every writer must honour should not cost
 * an import of half the tool layer to reach.
 */

/**
 * Mirrored from the CHECK constraints on inbox_threads (migration
 * 20260915210656). Kept in both places deliberately: the schema gives a caller
 * a usable error, the constraint is what actually holds — including for writers
 * that never pass through the tool.
 */
export const THREAD_TITLE_MAX = 200;
export const THREAD_SUMMARY_MAX = 280;

/**
 * Derive a thread title that fits the column, from a subject that need not.
 *
 * `send_to_inbox.subject` is an unbounded string and findOrCreateThread copies
 * it straight into `inbox_threads.title`. Adding the CHECK without adapting
 * that writer meant a previously valid first message with a 201-character
 * subject failed at `inbox_threads_title_length` before the message was saved —
 * a message lost to a bound on its thread's label, while the same subject on an
 * existing thread went through fine (Lumen, #641 review).
 *
 * So creation truncates rather than refuses. The full subject is still stored
 * on the message row; it is only the thread's label that is bounded, which is
 * what the bound was for. The ellipsis is part of the budget, so the result is
 * never longer than the column allows.
 *
 * Counts code points, not UTF-16 units, because that is what Postgres's
 * char_length counts — measuring in the wrong unit would truncate a subject of
 * 150 emoji that the constraint would have accepted whole.
 */
export function boundThreadTitle(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const chars = [...subject];
  if (chars.length <= THREAD_TITLE_MAX) return subject;
  return `${chars.slice(0, THREAD_TITLE_MAX - 1).join('')}…`;
}
