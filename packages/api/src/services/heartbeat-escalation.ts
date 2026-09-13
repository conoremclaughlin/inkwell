/**
 * Heartbeat failure escalation.
 *
 * A monitor that fails quietly is worse than no monitor, because the person
 * depending on it believes they are covered. On 2026-09-09, eight of nine of
 * Myra's beats failed over twelve hours and produced exactly as much noise as
 * zero failures.
 *
 * This module is the reporting path for that. It lives outside `server.ts`
 * because the escalation callback IS the behaviour under test — a suite that
 * asserts against a mocked hook proves the hook is called, not that the notice
 * reaches anyone.
 *
 * TWO DESTINATIONS, AND THE SECOND IS THE ONE THAT WORKS.
 *
 * The inbox copy is durable, survives restarts, and shows up in the dashboard.
 * But it cannot be the only destination, and the reason is circular by
 * construction: the failure being reported is "this SB could not start", and
 * reading an inbox requires the SB to start. Eight consecutive failures would
 * have produced eight unread inbox rows and still zero signal to the human —
 * the identical outcome to doing nothing, with more rows in a table.
 *
 * So an outage alert also goes out over the channel directly, from the server,
 * with no LLM turn anywhere in the path. Anything that needs an SB to wake up
 * in order to report that an SB could not wake up is not a fix.
 *
 * The destination is the reminder's OWN configured delivery channel — the one
 * it was going to deliver to anyway, chosen by the owner when they created it.
 * This deliberately invents no new notification surface: if the beat's whole
 * purpose is to message you on Telegram, telling you it did not run belongs on
 * that same Telegram thread.
 *
 * TWO MESSAGES PER OUTAGE, NOT TWO PER BEAT.
 *
 * The alert fires once, on the transition from healthy to failing, and carries
 * the failure count. Then silence. Then one recovery notice when a beat lands
 * again. Myra's twelve hours would have been two messages. An alert with no
 * resolution is its own kind of noise — it leaves the human holding a failure
 * notice, having to ask the SB whether it is back, and if it is not back it
 * cannot answer.
 *
 * "Per outage" means per SB, not per beat, and that distinction is load-bearing
 * because the streak backing it is per-REMINDER. An SB owning several beats
 * fails them all from one logged-out backend, each with its own streak of 1 —
 * so each clears the streak guard and each alerts. Myra has two active beats
 * whose crons collide at 16:00Z daily, delivering to the same Telegram chat:
 * one cause, two alarms, in the same second. She found it on 2026-09-11, and
 * `destinationAlreadyAlerted` is the answer — the first beat to reach a given
 * SB+channel+address speaks for the rest of that run, on both edges. The inbox
 * copy stays per-beat, because there the detail is the point.
 *
 * SILENCE IS EARNED BY DELIVERY, NOT BY HAVING TRIED.
 *
 * The first version of this file suppressed repeats on `consecutive > 1` — the
 * failure streak. Lumen's round-two review found that a streak proves a previous
 * BEAT failed and says nothing about whether its alert reached anyone. If the
 * first channel send rejected, its failure was already in `reminder_history`, so
 * every later beat read a streak above one and stayed quiet: zero successful
 * alerts, forever, for an outage still in progress. Round three found the same
 * defect one level up, in the sibling collapse — the destination was claimed
 * before the send was attempted, so a failed first send silenced the second beat
 * too.
 *
 * Both are the same mistake, and it is the mistake this whole module exists to
 * correct: treating an attempt as if it were an outcome. So suppression now
 * keys off durable DELIVERY acknowledgement (`heartbeat-notification-store`),
 * a pending notice is retried under a bounded cap, and a destination is claimed
 * only after a send actually succeeds.
 *
 * The two destinations are also genuinely independent now. The inbox write used
 * to throw on a PostgREST error, which exited before the channel attempt — so
 * the durable copy, the one that cannot reach a human on its own, could cancel
 * the one that can. Each is attempted and reported separately.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';
import type {
  DueReminder,
  HeartbeatEscalationContext,
  HeartbeatFailureHook,
  HeartbeatRecoveryHook,
} from './heartbeat.js';
import type { ChannelResponse, ChannelType } from './sessions/types.js';
import type { HeartbeatNotificationStore, NoticeKey } from './heartbeat-notification-store.js';
import { createHeartbeatNotificationStore } from './heartbeat-notification-store.js';
import { classifyError } from '@inklabs/shared';
import { logger } from '../utils/logger.js';

/**
 * Channels we will send an unsolicited outage alert over.
 *
 * `heartbeat` is excluded because it is not a destination — it is the internal
 * pseudo-channel a beat uses to wake its own agent, so a notice sent there
 * would land right back in the path that is broken. `terminal`, `http`, `api`,
 * `agent` and `web` are excluded for the same reason: nobody is watching them
 * when the thing that failed is a background monitor.
 */
