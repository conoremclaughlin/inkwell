/**
 * Queued wakes that run as one turn (spec trigger-pipe-in v7, slice 1).
 *
 * While a session's turn runs, every message for it queues. A wake only
 * points at a stored message, so a contiguous run of them can share the next
 * turn instead of each paying for its own `--resume`. These are the pure
 * rules; SessionService.runWakeBatch applies them under the session's lock.
 */

import type { SessionRequest } from './types.js';

/** At most this many queued wakes share one turn (1.2). */
export const MAX_COALESCED_WAKES = 10;

/** What these rules read of a queued entry. */
export interface QueuedWake {
  request: SessionRequest;
  /**
   * Set when a batch found this wake's merge in doubt (an inkling or an
   * unreadable identity, or a check that failed), so the next dequeue runs
   * it alone instead of trying to batch it again.
   */
  noMerge?: boolean;
}

/**
 * The stored message a queued wake points at, when it may share a turn
 * (1.1). The trigger handler marks the wakes only it can judge. Anything that
 * changes how the turn launches stays out, because one turn has one launch:
 * media, a task group (its permission overlay) and a sandbox container.
 */
export function coalescibleWakeSource(pending: QueuedWake): string | undefined {
  const metadata = pending.request.metadata;
  if (pending.noMerge || metadata?.wakeCoalescible !== true) return undefined;
  if (metadata.media?.length || metadata.taskGroupId || metadata.sandboxContainerName) {
    return undefined;
  }
  return metadata.triggerThreadMessageId ?? metadata.triggerInboxMessageId;
}

/**
 * Take the contiguous run of coalescible wakes at the head of a queue, when
 * there are at least two (1.2). The first entry that is not one ends the run,
 * so a channel message queued between two wakes keeps its place between them.
 */
export function takeWakeBatch<T extends QueuedWake>(queue: T[]): T[] | undefined {
  let count = 0;
  while (
    count < queue.length &&
    count < MAX_COALESCED_WAKES &&
    coalescibleWakeSource(queue[count]) !== undefined
  ) {
    count += 1;
  }
  return count >= 2 ? queue.splice(0, count) : undefined;
}

/** The prompt of a turn that carries several wakes, each in the order it arrived (1.4). */
export function mergedWakeContent(contents: string[]): string {
  return [
    `[${contents.length} messages arrived for you while your previous turn ran. Each one's wake is below, in the order they arrived.]`,
    ...contents.map((content, i) => `── Wake ${i + 1} of ${contents.length} ──\n${content}`),
  ].join('\n\n');
}

/**
 * The epoch a merged turn runs under (1.4): the latest member, in queue
 * order, whose candidate the session's lease carries, so that the run
 * boundary's release compares against a stamp this turn owns. Routing on a
 * presence thread stamps nothing, so the last member is not always that one.
 * With none of them stamped, the lead's, as it would be for a lone turn.
 */
export function batchTurnEpoch(candidates: string[], stamped: ReadonlySet<string>): string {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (stamped.has(candidates[i])) return candidates[i];
  }
  return candidates[0];
}
