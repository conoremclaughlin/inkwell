/**
 * An inkling's heartbeat: a reminder that wakes it in its own conversation
 * with its person, to tell them something that happened, or to stay quiet
 * (Conor, Oct 7 2026, 11:45 PM). Awakening makes the reminder
 * (seedInklingHeartbeat, starter-space.ts); this is what happens when it
 * fires.
 *
 * - **Where it lands.** The inkling's one-to-one conversation with its owner,
 *   the most recently active one, in its own space. An inkling with no such
 *   conversation yet has nobody to tell, and the beat is skipped, which is
 *   not an outage.
 * - **How it is admitted.** The turn gate wakes an inkling only for its
 *   owner's own stored message. A beat is the one other door: the request
 *   carries `inklingHeartbeat`, which only this delivery sets, and the gate
 *   still reads the stored reminder and conversation (isOwnersHeartbeat).
 *   The owner test's own conditions apply to it unchanged.
 * - **How it speaks.** It sends at most one message to that conversation
 *   with send_to_inbox, as an inkling replies, or ends without one. Nothing
 *   it writes otherwise reaches anyone: a beat that ends with "nothing new"
 *   stays unsent, where posting the turn's closing text would turn every
 *   quiet beat into a check-in.
 * - **What it reads.** Its own heartbeat document, carried in the beat's
 *   prompt, because the ink runtime an inkling runs on puts no identity
 *   document there. The reminder's title and description are not read: no
 *   text but the inkling's own goes into its prompt.
 *
 * Quiet hours are the scheduler's: it holds a beat inside the person's
 * quiet hours before claiming it, as it does every reminder's.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DueReminder, HeartbeatDeliveryContext, HeartbeatDeliveryOutcome } from '../heartbeat';
import type { SessionRequest, SessionResult } from '../sessions/types';
import { logger } from '../../utils/logger';
import { INKLING_CLIENT } from './inkling-client';
import { INKLING_CONVERSATION_MARK } from './inkling-thread-gate';
import type { OwnerMessageProof } from './inkling-turn-gate';
import {
  INKLING_HEARTBEAT,
  INKLING_HEARTBEAT_CHANNEL,
  INKLING_HEARTBEAT_REMINDER,
} from './starter-space';

/** Thread ids per `in` list when reading an inkling's conversations. */
const THREAD_PAGE = 100;

/** Whether a due reminder is an inkling's heartbeat, which only this module delivers. */
export function isInklingHeartbeatReminder(
  reminder: Pick<DueReminder, 'delivery_channel'>
): boolean {
  return reminder.delivery_channel === INKLING_HEARTBEAT_CHANNEL;
}

export interface InklingConversation {
  threadId: string;
  threadKey: string;
}

interface Inkling {
  id: string;
  userId: string;
  workspaceId: string;
}

interface ThreadRow {
  id: string;
  thread_key: string;
  status: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string | null;
}

interface MemberRow {
  thread_id: string;
  sb_id: string | null;
  user_id: string | null;
}

