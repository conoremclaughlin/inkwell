/**
 * Thread-drain core for the InkMail channel plugin.
 *
 * Extracted from index.ts so the delivery behavior is unit-testable
 * (Lumen, PR #473: uneven batches, fetch failures, multi-poll summary
 * accumulation, paginated unread threads).
 *
 * Delivery contract (spec inkmail-read-state §1/§7 v11):
 * - EVERY fetch is markRead:false — fetch never consumes. After injection
 *   the plugin ACKS the exact last delivered/skipped message id
 *   (mark_thread_read throughMessageId). In-memory cursors advance ONLY on
 *   ack success; a failed ack leaves them untouched so the next poll
 *   re-fetches, dedups by seen-set, and RETRIES the ack. A crash between
 *   fetch and injection loses nothing; a restart redelivers a window
 *   bounded by the server-side guard.
 * - KNOWN LIMIT (spec step 3, deferred): mcp.notification resolving proves
 *   ENQUEUE into the host, not render into context. The renderer receipt
 *   (exact messageId + sessionId + method) requires host/hook cooperation
 *   and is the delivery-receipts implementation step, not this one.
 * - BUDGET: at most POLL_BUDGET injections per poll, ALWAYS active — a
 *   permanent backpressure with no disarm flag to get wrong. Each request's
 *   limit is bounded by the remaining budget so the ceiling cannot overshoot.
 * - SUMMARY: one line per process, emitted only when a poll completes with
 *   no ceiling hit, no failures, and no truncated thread page — i.e. when
 *   the backlog is provably drained — reporting skips accumulated across
 *   every poll since process start.
 */