const ALERTABLE_CHANNELS = new Set<ChannelType>(['telegram', 'whatsapp', 'discord', 'slack']);

export interface HeartbeatEscalationDeps {
  /** Service-role client. Writes the durable inbox copy. */
  client: SupabaseClient<Database>;
  /**
   * Sends directly over the channel, bypassing the session layer. This is the
   * no-LLM-turn requirement: it must not route through anything that needs an
   * agent to be running.
   */
  sendToChannel: (response: ChannelResponse) => Promise<unknown>;
  /** Fallback agent when the reminder carries no `sb_id`. */
  defaultAgentId: string;
  /**
   * Durable record of which notices actually reached a human. Injectable so the
   * suppression rule can be tested against a fake rather than a mocked query
   * builder — a builder mock answers every question the same way, which is how
   * the streak bug survived sixty-one passing tests.
   */
  store?: HeartbeatNotificationStore;
}

export interface HeartbeatEscalation {
  onFailure: HeartbeatFailureHook;
  onRecovery: HeartbeatRecoveryHook;
}

export function createHeartbeatEscalation(deps: HeartbeatEscalationDeps): HeartbeatEscalation {
  const { client, sendToChannel, defaultAgentId } = deps;
  const store = deps.store ?? createHeartbeatNotificationStore(client);

  /**
   * Whether this reminder has anywhere to send an unsolicited notice.
   *
   * Checked before the store is touched, so beats with no external destination
   * (the `heartbeat` pseudo-channel, or a missing target) never create
   * acknowledgement rows they could only ever fail to satisfy.
   */
  const alertability = (reminder: DueReminder): { ok: boolean; reason?: string } => {
    const channel = reminder.delivery_channel as ChannelType;
    if (!ALERTABLE_CHANNELS.has(channel)) {
      return { ok: false, reason: `channel '${channel}' is not an external destination` };
    }
    if (!reminder.delivery_target) {
      return { ok: false, reason: `channel '${channel}' has no delivery target configured` };
    }
    return { ok: true };
  };

  const noticeKeyFor = (
    reminder: DueReminder,
    kind: NoticeKey['kind'],
    context: HeartbeatEscalationContext,
    failedBeats?: number
  ): NoticeKey => ({
    reminderId: reminder.id,
    userId: reminder.user_id,
    kind,
    episodeKey: context.episodeKey,
    destination: context.destination,
    failedBeats,
  });

  /**
   * Resolve the agent whose beat this was, so the notice lands in their inbox.
   *
   * Never throws. This is a detail of the INBOX copy — the destination that
   * cannot reach a human while the SB is down — and it ran outside the guard
   * below, so a transport failure here aborted `onFailure` before the channel
   * send. The durable copy taking the useful copy down with it is the exact
   * coupling the two-destination split exists to prevent, and the identity
   * lookup is as much a part of the inbox dependency as the insert is. Falling
   * back to the default agent costs a slightly misaddressed inbox row; throwing
   * costs the alert.
   */
  const resolveFailedAgentId = async (reminder: DueReminder): Promise<string> => {
    if (!reminder.sb_id) return defaultAgentId;
    try {
      const { data: identity, error } = await client
        .from('agent_identities')
        .select('agent_id')
        .eq('id', reminder.sb_id)
        .single();
      if (error) {
        logger.warn('[Heartbeat] Could not resolve the failed beat’s agent — using the default', {
          reminderId: reminder.id,
          sbId: reminder.sb_id,
          error: error.message,
        });
        return defaultAgentId;
      }
      return (identity as { agent_id?: string } | null)?.agent_id || defaultAgentId;
    } catch (err) {
      logger.warn('[Heartbeat] Agent identity lookup threw — using the default', {
        reminderId: reminder.id,
        sbId: reminder.sb_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return defaultAgentId;
    }
  };

  /**
   * Send over the reminder's configured channel.
   *
   * Reports whether a notice actually went out, so the caller can log the
   * difference between "alerted the human" and "had nowhere to send it".
   * Never throws: a dead Telegram connection must not also cost us the inbox
   * copy, which is the whole point of keeping both.
   */
  const alertOwnerDirectly = async (
    reminder: DueReminder,
    content: string
  ): Promise<{ sent: boolean; reason?: string }> => {
    const channel = reminder.delivery_channel as ChannelType;
    const target = reminder.delivery_target;

    if (!ALERTABLE_CHANNELS.has(channel)) {
      return { sent: false, reason: `channel '${channel}' is not an external destination` };
    }
    if (!target) {
      return { sent: false, reason: `channel '${channel}' has no delivery target configured` };
    }

    try {
      await sendToChannel({
        channel,
        conversationId: target,
        content,
        format: 'text',
        metadata: { source: 'heartbeat-escalation', reminderId: reminder.id },
      });
      return { sent: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('[Heartbeat] Direct outage alert failed to send', {
        reminderId: reminder.id,
        channel,
        error: reason,
      });
      return { sent: false, reason };
    }
  };

  const onFailure = async (
    reminder: DueReminder,
    error: string,
    consecutive: number,
    context: HeartbeatEscalationContext
  ): Promise<{ alerted: boolean }> => {
    const failedAgentId = await resolveFailedAgentId(reminder);
    const classification = classifyError({ errorText: error });

    // DESTINATION ONE: the durable copy. Kept even though it cannot be the only
    // destination — it is what survives a restart and what the dashboard reads.
    // Its failure is recorded and then set aside: it must not be able to cancel
    // the channel attempt below, which is the one that can actually reach a
    // human while the SB is down.
    let inboxError: string | null = null;
    try {
      const { error: insertError } = await client.from('agent_inbox').insert({
        recipient_user_id: reminder.user_id,
        recipient_agent_id: failedAgentId,
        sender_agent_id: null,
        message_type: 'notification',
        priority: consecutive >= 3 ? 'urgent' : 'high',
        subject: `Heartbeat FAILED (${consecutive}x): ${reminder.title}`,
        content:
          `Your scheduled heartbeat "${reminder.title}" did not run.\n\n` +
          `Consecutive failures: ${consecutive}\n` +
          `Category: ${classification.category} (retryable: ${classification.retryable})\n` +
          `Error: ${error}\n\n` +
          `Whatever this beat monitors has NOT been checked since it started failing. ` +
          `If a human depends on it, tell them — a monitor that fails quietly is worse ` +
          `than no monitor, because they believe they are covered.`,
        status: 'unread',
      } as never);

      // PostgREST resolves with `{ error }` on an HTTP/DB failure rather than
      // throwing. Discarding it meant a 403 logged as a successful escalation —
      // the silence bug reproduced one level up, inside its own fix.
      if (insertError) inboxError = insertError.message;
    } catch (err) {
      inboxError = err instanceof Error ? err.message : String(err);
    }

    if (inboxError) {
      logger.error('[Heartbeat] Durable inbox copy failed — continuing to the channel', {
        reminderId: reminder.id,
        agentId: failedAgentId,
        error: inboxError,
      });
    }

    // DESTINATION TWO: the channel. Independent of the above by construction.
    const reachable = alertability(reminder);
    if (!reachable.ok) {
      logger.error('[Heartbeat] Escalated failure — no external destination', {
        reminderId: reminder.id,
        agentId: failedAgentId,
        consecutive,
        category: classification.category,
        alertSent: false,
        alertSkipped: reachable.reason,
        ...(inboxError ? { inboxError } : {}),
        error: error.slice(0, 500),
      });
      return { alerted: false };
    }

    const key = noticeKeyFor(reminder, 'outage', context, consecutive);

    // A sibling beat of the same SB already reached this destination in this
    // run — one cause, one alarm. Record that THIS episode is covered too,
    // otherwise the suppressed beat would find its own notice unsent and alert
    // on its next tick, which is the duplicate arriving one beat late.
    if (context.destinationAlreadyAlerted) {
      await store.markCoveredBySibling(key);
      logger.warn('[Heartbeat] Sibling beat already alerted this destination — inbox only', {
        reminderId: reminder.id,
        agentId: failedAgentId,
        channel: reminder.delivery_channel,
        category: classification.category,
      });
      return { alerted: false };
    }

    // The real dedup: has a notice for THIS outage actually been delivered?
    // Not "did an earlier beat fail" — that was the round-two defect.
    const { shouldSend, record } = await store.claimNotice(key);
    if (!shouldSend) {
      logger.warn('[Heartbeat] Outage already announced for this episode — inbox only', {
        reminderId: reminder.id,
        agentId: failedAgentId,
        consecutive,
        noticeStatus: record?.status,
        noticeAttempts: record?.attempts,
        category: classification.category,
      });
      return { alerted: false };
    }

    const alert = await alertOwnerDirectly(
      reminder,
      `⚠️ Heartbeat FAILED: "${reminder.title}"\n\n` +
        `${classification.category}${classification.retryable ? ' (retryable)' : ''}: ${error}\n\n` +
        `Whatever this beat monitors is NOT being checked. ` +
        `I will send one more message when it runs again.`
    );

    // Settle before returning: an unrecorded successful send would re-alert on
    // the next beat, and an unrecorded failure would never be retried.
    await store.settleNotice(key, { delivered: alert.sent, error: alert.reason });

    logger.error('[Heartbeat] Escalated failure', {
      reminderId: reminder.id,
      agentId: failedAgentId,
      consecutive,
      category: classification.category,
      alertSent: alert.sent,
      ...(alert.reason ? { alertSkipped: alert.reason } : {}),
      ...(inboxError ? { inboxError } : {}),
      error: error.slice(0, 500),
    });

    return { alerted: alert.sent };
  };

  const onRecovery = async (
    reminder: DueReminder,
    failedBeats: number,
    context: HeartbeatEscalationContext
  ): Promise<{ alerted: boolean }> => {
    const reachable = alertability(reminder);
    if (!reachable.ok) {
      logger.info('[Heartbeat] Recovery not announced — no external destination', {
        reminderId: reminder.id,
        failedBeats,
        alertSkipped: reachable.reason,
      });
      return { alerted: false };
    }

    const key = noticeKeyFor(reminder, 'recovery', context, failedBeats);

    // Same collapse on the way out. One "back up" per destination per run —
    // otherwise the two beats that alerted together also clear together, and
    // the fix for duplicate alarms ships duplicate all-clears.
    if (context.destinationAlreadyAlerted) {
      await store.markCoveredBySibling(key);
      logger.info('[Heartbeat] Sibling beat already announced recovery — staying quiet', {
        reminderId: reminder.id,
        channel: reminder.delivery_channel,
        failedBeats,
      });
      return { alerted: false };
    }

    const { shouldSend, record } = await store.claimNotice(key);
    if (!shouldSend) {
      logger.info('[Heartbeat] Recovery already announced for this episode', {
        reminderId: reminder.id,
        failedBeats,
        noticeStatus: record?.status,
        noticeAttempts: record?.attempts,
      });
      return { alerted: false };
    }

    const alert = await alertOwnerDirectly(
      reminder,
      `✅ Heartbeat recovered: "${reminder.title}"\n\n` +
        `Running again after ${failedBeats} failed ${failedBeats === 1 ? 'beat' : 'beats'}.`
    );

    await store.settleNotice(key, { delivered: alert.sent, error: alert.reason });

    // The debt is settled only by delivery. A failed all-clear leaves the
    // episode open so the sweep on the next healthy beat finds it again.
    if (alert.sent) await store.closeEpisode(key);

    logger.info('[Heartbeat] Announced recovery', {
      reminderId: reminder.id,
      failedBeats,
      alertSent: alert.sent,
      ...(alert.reason ? { alertSkipped: alert.reason } : {}),
    });

    return { alerted: alert.sent };
  };

  return { onFailure, onRecovery };
}
