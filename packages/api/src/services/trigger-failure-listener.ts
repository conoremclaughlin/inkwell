/**
 * What happens when a trigger fails: the legacy inbox row (if the failure
 * came from one) goes back to unread, a transient failure is re-queued with a
 * delay, and the sender is told — into the thread the trigger belonged to, or
 * into the sender's own inbox when there is no thread.
 *
 * Lifted out of the server's `trigger:error` listener so the decision can be
 * run over a table-backed client. Lumen probed the listener twice by
 * extracting it from the server's AST (#618); a first-class function is the
 * seam that should have existed. The server registers it and hands in the
 * retry scheduler and the activity stream; nothing here spawns anything.
 *
 * The retry decision (#432, Lumen r1–r3) lives here too, in the order the
 * server made it: restore the inbox row first, resolve the owner before the
 * sender check because a senderless trigger still schedules a retry and its
 * activity entry needs the user, then decide, then notify.
 */

import { classifyError } from '@inklabs/shared';
import type { AgentTriggerPayload } from '../channels/agent-gateway';
import {
  TRIGGER_MAX_ATTEMPTS,
  carriedClassification,
  getTriggerAttempt,
  type TriggerRetryScheduler,
} from '../channels/trigger-retry';
import type { LogActivityInput } from '../data/repositories/activity-stream.repository';
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

export interface TriggerFailureDeps {
  logInkmailFailure: InkmailFailureLogger;
  /**
   * Delayed re-queue for transiently failed triggers. Absent, every failure
   * is final — the shape the table-backed probes run.
   */
  retryScheduler?: Pick<TriggerRetryScheduler, 'scheduleRetry'>;
  /** Records a scheduled retry on the activity stream under the target's owner. */
  logRetryActivity?: (entry: LogActivityInput) => Promise<unknown>;
}