export interface PollDeps {
  callPcp(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Emit a channel notification; MUST reject on emit failure. */
  notify(content: string, meta: Record<string, unknown>): Promise<void>;
  log(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: Record<string, unknown>
  ): void;
  agentId: string;
  email?: string;
  studioId?: string;
}

export interface ThreadDrainState {
  lastThreadMessageId: Map<string, string>;
  lastThreadTimestamps: Map<string, string>;
  seenMessageIds: Set<string>;
  /**
   * Cold-start skip accounting: LATEST server-reported skip per thread
   * (replace, never add — a cold retry of the same thread re-reports the
   * same range and must not double-count).
   */
  skippedByThread: Map<string, number>;
  summarySent: boolean;
}

export function createThreadDrainState(): ThreadDrainState {
  return {
    lastThreadMessageId: new Map(),
    lastThreadTimestamps: new Map(),
    seenMessageIds: new Set(),
    skippedByThread: new Map(),
    summarySent: false,
  };
}

/** Aggregate injections per poll — always active, never disarmed. */
export const POLL_BUDGET = 100;
/** Per-thread fetch ceiling (also the server-side guard truncation limit). */
export const PER_THREAD_LIMIT = 50;

export interface DrainOptions {
  /**
   * True when get_inbox reported unreadThreadsTruncated — more participant
   * threads exist beyond the returned page, so a quiet page is NOT proof
   * the backlog is drained (suppresses the summary this poll).
   */
  moreThreadsPending?: boolean;
  /**
   * True when get_inbox reported channelPollIncomplete — the server's
   * candidacy query failed and the thread list is partial. An empty page
   * under this flag is an OUTAGE, never drain proof.
   */
  pollIncomplete?: boolean;
}

export interface DrainResult {
  injected: number;
  ceilingHit: boolean;
  fetchFailures: number;
  emitFailures: number;
  ackFailures: number;
  skippedThisPoll: number;
}

/** Should this message be delivered, or silently consumed (self/seen/stale)? */
function shouldDeliver(
  deps: PollDeps,
  state: ThreadDrainState,
  msg: Record<string, unknown>,
  lastKnownTs: string | undefined
): boolean {
  const msgId = msg.id as string;
  const msgTs = msg.createdAt as string;
  // Skip own messages UNLESS they came from a different studio
  // (cross-studio self-message).
  if (msg.senderAgentId === deps.agentId) {
    if (!deps.studioId) return false;
    const msgPcp = (msg.metadata as Record<string, unknown>)?.pcp as
      | Record<string, unknown>
      | undefined;
    const msgSender = msgPcp?.sender as Record<string, unknown> | undefined;
    const msgStudioId = msgSender?.studioId as string | undefined;
    if (!msgStudioId || msgStudioId === deps.studioId) return false;
  }
  if (msgId && state.seenMessageIds.has(msgId)) return false;
  if (lastKnownTs && msgTs && msgTs <= lastKnownTs) return false;
  return true;
}

export async function drainThreads(
  deps: PollDeps,
  state: ThreadDrainState,
  threads: Array<Record<string, unknown>>,
  opts: DrainOptions = {}
): Promise<DrainResult> {
  let remaining = POLL_BUDGET;
  let injected = 0;
  let ceilingHit = false;
  let fetchFailures = 0;
  let emitFailures = 0;
  let ackFailures = 0;
  let skippedThisPoll = 0;
  // A batch that fills its requested limit means the thread may hold more —
  // not drain proof, even without a ceiling hit.
  let sawFullBatch = false;

  for (const thread of threads) {
    const threadKey = thread.threadKey as string;
    const unreadCount = (thread.unreadCount as number) || 0;
    if (!threadKey || unreadCount === 0) continue;

    if (remaining <= 0) {
      ceilingHit = true;
      deps.log('warn', 'Poll budget exhausted — deferring remaining threads to next poll', {
        deferredThread: threadKey,
        injected,
      });
      break;
    }

    const afterMessageId = state.lastThreadMessageId.get(threadKey);
    const requestedLimit = Math.min(PER_THREAD_LIMIT, remaining);
    const threadResult = await deps.callPcp('get_thread_messages', {
      ...(deps.email ? { email: deps.email } : {}),
      agentId: deps.agentId,
      threadKey,
      // Fetch NEVER consumes (§7): the exact-id ack below is the only
      // consumption, for cold and cursored fetches alike.
      markRead: false,
      // System events are not channel-deliverable and never advance the
      // pointer — candidacy (get_unread_thread_candidates) excludes them,
      // and so must the delivery fetch, or ack ranges and candidacy drift.
      includeSystemEvents: false,
      channelPoll: true,
      // Budget-bounded request: the aggregate ceiling can never overshoot.
      limit: requestedLimit,
      ...(afterMessageId ? { afterMessageId } : {}),
    });

    if (!threadResult?.success) {
      fetchFailures += 1;
      deps.log('error', 'Thread fetch failed — will retry next poll', { threadKey });
      continue;
    }

    const skippedOlder = (threadResult.skippedOlderCount as number) || 0;
    if (skippedOlder > 0) {
      // Replace, never add: a cold RETRY of the same thread re-reports the
      // same skipped range and must not inflate the summary.
      state.skippedByThread.set(threadKey, skippedOlder);
      skippedThisPoll += skippedOlder;
      deps.log('info', 'Cold-start guard skipped older messages', { threadKey, skippedOlder });
    }

    const messages = (threadResult.messages as Array<Record<string, unknown>>) || [];
    if (messages.length >= requestedLimit) sawFullBatch = true;
    const lastKnownTs = state.lastThreadTimestamps.get(threadKey);

    // Walk the batch. Client-filtered messages (self/seen/stale) count as
    // deliberately skipped and stay inside the ack range; only an emit
    // FAILURE stops the range, leaving the remainder unread for redelivery.
    let lastProcessedId: string | null = null;
    let lastProcessedTs: string | null = null;
    for (const msg of messages) {
      const msgId = (msg.id as string) || '';
      const msgTs = (msg.createdAt as string) || '';

      if (!shouldDeliver(deps, state, msg, lastKnownTs)) {
        if (msgId) lastProcessedId = msgId;
        if (msgTs) lastProcessedTs = msgTs;
        continue;
      }

      const sender = (msg.senderAgentId as string) || 'unknown';
      const content = (msg.content as string) || '';
      const messageType = (msg.messageType as string) || 'message';
      try {
        await deps.notify(`From ${sender}: ${content}`, {
          thread_key: threadKey,
          sender,
          message_type: messageType,
          message_id: msgId,
        });
      } catch (err) {
        emitFailures += 1;
        deps.log('error', 'Channel emit failed — leaving remainder unread for redelivery', {
          threadKey,
          msgId,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (msgId) {
        state.seenMessageIds.add(msgId);
        lastProcessedId = msgId;
      }
      if (msgTs) lastProcessedTs = msgTs;
      injected += 1;
      remaining -= 1;
      deps.log('info', 'Pushed thread message to channel', { threadKey, sender, msgId, msgTs });
    }

    // Exact-id ack (spec §1) on EVERY fetch that processed messages: the
    // ack is the only consumption. In-memory cursors advance ONLY on ack
    // success — a failed ack leaves them untouched, so the next poll
    // re-fetches the same window, dedups by seen-set (no duplicate render),
    // and RETRIES the ack. Failed acks count against drain proof.
    if (lastProcessedId) {
      const ack = await deps.callPcp('mark_thread_read', {
        ...(deps.email ? { email: deps.email } : {}),
        agentId: deps.agentId,
        threadKey,
        throughMessageId: lastProcessedId,
      });
      if (ack?.success) {
        state.lastThreadMessageId.set(threadKey, lastProcessedId);
        if (lastProcessedTs) state.lastThreadTimestamps.set(threadKey, lastProcessedTs);
      } else {
        ackFailures += 1;
        deps.log('error', 'Ack failed — cursors held, will re-fetch and retry ack next poll', {
          threadKey,
          throughMessageId: lastProcessedId,
        });
      }
    }
  }

  // One summary per process, only at provable drain: no ceiling, no
  // failures, no truncated thread page. Accumulated across all polls so a
  // multi-poll drain reports every skip (nothing omitted).
  const skippedTotal = [...state.skippedByThread.values()].reduce((a, b) => a + b, 0);
  if (
    !state.summarySent &&
    skippedTotal > 0 &&
    !ceilingHit &&
    !sawFullBatch &&
    fetchFailures === 0 &&
    emitFailures === 0 &&
    ackFailures === 0 &&
    !opts.moreThreadsPending &&
    !opts.pollIncomplete
  ) {
    state.summarySent = true;
    await deps
      .notify(
        `InkMail cold-start guard: ${skippedTotal} older unread message(s) across ` +
          `${state.skippedByThread.size} thread(s) were skipped (outside the recent delivery window). ` +
          `They remain in-thread — use get_thread_messages with fullHistory to view.`,
        { sender: 'inkmail', message_type: 'notification' }
      )
      .catch(() => {
        // Summary is best-effort; never fail the poll over it.
        state.summarySent = false;
      });
  }

  return { injected, ceilingHit, fetchFailures, emitFailures, ackFailures, skippedThisPoll };
}
