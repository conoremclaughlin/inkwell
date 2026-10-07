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
 * So when an admitted, successful turn on the inkling's own one-to-one
 * conversation has posted nothing there, its closing text is posted as the
 * inkling's message. It goes through the ordinary send path as the inkling,
 * so the owner's write role, the inkling thread gate, the participants and
 * the read pointers apply exactly as they do to its own reply, and the gate's
 * verdict for an inkling sender wakes nobody.
 *
 * The decision belongs to one turn. It is made in that turn's own hooks
 * (SessionTurnHooks), which run as the turn ends and before the next queued
 * turn starts, against what the conversation held when the turn began: only
 * an inkling message after that boundary, or a reply this turn routed, is
 * this turn's reply. (Judged after handleMessage settles, against the waking
 * message's time, a later turn's reply suppressed an earlier silent turn,
 * and an earlier turn's reply a later one: Lumen, #769.)
 *
 * Never for a turn that failed, was stopped or was refused (none of those is
 * a success), for a wake carried by another wake's turn, or for a group
 * conversation, where staying quiet while another inkling answers can be the
 * right reply. Suppression is best effort, not exactly-once: a closing text
 * already stored for the waking message stops a second, and a claim held
 * across the reads keeps two completions in this process from both posting,
 * but two server processes could still each post one.
 */

import type { DataComposer } from '../../data/composer';
import { handleSendToInbox } from '../../mcp/tools/inbox-handlers';
import { logger } from '../../utils/logger';
import { runWithRequestContext } from '../../utils/request-context';
import type { SbPrincipal } from '../principals';
import type { SessionTurnHooks } from '../sessions/types';
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
  /** The turn replied: it routed a response, or the inkling posted after the turn began. */
  | 'replied'
  /** A closing text for this waking message is already stored. */
  | 'already-posted'
  /** Another completion in this process is already deciding for this message. */
  | 'in-flight'
  /** A read failed, or the turn's start was never read, so nothing was decided or posted. */
  | 'unreadable';

export type ClosingTextOutcome =
  | { posted: true; messageId: string | null }
  | { posted: false; skipped: ClosingTextSkip }
  | { posted: false; error: string };

/** What a wake names, from the trigger that started it. */
export interface ClosingTextWake {
  /** The runtime owner the trigger resolved. */
  userId: string;
  /** The target identity the trigger resolved and verified. */
  identityId: string | undefined;
  threadId: string | undefined;
  threadKey: string | undefined;
  /** The stored message that woke the turn. */
  threadMessageId: string | undefined;
}

/**
 * The conversation as the turn began: the newest message's time then, from
 * the database's own clock, which also stamps every later message.
 */
export type TurnBoundary = { createdAt: string } | 'unreadable';

export interface ClosingTextTurn extends ClosingTextWake {
  /** The runner's outcome for this turn. */
  result: {
    success: boolean;
    admitted?: boolean;
    wake?: { coalescedInto: string };
    finalTextResponse?: string;
    responses?: unknown[];
    sessionId?: string;
  };
  /** Read at the turn's start; absent when the start was never read. */
  boundary: TurnBoundary | undefined;
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

/** The conversation's newest message as the turn begins. */
export async function readTurnBoundary(
  dataComposer: DataComposer,
  threadId: string
): Promise<TurnBoundary> {
  const { data, error } = await dataComposer
    .getClient()
    .from('inbox_thread_messages')
    .select('created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return 'unreadable';
  const [newest] = (data ?? []) as Array<{ created_at: string }>;
  // The waking message is stored before its turn is dispatched, so an empty
  // conversation here is not one this turn can be judged against.
  return newest ? { createdAt: newest.created_at } : 'unreadable';
}

/**
 * The turn hooks a thread wake carries. `start` reads whether the target is
 * an inkling, and only then the conversation's boundary, so another SB's
 * turn costs one read. `end` decides and posts, and logs what it did.
 */
export function closingTextTurnHooks(
  dataComposer: DataComposer,
  wake: ClosingTextWake
): SessionTurnHooks {
  let inkling = false;
  let boundary: TurnBoundary | undefined;
  return {
    async start() {
      inkling = false;
      boundary = undefined;
      if (!wake.identityId || !wake.threadId) return;
      const { data, error } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('metadata')
        .eq('id', wake.identityId)
        .maybeSingle();
      // An identity that can't be read is judged again at the end, where a
      // missing boundary decides nothing.
      inkling =
        Boolean(error) ||
        (data as { metadata: Record<string, unknown> | null } | null)?.metadata?.client ===
          INKLING_CLIENT;
      if (inkling) boundary = await readTurnBoundary(dataComposer, wake.threadId);
    },
    async end(result) {
      if (!inkling) return;
      const outcome = await postClosingTextIfSilent(dataComposer, { ...wake, result, boundary });
      const where = { threadKey: wake.threadKey, wakingMessageId: wake.threadMessageId };
      if (outcome.posted) {
        logger.info('Posted an inkling turn closing text: the turn sent nothing itself', {
          ...where,
          messageId: outcome.messageId,
        });
      } else if ('error' in outcome) {
        logger.warn('Could not post an inkling turn closing text', {
          ...where,
          error: outcome.error,
        });
      } else if (outcome.skipped === 'unreadable') {
        logger.warn('Inkling closing text undecided: a read failed', where);
      }
    },
  };
}

const inFlight = new Set<string>();

export async function postClosingTextIfSilent(
  dataComposer: DataComposer,
  turn: ClosingTextTurn
): Promise<ClosingTextOutcome> {
  const { result, userId, identityId, threadId, threadKey, threadMessageId, boundary } = turn;
  const skip = (skipped: ClosingTextSkip): ClosingTextOutcome => ({ posted: false, skipped });

  if (!result.success || !result.admitted || result.wake) return skip('turn');
  // A reply routed for this turn is its reply, whether or not it has landed yet.
  if ((result.responses ?? []).length > 0) return skip('replied');
  const content = closingText(result.finalTextResponse);
  if (!content) return skip('empty');
  if (!identityId || !threadId || !threadKey || !threadMessageId) return skip('no-trigger');
  if (!boundary || boundary === 'unreadable') return skip('unreadable');

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
      .select('id, thread_id')
      .eq('id', threadMessageId)
      .maybeSingle();
    if (wakingError) return skip('unreadable');
    const waking = wakingRow as { thread_id: string } | null;
    if (!waking || waking.thread_id !== threadId) return skip('no-trigger');

    // This turn's own posts: the inkling's messages after the conversation's
    // newest one as the turn began.
    const { data: ownRows, error: ownError } = await supabase
      .from('inbox_thread_messages')
      .select('id')
      .eq('thread_id', threadId)
      .eq('sender_sb_id', identityId)
      .gt('created_at', boundary.createdAt)
      .limit(1);
    if (ownError) return skip('unreadable');
    if ((ownRows ?? []).length > 0) return skip('replied');

    const { data: earlierRows, error: earlierError } = await supabase
      .from('inbox_thread_messages')
      .select('id')
      .eq('thread_id', threadId)
      .eq('sender_sb_id', identityId)
      .eq(`metadata->>${CLOSING_TEXT_FOR}`, threadMessageId)
      .limit(1);
    if (earlierError) return skip('unreadable');
    if ((earlierRows ?? []).length > 0) return skip('already-posted');

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
