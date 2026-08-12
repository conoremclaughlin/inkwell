/**
 * Thread-drain core for the InkMail channel plugin.
 *
 * Extracted from index.ts so the delivery behavior is unit-testable
 * (Lumen, PR #473: uneven batches, fetch failures, multi-poll summary
 * accumulation, paginated unread threads).
 *
 * Delivery contract (spec inkmail-read-state §1/§4):
 * - COLD FETCH (no in-memory cursor): fetched with markRead:false so
 *   fetched-but-unrendered messages stay unread; after injection the plugin
 *   ACKS the exact last delivered/skipped message id (mark_thread_read
 *   throughMessageId). A crash between fetch and injection loses nothing;
 *   a restart redelivers a window bounded by the server-side guard.
 * - CURSORED FETCH (incremental): keeps the pre-existing fetch-time advance
 *   (markRead:true) until the full ack protocol lands.
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
  /** Cold-start skip accounting, accumulated across polls until the summary. */
  skippedTotal: number;
  skippedThreads: Set<string>;
  summarySent: boolean;
}

export function createThreadDrainState(): ThreadDrainState {
  return {
    lastThreadMessageId: new Map(),
    lastThreadTimestamps: new Map(),
    seenMessageIds: new Set(),
    skippedTotal: 0,
    skippedThreads: new Set(),
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
}

export interface DrainResult {
  injected: number;
  ceilingHit: boolean;
  fetchFailures: number;
  emitFailures: number;
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
    const coldFetch = !afterMessageId;
    const requestedLimit = Math.min(PER_THREAD_LIMIT, remaining);
    const threadResult = await deps.callPcp('get_thread_messages', {
      ...(deps.email ? { email: deps.email } : {}),
      agentId: deps.agentId,
      threadKey,
      // Cold fetch: markRead:false — the exact-id ack below is the only
      // consumption. Cursored incremental fetch: pre-existing fetch-time
      // advance (until the full ack protocol lands).
      markRead: !coldFetch,
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
      state.skippedTotal += skippedOlder;
      state.skippedThreads.add(threadKey);
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

    // In-memory cursors advance to the last processed message so polls in
    // this process don't re-render; after an emit failure they stop at the
    // last success, so the remainder redelivers.
    if (lastProcessedId) state.lastThreadMessageId.set(threadKey, lastProcessedId);
    if (lastProcessedTs) state.lastThreadTimestamps.set(threadKey, lastProcessedTs);

    // Cold-fetch ack (spec §1): acknowledge exactly what was delivered or
    // deliberately skipped. On ack failure the server-side unread persists —
    // the in-memory cursor prevents duplicates this process; a restart
    // redelivers a guard-bounded window (at-least-once, never silent loss).
    if (coldFetch && lastProcessedId) {
      const ack = await deps.callPcp('mark_thread_read', {
        ...(deps.email ? { email: deps.email } : {}),
        agentId: deps.agentId,
        threadKey,
        throughMessageId: lastProcessedId,
      });
      if (!ack?.success) {
        deps.log('error', 'Cold-fetch ack failed — server unread persists', {
          threadKey,
          throughMessageId: lastProcessedId,
        });
      }
    }
  }

  // One summary per process, only at provable drain: no ceiling, no
  // failures, no truncated thread page. Accumulated across all polls so a
  // multi-poll drain reports every skip (nothing omitted).
  if (
    !state.summarySent &&
    state.skippedTotal > 0 &&
    !ceilingHit &&
    !sawFullBatch &&
    fetchFailures === 0 &&
    emitFailures === 0 &&
    !opts.moreThreadsPending
  ) {
    state.summarySent = true;
    await deps
      .notify(
        `InkMail cold-start guard: ${state.skippedTotal} older unread message(s) across ` +
          `${state.skippedThreads.size} thread(s) were skipped (outside the recent delivery window). ` +
          `They remain in-thread — use get_thread_messages with fullHistory to view.`,
        { sender: 'inkmail', message_type: 'notification' }
      )
      .catch(() => {
        // Summary is best-effort; never fail the poll over it.
        state.summarySent = false;
      });
  }

  return { injected, ceilingHit, fetchFailures, emitFailures, skippedThisPoll };
}