export async function handleTriggerFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  { triggerId, payload, error }: TriggerFailureEvent,
  deps: TriggerFailureDeps
): Promise<void> {
  const errorText = error instanceof Error ? error.message : String(error);
  // Prefer the verdict the error is carrying. `errorText` here is whatever
  // the throw site had — for a runner failure that is a bounded excerpt,
  // and classifying it re-decides retryability from a display-shaped cut
  // of the output. A throw with nothing carried (spawn failure, internal
  // error, routing refusal) still classifies its text, as it always has.
  const classification = carriedClassification(error) ?? classifyError({ errorText });
  const attempt = getTriggerAttempt(payload);

  // Log full error text — truncateSummary only keeps the first line,
  // which loses stderr content that's critical for diagnosis.
  logger.warn('[TriggerFailure] Processing trigger failure', {
    triggerId,
    from: payload.fromSlug,
    to: payload.toSlug,
    category: classification.category,
    retryable: classification.retryable,
    attempt,
    inboxMessageId: payload.inboxMessageId,
    threadKey: payload.threadKey,
    errorText: errorText.slice(0, 2000),
  });

  if (!client) return;

  // 1. Restore inbox message to unread FIRST — before the retry decision,
  // and before the sender check, because a crash mid-backoff must leave
  // the message visible to heartbeat scans. A successful re-dispatch marks
  // it read again. (only for agent_inbox rows — not thread messages)
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

  // 2. Where the notice belongs. The target's owner attributes the activity;
  // the SENDER's owner is whose inbox a legacy-lane notice may land in —
  // they differ in a shared workspace (Lumen, #618). A person or the
  // system holds no agent inbox: their notice has only the thread lane.
  // This runs before the sender check because a retry is scheduled for a
  // senderless trigger too, and its activity entry needs the user.
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

  // 3. Transient failure → schedule a delayed retry instead of notifying.
  // Guard: never retry if the spawn already produced a successful session
  // turn (triggerTurnCompleted is set post-success in the default handler).
  const turnCompleted = payload.metadata?.triggerTurnCompleted === true;
  let pendingRetry: { attempt: number; delayMs: number } | undefined;
  if (deps.retryScheduler && !turnCompleted) {
    const retry = deps.retryScheduler.scheduleRetry(payload, classification, error);
    if (retry.scheduled) {
      logger.warn(
        `[TriggerRetry] attempt ${retry.attempt} in ${Math.round(retry.delayMs / 1000)}s, category=${classification.category}`,
        {
          triggerId,
          from: payload.fromSlug,
          to: payload.toSlug,
          threadKey: payload.threadKey || null,
          inboxMessageId: payload.inboxMessageId || null,
        }
      );

      if (recipientUserId && deps.logRetryActivity) {
        try {
          await deps.logRetryActivity({
            userId: recipientUserId,
            sbSlug: payload.toSlug,
            type: 'error',
            subtype: 'trigger_retry',
            content: `Trigger to ${payload.toSlug} failed (${classification.category}) — retry ${retry.attempt}/${TRIGGER_MAX_ATTEMPTS} in ${Math.round(retry.delayMs / 1000)}s: ${classification.summary}`,
            correlationId: payload.threadMessageId || payload.inboxMessageId,
            status: 'pending',
            payload: {
              triggerRetry: true,
              triggerId,
              attempt: retry.attempt,
              maxAttempts: TRIGGER_MAX_ATTEMPTS,
              delayMs: retry.delayMs,
              errorCategory: classification.category,
              errorSummary: classification.summary,
              fromSlug: payload.fromSlug,
              toSlug: payload.toSlug,
              threadKey: payload.threadKey || null,
            },
          });
        } catch (logErr) {
          logger.warn('[TriggerRetry] Failed to log retry activity', {
            error: logErr instanceof Error ? logErr.message : String(logErr),
          });
        }
      }

      // Whether the notification may be suppressed depends on whether
      // anything durable survives this process (Lumen, r2).
      //
      // An agent_inbox trigger has been restored to unread above, so the
      // row IS the fallback: a restart mid-backoff loses the timer and the
      // message is still sitting there unread for the next heartbeat scan.
      // Staying quiet costs nothing.
      //
      // A thread-borne trigger has no such row. Thread read state is a
      // monotonic read pointer, and rewinding it would resurface every
      // message after that point rather than this one, so there is nothing
      // to restore. Suppressing the notice would mean a restart during the
      // backoff drops the message with no timer, no row and nothing said —
      // strictly worse than the behaviour this replaced, which at least
      // always told the sender.
      //
      // So a threaded failure still speaks once: on the first failure
      // (attempt 1) the notice says a retry is pending, and the retry's own
      // failure stays quiet because the sender has already been told.
      if (payload.inboxMessageId) return;
      if (attempt > 1) return;
      pendingRetry = { attempt: retry.attempt, delayMs: retry.delayMs };
    }
  }

  // 4. Notify sender agent (if there is one) — skip if no sender to avoid loops
  if (!payload.fromSlug) return;

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
      from: payload.fromSlug,
      to: payload.toSlug,
      threadKey: payload.threadKey ?? null,
    });
    return;
  }

  const categoryLabel =
    classification.category !== 'unknown' ? ` (${classification.category})` : '';
  const attemptsLabel = attempt > 1 ? ` after ${attempt} attempts` : '';
  const retryLabel = pendingRetry
    ? ` — retrying (${pendingRetry.attempt}/${TRIGGER_MAX_ATTEMPTS}) in ${Math.round(pendingRetry.delayMs / 1000)}s`
    : '';
  const notificationContent = `Trigger to ${payload.toSlug} failed${attemptsLabel}${categoryLabel}${retryLabel}: ${classification.summary}`;

  // Thread-borne trigger → notice joins the thread (participants and
  // session stamps already exist; stamped-only delivery lands it in
  // exactly one session per participant). Threadless → legacy inbox.
  const noticeResult = await sendTriggerFailureNotice(client, {
    // The legacy lane's recipient owner is the SENDER's; without one
    // the notice has only the thread lane.
    userId: senderOwnerUserId,
    legacyLane: !!senderOwnerUserId,
    fromSlug: payload.fromSlug,
    toSlug: payload.toSlug,
    threadId: resolvedThreadId,
    threadKey: payload.threadKey,
    workspaceId: resolvedThreadWorkspaceId ?? null,
    subject: `Trigger failed: ${payload.toSlug}`,
    content: notificationContent,
    metadata: {
      triggerFailure: true,
      triggerId,
      errorCategory: classification.category,
      errorSummary: classification.summary,
      errorDetail: errorText.slice(0, 4000),
      retryable: classification.retryable,
      attempts: attempt,
      retryPending: pendingRetry ? pendingRetry.attempt : null,
      originalInboxMessageId: payload.inboxMessageId || null,
    },
  });
  if (noticeResult.ok) {
    logger.info('[TriggerFailure] Sent failure notification to sender', {
      sender: payload.fromSlug,
      category: classification.category,
      via: noticeResult.via,
    });
  }
}
