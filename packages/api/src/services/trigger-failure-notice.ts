import { logger } from '../utils/logger';

/**
 * Trigger-failure notice delivery (spec inkmail-read-state §3 alignment).
 *
 * When a trigger that FAILED was thread-borne (the payload carries
 * threadId/threadKey — true for both send_to_inbox-with-threadKey and
 * trigger_agent-with-threadKey), the notice is posted INTO that thread:
 * the thread already has participants and per-agent session stamps, so
 * delivery rides the normal stamped-only path and lands in exactly one
 * session per participant.
 *
 * Only a THREADLESS trigger (bare trigger_agent / send_to_inbox without a
 * threadKey) falls back to the legacy agent_inbox lane — which is
 * agent-scoped and therefore renders in every live session of that agent
 * (the pre-#460 broadcast semantics, retained only on this surface; see
 * spec non-goals: legacy agent_inbox unification).
 */

// Thread tables aren't fully covered by generated types at this call depth;
// accept the loose client shape the trigger handler already uses.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TriggerFailureNotice {
  /**
   * Owner of the inbox the legacy lane may write to — the sender's. Without
   * one the notice has only the thread lane.
   */
  userId?: string;
  /** Original trigger sender — the agent being notified. */
  fromSlug: string;
  /** Failed trigger target — named in content; legacy-lane attributed sender. */
  toSlug: string;
  threadId?: string | null;
  threadKey?: string | null;
  /** The thread's workspace, when known — the only way a bare key resolves. */
  workspaceId?: string | null;
  /**
   * Whether the legacy agent_inbox lane may be used. `userId` is that lane's
   * recipient owner, so a caller that cannot name the SENDER's owner must
   * say false: a person or the system holds no agent inbox, and the
   * target's owner is the wrong person (Lumen, #618). Default true.
   */
  legacyLane?: boolean;
  subject: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface NoticeResult {
  via: 'thread' | 'legacy';
  ok: boolean;
}

export async function sendTriggerFailureNotice(
  client: any,
  notice: TriggerFailureNotice
): Promise<NoticeResult> {
  const { userId, fromSlug, toSlug, threadKey, subject, content, metadata } = notice;

  // Resolve the thread: the explicit id, or the one row (workspace, key)
  // names when the caller knows the workspace. A bare key is not enough —
  // workspace-local keys repeat across workspaces on purpose (spec
  // inkmail-thread-scope §1) — so a keyed notice without a workspace takes
  // the legacy lane rather than guessing.
  let threadId = notice.threadId || null;
  if (!threadId && threadKey && notice.workspaceId) {
    const { data: thread, error: lookupErr } = await client
      .from('inbox_threads')
      .select('id')
      .eq('workspace_id', notice.workspaceId)
      .eq('thread_key', threadKey)
      .maybeSingle();
    if (lookupErr) {
      logger.warn('[TriggerFailure] Thread lookup failed — falling back to legacy inbox', {
        threadKey,
        error: lookupErr.message,
      });
    }
    threadId = thread?.id || null;
  }

  // Thread-borne failure → post into the thread. Attribution: 'system' —
  // never the failed target: a synthetic row bearing that agent's name
  // would shadow their newest REAL message in the recipient-session lookup
  // (metadata.pcp.sender.sessionId), misrouting the next reply (Lumen,
  // PR #487). The content names the failed target. messageType stays
  // 'notification' so it DELIVERS (system-TYPE events are excluded from
  // delivery and candidacy). No wake — failure-loop protection.
  if (threadId) {
    const { error: insertErr } = await client.from('inbox_thread_messages').insert({
      thread_id: threadId,
      // The system borrows nobody's identity (spec inkmail-thread-scope §3).
      sender_kind: 'system',
      sender_sb_id: null,
      sender_user_id: null,
      sender_agent_id: null,
      content,
      message_type: 'notification',
      priority: 'high',
      metadata,
    });
    if (!insertErr) {
      // Bump thread recency so pages sort sensibly; candidacy itself keys on
      // the message we just inserted. Checked, non-fatal.
      const { error: bumpErr } = await client
        .from('inbox_threads')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', threadId);
      if (bumpErr) {
        logger.warn('[TriggerFailure] Thread recency bump failed', {
          threadId,
          error: bumpErr.message,
        });
      }
      logger.info('[TriggerFailure] Posted failure notice into thread', {
        threadId,
        threadKey: threadKey || null,
        to: fromSlug,
        failedTarget: toSlug,
      });
      return { via: 'thread', ok: true };
    }
    logger.error('[TriggerFailure] Thread notice insert failed — falling back to legacy inbox', {
      threadId,
      error: insertErr.message,
    });
  }

  // Threadless (or thread write failed): legacy agent-scoped inbox — only
  // when the caller established whose inbox that is.
  if (notice.legacyLane === false || !userId) {
    logger.warn('[TriggerFailure] No legacy lane for this sender — notice not delivered', {
      threadId: threadId || null,
      threadKey: threadKey || null,
      to: fromSlug,
      failedTarget: toSlug,
    });
    return { via: 'legacy', ok: false };
  }
  const { error: legacyErr } = await client.from('agent_inbox').insert({
    recipient_user_id: userId,
    recipient_agent_id: fromSlug,
    sender_agent_id: toSlug,
    subject,
    content,
    message_type: 'notification',
    priority: 'high',
    thread_key: threadKey || null,
    metadata,
    // No trigger — avoid infinite failure loops
  });
  if (legacyErr) {
    logger.error('[TriggerFailure] Failed to send failure notification to sender', {
      sender: fromSlug,
      error: legacyErr.message,
    });
    return { via: 'legacy', ok: false };
  }
  return { via: 'legacy', ok: true };
}