const sameId = (a: string | null | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase();

/**
 * A conversation the app shows as one-to-one: marked an inkling conversation
 * at its creation, open, in the inkling's space, with exactly this inkling
 * and its owner in it.
 */
function isOwnConversation(thread: ThreadRow, members: MemberRow[], inkling: Inkling): boolean {
  if (thread.metadata?.[INKLING_CONVERSATION_MARK] !== true) return false;
  if (thread.status === 'closed') return false;
  const sbs = members.filter((m) => m.sb_id).map((m) => m.sb_id as string);
  const people = members.filter((m) => m.user_id).map((m) => m.user_id as string);
  return (
    sbs.length === 1 &&
    sameId(sbs[0], inkling.id) &&
    people.length === 1 &&
    sameId(people[0], inkling.userId)
  );
}

/**
 * The inkling's own conversation with its owner, the most recently active
 * one (a send bumps the thread's updated_at), or null when it has none.
 * Throws when a read fails.
 */
export async function findInklingConversation(
  supabase: SupabaseClient,
  inkling: Inkling
): Promise<InklingConversation | null> {
  const { data: memberships, error: membershipError } = await supabase
    .from('inbox_thread_participants')
    .select('thread_id')
    .eq('sb_id', inkling.id);
  if (membershipError) {
    throw new Error(`Failed to read the inkling's conversations: ${membershipError.message}`);
  }
  const threadIds = [
    ...new Set(((memberships ?? []) as Array<{ thread_id: string }>).map((m) => m.thread_id)),
  ];

  let newest: { thread: ThreadRow; at: number } | null = null;
  for (let start = 0; start < threadIds.length; start += THREAD_PAGE) {
    const page = threadIds.slice(start, start + THREAD_PAGE);
    const { data: threadRows, error: threadError } = await supabase
      .from('inbox_threads')
      .select('id, thread_key, status, metadata, updated_at')
      .in('id', page)
      .eq('workspace_id', inkling.workspaceId);
    if (threadError) {
      throw new Error(`Failed to read the inkling's conversations: ${threadError.message}`);
    }
    const marked = ((threadRows ?? []) as ThreadRow[]).filter(
      (t) => t.metadata?.[INKLING_CONVERSATION_MARK] === true && t.status !== 'closed'
    );
    if (marked.length === 0) continue;
    const { data: memberRows, error: memberError } = await supabase
      .from('inbox_thread_participants')
      .select('thread_id, sb_id, user_id')
      .in(
        'thread_id',
        marked.map((t) => t.id)
      );
    if (memberError) {
      throw new Error(`Failed to read the conversations' members: ${memberError.message}`);
    }
    const members = (memberRows ?? []) as MemberRow[];
    for (const thread of marked) {
      const own = members.filter((m) => m.thread_id === thread.id);
      if (!isOwnConversation(thread, own, inkling)) continue;
      const at = Date.parse(thread.updated_at ?? '') || 0;
      // Newest first; the id breaks a tie, so the choice never depends on
      // the order rows come back in.
      if (!newest || at > newest.at || (at === newest.at && thread.id > newest.thread.id)) {
        newest = { thread, at };
      }
    }
  }
  return newest ? { threadId: newest.thread.id, threadKey: newest.thread.thread_key } : null;
}

/**
 * Is this turn the inkling's own heartbeat, firing in its own conversation?
 * The turn gate's proof for a beat, read from stored rows as the owner-message
 * proof is (isOwnersOwnMessage):
 * - the reminder is this inkling's heartbeat: bound to it, on its owner's
 *   account, active, on the inkling channel and of the heartbeat type;
 * - the thread the turn names is its one-to-one conversation with that
 *   owner, in its own space.
 * 'unreadable' when a read failed, so the refusal can be retried.
 */
export async function isOwnersHeartbeat(
  supabase: SupabaseClient,
  input: {
    reminderId: string;
    threadKey: string | undefined;
    inkling: { id: string; userId: string; workspaceId: string | null };
  }
): Promise<OwnerMessageProof> {
  const { reminderId, threadKey } = input;
  const { workspaceId } = input.inkling;
  if (!threadKey || !workspaceId) return 'no';
  const inkling: Inkling = { ...input.inkling, workspaceId };

  const { data: reminderRow, error: reminderError } = await supabase
    .from('scheduled_reminders')
    .select('id, user_id, sb_id, status, delivery_channel, metadata')
    .eq('id', reminderId)
    .maybeSingle();
  if (reminderError) return 'unreadable';
  const reminder = reminderRow as {
    user_id: string;
    sb_id: string | null;
    status: string;
    delivery_channel: string;
    metadata: Record<string, unknown> | null;
  } | null;
  if (
    !reminder ||
    !sameId(reminder.sb_id, inkling.id) ||
    !sameId(reminder.user_id, inkling.userId) ||
    reminder.status !== 'active' ||
    reminder.delivery_channel !== INKLING_HEARTBEAT_CHANNEL ||
    reminder.metadata?.reminderType !== INKLING_HEARTBEAT_REMINDER
  ) {
    return 'no';
  }

  const { data: threadRow, error: threadError } = await supabase
    .from('inbox_threads')
    .select('id, thread_key, status, metadata, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (threadError) return 'unreadable';
  const thread = threadRow as ThreadRow | null;
  if (!thread) return 'no';
  const { data: memberRows, error: memberError } = await supabase
    .from('inbox_thread_participants')
    .select('thread_id, sb_id, user_id')
    .eq('thread_id', thread.id);
  if (memberError) return 'unreadable';
  return isOwnConversation(thread, (memberRows ?? []) as MemberRow[], inkling) ? 'yes' : 'no';
}

/** "Thursday, October 8 at 9:00 AM" in the zone, or in UTC when the zone is not one. */
function localTime(at: Date, timezone: string): { text: string; timezone: string } {
  const format = (timeZone: string) =>
    at.toLocaleString('en-US', {
      timeZone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  try {
    return { text: format(timezone), timezone };
  } catch {
    return { text: format('UTC'), timezone: 'UTC' };
  }
}

/**
 * What a beat says to the inkling. Its heartbeat document as it stands: the
 * starter text when none was ever written (null), and nothing when it
 * emptied it.
 */
export function inklingHeartbeatPrompt(input: {
  sbSlug: string;
  threadKey: string;
  /** Its document as stored: null (or absent) when never written. */
  heartbeat: string | null | undefined;
  now: Date;
  timezone: string;
  quietUntil?: string;
}): string {
  const { sbSlug, threadKey } = input;
  const time = localTime(input.now, input.timezone);
  const document = typeof input.heartbeat === 'string' ? input.heartbeat.trim() : INKLING_HEARTBEAT;
  const lines = [
    '[HEARTBEAT]',
    `Nobody wrote to you: this is your heartbeat. For the person you're with it's ${time.text} (${time.timezone}).`,
  ];
  if (input.quietUntil) {
    const until = localTime(new Date(input.quietUntil), input.timezone);
    lines.push(
      `It's their quiet hours until ${until.text}. Send nothing that can wait until then.`
    );
  }
  if (document) {
    lines.push(
      '',
      'Your heartbeat document follows. It is yours, and you can change it.',
      '',
      '---',
      document,
      '---'
    );
  }
  lines.push(
    '',
    `Your conversation with them is "${threadKey}". If something needs them now, send them one message there:`,
    `send_to_inbox(threadKey: "${threadKey}", recipientSlug: "${sbSlug}", content: "...")`,
    'If nothing does, end without sending anything. Nothing else you write in this turn reaches them.'
  );
  return lines.join('\n');
}

export interface InklingHeartbeatDeps {
  supabase: SupabaseClient;
  handleMessage: (request: SessionRequest) => Promise<SessionResult>;
  now?: () => Date;
}

/**
 * Fire an inkling's heartbeat: find its conversation, and run one turn there
 * under the heartbeat's admission. The outcome is the scheduler's: delivered
 * when the turn ran (whether or not it chose to say anything), skipped when
 * there was nobody to tell, failed otherwise.
 */
export async function deliverInklingHeartbeat(
  deps: InklingHeartbeatDeps,
  reminder: DueReminder,
  context?: HeartbeatDeliveryContext
): Promise<HeartbeatDeliveryOutcome> {
  const { supabase } = deps;
  if (!reminder.sb_id) {
    return { status: 'failed', error: 'An inkling heartbeat names no inkling' };
  }
  const { data: identityRow, error: identityError } = await supabase
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id, heartbeat, metadata')
    .eq('id', reminder.sb_id)
    .maybeSingle();
  if (identityError) {
    return { status: 'failed', error: `Failed to read the inkling: ${identityError.message}` };
  }
  const identity = identityRow as {
    id: string;
    agent_id: string;
    user_id: string;
    workspace_id: string | null;
    heartbeat: string | null;
    metadata: Record<string, unknown> | null;
  } | null;
  if (!identity) {
    return { status: 'skipped', reason: 'the inkling this heartbeat was for no longer exists' };
  }
  if (
    identity.metadata?.client !== INKLING_CLIENT ||
    !sameId(identity.user_id, reminder.user_id) ||
    !identity.workspace_id
  ) {
    return {
      status: 'failed',
      error: "An inkling heartbeat is bound to an identity that isn't this person's inkling",
    };
  }

  let conversation: InklingConversation | null;
  try {
    conversation = await findInklingConversation(supabase, {
      id: identity.id,
      userId: identity.user_id,
      workspaceId: identity.workspace_id,
    });
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  if (!conversation) {
    return {
      status: 'skipped',
      reason: 'the inkling has no conversation with its person yet',
    };
  }

  const { data: userRow } = await supabase
    .from('users')
    .select('timezone')
    .eq('id', reminder.user_id)
    .maybeSingle();
  const timezone = (userRow as { timezone: string | null } | null)?.timezone || 'UTC';

  const request: SessionRequest = {
    userId: reminder.user_id,
    sbSlug: identity.agent_id,
    channel: 'heartbeat',
    conversationId: `heartbeat:${reminder.id}`,
    sender: { id: 'system', name: 'heartbeat' },
    content: inklingHeartbeatPrompt({
      sbSlug: identity.agent_id,
      threadKey: conversation.threadKey,
      heartbeat: identity.heartbeat,
      now: (deps.now ?? (() => new Date()))(),
      timezone,
      ...(context?.quietHours ? { quietUntil: context.quietHours.until } : {}),
    }),
    metadata: {
      triggerType: 'heartbeat',
      chatType: 'direct',
      // Routes the turn to the conversation's own session.
      threadKey: conversation.threadKey,
    },
    inklingHeartbeat: { reminderId: reminder.id },
  };

  try {
    const result = await deps.handleMessage(request);
    logger.info('[Heartbeat] Inkling heartbeat result', {
      reminderId: reminder.id,
      sbId: identity.id,
      threadKey: conversation.threadKey,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.usage ? { tokens: result.usage } : {}),
    });
    if (result.success) return { status: 'delivered' };
    return {
      status: 'failed',
      error: result.error || 'session reported failure',
      ...(result.classification ? { classification: result.classification } : {}),
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
