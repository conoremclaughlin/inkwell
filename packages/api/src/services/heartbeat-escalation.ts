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
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';
import type { DueReminder } from './heartbeat.js';
import type { ChannelResponse, ChannelType } from './sessions/types.js';
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
}

export interface HeartbeatEscalation {
  onFailure: (reminder: DueReminder, error: string, consecutive: number) => Promise<void>;
  onRecovery: (reminder: DueReminder, failedBeats: number) => Promise<void>;
}

export function createHeartbeatEscalation(deps: HeartbeatEscalationDeps): HeartbeatEscalation {
  const { client, sendToChannel, defaultAgentId } = deps;

  /** Resolve the agent whose beat this was, so the notice lands in their inbox. */
  const resolveFailedAgentId = async (reminder: DueReminder): Promise<string> => {
    if (!reminder.sb_id) return defaultAgentId;
    const { data: identity } = await client
      .from('agent_identities')
      .select('agent_id')
      .eq('id', reminder.sb_id)
      .single();
    return (identity as { agent_id?: string } | null)?.agent_id || defaultAgentId;
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
    consecutive: number
  ): Promise<void> => {
    const failedAgentId = await resolveFailedAgentId(reminder);
    const classification = classifyError({ errorText: error });

    // The durable copy. Kept even though it cannot be the only destination —
    // it is what survives a restart and what the dashboard reads.
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
    if (insertError) {
      throw new Error(`heartbeat escalation inbox write failed: ${insertError.message}`);
    }

    // Only the first failure alerts. Beats 2..n are already covered by the
    // alert that went out on beat 1, and re-sending every tick would train the
    // reader to ignore it.
    if (consecutive > 1) {
      logger.warn('[Heartbeat] Failure continues — already alerted, inbox only', {
        reminderId: reminder.id,
        agentId: failedAgentId,
        consecutive,
        category: classification.category,
      });
      return;
    }

    const alert = await alertOwnerDirectly(
      reminder,
      `⚠️ Heartbeat FAILED: "${reminder.title}"\n\n` +
        `${classification.category}${classification.retryable ? ' (retryable)' : ''}: ${error}\n\n` +
        `Whatever this beat monitors is NOT being checked. ` +
        `I will send one more message when it runs again.`
    );

    logger.error('[Heartbeat] Escalated failure', {
      reminderId: reminder.id,
      agentId: failedAgentId,
      consecutive,
      category: classification.category,
      alertSent: alert.sent,
      ...(alert.reason ? { alertSkipped: alert.reason } : {}),
      error: error.slice(0, 500),
    });
  };

  const onRecovery = async (reminder: DueReminder, failedBeats: number): Promise<void> => {
    const alert = await alertOwnerDirectly(
      reminder,
      `✅ Heartbeat recovered: "${reminder.title}"\n\n` +
        `Running again after ${failedBeats} failed ${failedBeats === 1 ? 'beat' : 'beats'}.`
    );

    logger.info('[Heartbeat] Announced recovery', {
      reminderId: reminder.id,
      failedBeats,
      alertSent: alert.sent,
      ...(alert.reason ? { alertSkipped: alert.reason } : {}),
    });
  };

  return { onFailure, onRecovery };
}
