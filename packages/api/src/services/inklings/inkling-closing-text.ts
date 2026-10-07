/**
 * When an inkling's turn ends without a word to its owner (task 9edf62fe).
 *
 * An inkling answers in its conversation by sending to that thread. A turn
 * that ends without sending leaves the person with "working", then silence,
 * while the closing text the turn produced, often an honest account of what
 * went wrong, goes nowhere: external channels forward a turn's final text
 * when it sent nothing, and a thread wake routes only explicit responses.
 * Conor's first inkling did exactly this on 2026-10-06.
 *
 * So after an admitted, successful wake on its own one-to-one conversation,
 * if the inkling has posted nothing there since the message that woke it,
 * its closing text is posted as the inkling's message. It goes through the
 * ordinary send path as the inkling, so the inkling thread gate, the
 * participants and the read pointers apply exactly as they do to its own
 * reply, and the gate's verdict for an inkling sender wakes nobody.
 *
 * Never for a turn that failed, was stopped or was refused (none of those is
 * a success), for a wake carried by another wake's turn, or for a group
 * conversation, where staying quiet while another inkling answers can be the
 * right reply. At most once per waking message: anything the inkling posted
 * after it, this included, means there is nothing to add, and a claim held
 * across the reads keeps two completions in this process from both posting.
 */

import type { DataComposer } from '../../data/composer';
import { handleSendToInbox } from '../../mcp/tools/inbox-handlers';
import { runWithRequestContext } from '../../utils/request-context';
import type { SbPrincipal } from '../principals';
import { INKLING_CLIENT } from './inkling-service';
import { INKLING_CONVERSATION_MARK } from './inkling-thread-gate';

/** Message metadata naming the waking message a closing text answers. */
export const CLOSING_TEXT_FOR = 'closingTextFor';

/** The longest closing text posted, in code points. */
export const CLOSING_TEXT_MAX = 4000;

export type ClosingTextSkip =
  /** Not an admitted, successful turn of its own. */
  | 'turn'
  /** The turn ended with no text to post. */
  | 'empty'
  /** The wake names no thread or waking message. */
  | 'no-trigger'
  /** The target is not an inkling of this user. */
  | 'not-inkling'
  /** The thread is not this inkling's conversation. */
  | 'not-conversation'
  /** The conversation holds more than this one inkling. */
  | 'group'
  /** The inkling already posted after the waking message. */
  | 'replied'
  /** Another completion in this process is already deciding for this message. */
  | 'in-flight'
  /** A read failed, so nothing was decided or posted. */
  | 'unreadable';

export type ClosingTextOutcome =
  | { posted: true; messageId: string | null }
  | { posted: false; skipped: ClosingTextSkip }
  | { posted: false; error: string };

export interface ClosingTextTurn {
  /** The runner's outcome for this wake. */
  result: {
    success: boolean;
    admitted?: boolean;
    wake?: { coalescedInto: string };
    finalTextResponse?: string;
    sessionId?: string;
  };
  /** The runtime owner the trigger resolved. */
  userId: string;
  /** The target identity the trigger resolved and verified. */
  identityId: string | undefined;
  threadId: string | undefined;
  threadKey: string | undefined;
  /** The stored message that woke the turn. */
  threadMessageId: string | undefined;
}

/** The closing text as posted: trimmed, and cut by code points so a pair is never split. */
export function closingText(text: string | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const points = Array.from(trimmed);
  return points.length <= CLOSING_TEXT_MAX
    ? trimmed
    : `${points.slice(0, CLOSING_TEXT_MAX - 1).join('')}…`;
}

const inFlight = new Set<string>();

