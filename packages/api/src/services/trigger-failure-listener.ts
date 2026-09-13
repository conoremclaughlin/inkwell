/**
 * What happens when a trigger fails: the legacy inbox row (if the failure
 * came from one) goes back to unread, and the sender is told — into the
 * thread the trigger belonged to, or into the sender's own inbox when there
 * is no thread.
 *
 * Lifted out of the server's `trigger:error` listener so the decision can be
 * run over a table-backed client. Lumen probed the listener twice by
 * extracting it from the server's AST (#618); a first-class function is the
 * seam that should have existed. The server registers it; nothing here
 * spawns anything.
 */

import { classifyError } from '@inklabs/shared';
import type { AgentTriggerPayload } from '../channels/agent-gateway';
import { logger } from '../utils/logger';
import { sendTriggerFailureNotice } from './trigger-failure-notice';
import { resolveFailureNoticeAddress } from './trigger-scope';

export interface TriggerFailureEvent {
  triggerId: string;
  payload: AgentTriggerPayload;
  error: unknown;
}

/** Records the failure on the activity stream under the given owner. */
export type InkmailFailureLogger = (
  payload: AgentTriggerPayload,
  userId: string,
  extra: { error: string }
) => Promise<void>;

export async function handleTriggerFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  { triggerId, payload, error }: TriggerFailureEvent,
  deps: { logInkmailFailure: InkmailFailureLogger }
): Promise<void> {
  const errorText = error instanceof Error ? error.message : String(error);
  const classification = classifyError({ errorText });

  // Log full error text — truncateSummary only keeps the first line,
  // which loses stderr content that's critical for diagnosis.
  logger.warn('[TriggerFailure] Processing failure notification', {
    triggerId,
    from: payload.fromAgentId,
    to: payload.toAgentId,
    category: classification.category,
    retryable: classification.retryable,
    inboxMessageId: payload.inboxMessageId,
    threadKey: payload.threadKey,
    errorText: errorText.slice(0, 2000),
  });

  if (!client) return;

  // 1. Restore inbox message to unread (only for agent_inbox rows — not thread messages)
  if (payload.inboxMessageId) {
    const { error: restoreErr } = await client
      .from('agent_inbox')
      .update({ status: 'unread', read_at: null })
      .eq('id', payload.inboxMessageId)
      .eq('status', 'read');

    if (restoreErr) {
      logger.warn('[TriggerFailure] Failed to restore inbox message', {
        inboxMessageId: payload.inboxMessageId,
        error: restoreErr.message,
      });
    } else {
      logger.info('[TriggerFailure] Restored inbox message to unread', {
        inboxMessageId: payload.inboxMessageId,
      });
    }
  }

  // 2. Notify sender agent (if there is one) — skip if no sender to avoid loops
  if (!payload.fromAgentId) return;

  // Where the notice belongs. The target's owner attributes the activity;
  // the SENDER's owner is whose inbox a legacy-lane notice may land in —
  // they differ in a shared workspace (Lumen, #618). A person or the
  // system holds no agent inbox: their notice has only the thread lane.
  let recipientUserId: string | undefined;
  let resolvedThreadId: string | undefined;
  let resolvedThreadWorkspaceId: string | undefined;
  let senderOwnerUserId: string | undefined;
  if (payload.inboxMessageId) {
    const { data: origMsg } = await client
      .from('agent_inbox')
      .select('recipient_user_id')
      .eq('id', payload.inboxMessageId)
      .single();
    // Legacy lane: one owner for both agents, by construction.
    recipientUserId = origMsg?.recipient_user_id;
    senderOwnerUserId = recipientUserId;
  } else if (payload.threadMessageId || payload.threadId) {
    const address = await resolveFailureNoticeAddress(client, payload);
    resolvedThreadId = address.threadId;
    resolvedThreadWorkspaceId = address.threadWorkspaceId;
    recipientUserId = address.targetOwnerUserId;
    senderOwnerUserId = address.senderOwnerUserId;
  }

  // Bare trigger_agent (no source row, possibly just a threadKey): fall
  // back to the user stamped server-side post-auth by handleTriggerAgent.
  // Row-derived resolution stays preferred; this fallback is what lets a
  // threadKey-only failure reach thread resolution at all (PR #487).
  if (!recipientUserId && payload.recipientUserId) {
    recipientUserId = payload.recipientUserId;
  }
  // A bare trigger has one owner for both agents by construction, and
  // handleTriggerAgent stamps that owner: the sender's inbox is theirs.
  if (!senderOwnerUserId && !payload.toSbId && payload.recipientUserId) {
    senderOwnerUserId = payload.recipientUserId;
  }

  if (recipientUserId) {
    await deps.logInkmailFailure(payload, recipientUserId, {
      error: errorText.slice(0, 2000),
    });
  }

  // The notice needs an address: the thread the trigger belonged to, or the
  // sender's own inbox. The target's owner only attributes the activity
  // above — a target identity that cannot be read must not silence a notice
  // whose thread and sender are known (Lumen, #618 round 2).
  if (!resolvedThreadId && !senderOwnerUserId) {
    logger.warn('[TriggerFailure] Cannot notify sender — no thread and no sender owner', {
      triggerId,
      from: payload.fromAgentId,
      to: payload.toAgentId,
      threadKey: payload.threadKey ?? null,
    });
    return;
  }

  const categoryLabel =
    classification.category !== 'unknown' ? ` (${classification.category})` : '';
  const notificationContent = `Trigger to ${payload.toAgentId} failed${categoryLabel}: ${classification.summary}`;

  // Thread-borne trigger → notice joins the thread (participants and
  // session stamps already exist; stamped-only delivery lands it in
  // exactly one session per participant). Threadless → legacy inbox.
  const noticeResult = await sendTriggerFailureNotice(client, {
    // The legacy lane's recipient owner is the SENDER's; without one
    // the notice has only the thread lane.
    userId: senderOwnerUserId,
    legacyLane: !!senderOwnerUserId,
    fromAgentId: payload.fromAgentId,
    toAgentId: payload.toAgentId,
    threadId: resolvedThreadId,
    threadKey: payload.threadKey,
    workspaceId: resolvedThreadWorkspaceId ?? null,
    subject: `Trigger failed: ${payload.toAgentId}`,
    content: notificationContent,
    metadata: {
      triggerFailure: true,
      triggerId,
      errorCategory: classification.category,
      errorSummary: classification.summary,
      errorDetail: errorText.slice(0, 4000),
      retryable: classification.retryable,
      originalInboxMessageId: payload.inboxMessageId || null,
    },
  });
  if (noticeResult.ok) {
    logger.info('[TriggerFailure] Sent failure notification to sender', {
      sender: payload.fromAgentId,
      category: classification.category,
      via: noticeResult.via,
    });
  }
}