export async function postClosingTextIfSilent(
  dataComposer: DataComposer,
  turn: ClosingTextTurn
): Promise<ClosingTextOutcome> {
  const { result, userId, identityId, threadId, threadKey, threadMessageId } = turn;
  const skip = (skipped: ClosingTextSkip): ClosingTextOutcome => ({ posted: false, skipped });

  if (!result.success || !result.admitted || result.wake) return skip('turn');
  const content = closingText(result.finalTextResponse);
  if (!content) return skip('empty');
  if (!identityId || !threadId || !threadKey || !threadMessageId) return skip('no-trigger');

  // Claimed before the first await, so a second completion for the same
  // message cannot pass the reads while this one is still between them.
  const claim = `${identityId}:${threadMessageId}`;
  if (inFlight.has(claim)) return skip('in-flight');
  inFlight.add(claim);
  try {
    const supabase = dataComposer.getClient();

    const { data: identityRow, error: identityError } = await supabase
      .from('agent_identities')
      .select('id, agent_id, user_id, workspace_id, metadata')
      .eq('id', identityId)
      .maybeSingle();
    if (identityError) return skip('unreadable');
    const identity = identityRow as {
      id: string;
      agent_id: string;
      user_id: string;
      workspace_id: string;
      metadata: Record<string, unknown> | null;
    } | null;
    if (!identity || identity.metadata?.client !== INKLING_CLIENT || identity.user_id !== userId) {
      return skip('not-inkling');
    }

    const { data: threadRow, error: threadError } = await supabase
      .from('inbox_threads')
      .select('id, thread_key, workspace_id, metadata')
      .eq('id', threadId)
      .maybeSingle();
    if (threadError) return skip('unreadable');
    const thread = threadRow as {
      thread_key: string;
      workspace_id: string;
      metadata: Record<string, unknown> | null;
    } | null;
    if (
      !thread ||
      thread.metadata?.[INKLING_CONVERSATION_MARK] !== true ||
      thread.thread_key !== threadKey ||
      thread.workspace_id !== identity.workspace_id
    ) {
      return skip('not-conversation');
    }

    const { data: memberRows, error: memberError } = await supabase
      .from('inbox_thread_participants')
      .select('sb_id')
      .eq('thread_id', threadId);
    if (memberError) return skip('unreadable');
    const memberSbs = ((memberRows ?? []) as Array<{ sb_id: string | null }>)
      .map((row) => row.sb_id)
      .filter((id): id is string => Boolean(id));
    if (!memberSbs.includes(identityId)) return skip('not-conversation');
    if (memberSbs.some((id) => id !== identityId)) return skip('group');

    const { data: wakingRow, error: wakingError } = await supabase
      .from('inbox_thread_messages')
      .select('id, thread_id, created_at')
      .eq('id', threadMessageId)
      .maybeSingle();
    if (wakingError) return skip('unreadable');
    const waking = wakingRow as { thread_id: string; created_at: string } | null;
    if (!waking || waking.thread_id !== threadId) return skip('no-trigger');

    const { data: laterRows, error: laterError } = await supabase
      .from('inbox_thread_messages')
      .select('id')
      .eq('thread_id', threadId)
      .eq('sender_sb_id', identityId)
      .gte('created_at', waking.created_at)
      .neq('id', threadMessageId)
      .limit(1);
    if (laterError) return skip('unreadable');
    if ((laterRows ?? []).length > 0) return skip('replied');

    const inkling: SbPrincipal = {
      kind: 'sb',
      sbId: identity.id,
      sbSlug: identity.agent_id,
      userId: identity.user_id,
      workspaceId: identity.workspace_id,
    };
    try {
      // The ambient request is whoever's send dispatched this wake; the post
      // is the inkling's, from its own session.
      const sent = await runWithRequestContext(
        { userId, ...(result.sessionId ? { sessionId: result.sessionId } : {}) },
        () =>
          handleSendToInbox(
            {
              userId,
              threadKey,
              recipientSlug: inkling.sbSlug,
              content,
              metadata: { [CLOSING_TEXT_FOR]: threadMessageId },
            },
            dataComposer,
            { sender: { principal: inkling, workspaceId: inkling.workspaceId } }
          )
      );
      return { posted: true, messageId: sentMessageId(sent) };
    } catch (error) {
      return { posted: false, error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    inFlight.delete(claim);
  }
}

/** The stored message id from the send tool's JSON result, when it reports one. */
function sentMessageId(sent: unknown): string | null {
  const text = (sent as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text) as { messageId?: unknown };
    return typeof parsed.messageId === 'string' ? parsed.messageId : null;
  } catch {
    return null;
  }
}
