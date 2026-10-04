/**
 * Reactions on thread messages (ink://specs/inkling-reactions, v1).
 *
 * One emoji on one thread message, by a person or an SB named by id. A
 * reaction is not a message: nothing here writes a message row, touches a
 * thread or a read pointer, or wakes anyone. And a reaction is NEVER
 * approval: no gate verdict, permission grant, plan, send or purchase may
 * read one as consent. reactions-never-approval.test.ts holds the readers of
 * this table to the files that display or write reactions.
 *
 * Who may react: a member of the thread (a participant SB, or a person in
 * its `people`), in the caller's workspace. A person reading a thread they
 * are not in (a background thread) may see its reactions but not add one.
 * In an inkling's conversation the inkling gate also applies, to the
 * inkling as to its owner: it reacts only in a conversation it is already
 * in, with its owner and none but the owner's own inklings, the rule its
 * reply follows.
 *
 * The database holds what every writer must obey: each (message, reactor,
 * emoji) once, at most six emoji per reactor on one message (a trigger, so
 * two concurrent requests cannot both pass a count), and a reaction's thread
 * and workspace are its message's. See
 * supabase/migrations/20261004095944_thread_message_reactions.sql.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SbPrincipal, UserPrincipal } from '../principals';
import {
  assertInklingThreadAllowed,
  InklingThreadRefusedError,
} from '../inklings/inkling-thread-gate';

export const REACTIONS_TABLE = 'thread_message_reactions';

/** The six emoji the Inkling app offers. Any emoji isReactionEmoji accepts may be used. */
export const REACTION_CHOICES = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const;

/** At most this many distinct emoji per reactor on one message. */
export const REACTION_LIMIT_PER_REACTOR = 6;

/**
 * The token the guard trigger raises when a reactor is over the limit. The
 * migration spells it too; thread-reactions.test.ts reads the file to keep
 * the two in step.
 */
export const REACTION_LIMIT_TOKEN = 'reaction_limit_reached';

/** What SBs see beside reactions, and what react_to_message's description says. */
export const REACTIONS_ARE_NOT_APPROVAL =
  'A reaction is never approval of anything: a 👍 is not a yes.';

// A narrow client both the typed client and the test fakes satisfy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

export interface ReactorRef {
  kind: 'user' | 'sb';
  id: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactors: ReactorRef[];
  /** Whether the viewer is one of the reactors. */
  mine: boolean;
}

export interface ReactionRow {
  id: string;
  message_id: string;
  reactor_user_id: string | null;
  reactor_sb_id: string | null;
  emoji: string;
  created_at: string;
}

export type ReactionRefusalCode =
  | 'invalid_emoji'
  | 'invalid_message_id'
  | 'invalid_thread_key'
  | 'thread_not_found'
  | 'message_not_found'
  | 'not_a_member'
  | 'background_thread'
  | 'inkling_thread_refused'
  | 'inklings_disabled'
  | 'reaction_limit';

export type ReactionRefusalStatus = 400 | 403 | 404 | 409;

/** A refused reaction: the HTTP status the route answers with, and a stable code. */
export class ReactionRefusedError extends Error {
  constructor(
    readonly status: ReactionRefusalStatus,
    readonly code: ReactionRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'ReactionRefusedError';
  }
}

export function reactorOf(principal: UserPrincipal | SbPrincipal): ReactorRef {
  return principal.kind === 'sb'
    ? { kind: 'sb', id: principal.sbId }
    : { kind: 'user', id: principal.userId };
}

// ── The emoji ──

// The contract's rule, the same pattern the Inkling app uses
// (src/inkling/reactions.ts), so the two agree byte for byte: a regional-
// indicator flag pair, or a pictograph with at most one presentation
// selector and one skin tone, ZWJ-joined to more of the same. Every match is
// one grapheme under UAX #29 (GB9, GB11, GB12), so no separate count is
// needed. No text, keycaps, tag sequences or bidi controls.
const ONE_EMOJI =
  /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?(?:\u{200D}\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?)*)$/u;

/** One emoji under the contract's rule, at most 16 UTF-16 units. */
export function isReactionEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16 && ONE_EMOJI.test(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Reading ──

function rowReactor(row: ReactionRow): ReactorRef {
  return row.reactor_sb_id
    ? { kind: 'sb', id: row.reactor_sb_id }
    : { kind: 'user', id: row.reactor_user_id as string };
}

function byTimeThenId(a: ReactionRow, b: ReactionRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One message's reactions as the wire shape: one entry per emoji, sorted by
 * the time of its first reaction and then by the emoji, each with its
 * reactors in the order they reacted. `mine` is whether the viewer is among
 * them; no viewer means nobody's.
 */
export function summarizeReactions(
  rows: ReactionRow[],
  viewer: ReactorRef | null
): ReactionSummary[] {
  const groups = new Map<string, { firstAt: string; reactors: ReactorRef[] }>();
  for (const row of [...rows].sort(byTimeThenId)) {
    const group = groups.get(row.emoji);
    if (group) group.reactors.push(rowReactor(row));
    else groups.set(row.emoji, { firstAt: row.created_at, reactors: [rowReactor(row)] });
  }
  return [...groups.entries()]
    .sort(([emojiA, a], [emojiB, b]) => {
      if (a.firstAt !== b.firstAt) return a.firstAt < b.firstAt ? -1 : 1;
      return emojiA < emojiB ? -1 : emojiA > emojiB ? 1 : 0;
    })
    .map(([emoji, group]) => ({
      emoji,
      count: group.reactors.length,
      reactors: group.reactors,
      mine:
        viewer !== null && group.reactors.some((r) => r.kind === viewer.kind && r.id === viewer.id),
    }));
}

/** Message ids per request: each one rides the request URL. */
const MESSAGE_ID_CHUNK = 100;
/** Rows asked for per request. The server may cap it lower; see below. */
const ROWS_PER_PAGE = 1000;

/**
 * The reactions on each of these messages, for one viewer. Every id asked
 * about is in the result, `[]` when it has none.
 *
 * Pages until a page comes back empty. PostgREST caps a response at its
 * max-rows setting without saying so, and that cap may be below what was
 * asked for, so a short page is not proof that nothing is left.
 */
export async function loadReactions(
  client: Client,
  messageIds: string[],
  viewer: ReactorRef | null
): Promise<Map<string, ReactionSummary[]>> {
  const ids = [...new Set(messageIds)];
  const rowsByMessage = new Map<string, ReactionRow[]>(ids.map((id) => [id, []]));
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += MESSAGE_ID_CHUNK) {
    const chunk = ids.slice(i, i + MESSAGE_ID_CHUNK);
    for (let from = 0; ; ) {
      const { data, error } = await client
        .from(REACTIONS_TABLE)
        .select('id, message_id, reactor_user_id, reactor_sb_id, emoji, created_at')
        .in('message_id', chunk)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + ROWS_PER_PAGE - 1);
      if (error) throw new Error(`Failed to read reactions: ${error.message}`);
      const page = (data ?? []) as ReactionRow[];
      if (page.length === 0) break;
      for (const row of page) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rowsByMessage.get(row.message_id)?.push(row);
      }
      from += page.length;
    }
  }
  return new Map(
    [...rowsByMessage.entries()].map(([id, rows]) => [id, summarizeReactions(rows, viewer)])
  );
}

// ── Writing ──

export interface ReactRequest {
  /** The caller's workspace: a person's selected one, an SB's own. */
  workspaceId: string;
  threadKey: string;
  messageId: string;
  emoji: string;
  remove?: boolean;
  reactor: UserPrincipal | SbPrincipal;
}

export interface ReactResult {
  messageId: string;
  reactions: ReactionSummary[];
}

export interface ReactDeps {
  /** The inkling conversation gate; injectable so a test can stand in a later rule. */
  inklingGate?: typeof assertInklingThreadAllowed;
}

/**
 * Adds or removes one reaction and answers with the message's reactions as
 * the reactor sees them. Adding one that is already there, or removing one
 * that is not, changes nothing and answers the same way.
 *
 * Writes only thread_message_reactions: no message, no thread, no read
 * pointer, no trigger. The caller checks the workspace role first.
 */
export async function reactToMessage(
  client: Client,
  request: ReactRequest,
  deps: ReactDeps = {}
): Promise<ReactResult> {
  const { workspaceId, threadKey, messageId, emoji, reactor } = request;
  if (!threadKey) {
    throw new ReactionRefusedError(400, 'invalid_thread_key', 'threadKey is required');
  }
  if (!UUID_RE.test(messageId)) {
    throw new ReactionRefusedError(400, 'invalid_message_id', 'messageId must be a message id');
  }
  if (!isReactionEmoji(emoji)) {
    throw new ReactionRefusedError(400, 'invalid_emoji', 'emoji must be a single emoji');
  }

  const { data: thread, error: threadError } = await client
    .from('inbox_threads')
    .select('id, workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (threadError) throw new Error(`Failed to find the thread: ${threadError.message}`);
  if (!thread) {
    throw new ReactionRefusedError(404, 'thread_not_found', `No thread with key "${threadKey}"`);
  }
  const threadRow = thread as { id: string; workspace_id: string };

  const { data: message, error: messageError } = await client
    .from('inbox_thread_messages')
    .select('id')
    .eq('id', messageId)
    .eq('thread_id', threadRow.id)
    .maybeSingle();
  if (messageError) throw new Error(`Failed to find the message: ${messageError.message}`);
  if (!message) {
    throw new ReactionRefusedError(404, 'message_not_found', 'That message is not in this thread');
  }
  // The id as the database spells it. PostgreSQL takes a UUID in any case and
  // answers in lowercase, so everything after the lookup, the write, the
  // read-back and the answer, uses the row's id, never the request's.
  const canonicalMessageId = (message as { id: string }).id;

  // Members only. A person who is not in the thread is reading it in the
  // background, and a background thread stays read-only for them.
  const reactorColumn = reactor.kind === 'sb' ? 'sb_id' : 'user_id';
  const reactorId = reactor.kind === 'sb' ? reactor.sbId : reactor.userId;
  const { data: member, error: memberError } = await client
    .from('inbox_thread_participants')
    .select('thread_id')
    .eq('thread_id', threadRow.id)
    .eq(reactorColumn, reactorId)
    .maybeSingle();
  if (memberError) throw new Error(`Failed to check membership: ${memberError.message}`);
  if (!member) {
    throw reactor.kind === 'user'
      ? new ReactionRefusedError(
          403,
          'background_thread',
          'You are not in this conversation, so you cannot react in it'
        )
      : new ReactionRefusedError(403, 'not_a_member', 'Only a member of the thread can react');
  }

  const gate = deps.inklingGate ?? assertInklingThreadAllowed;
  try {
    await gate(client as unknown as SupabaseClient, {
      sender: reactor,
      participantSbs: [],
      existingThreadId: threadRow.id,
    });
  } catch (error) {
    if (error instanceof InklingThreadRefusedError) {
      throw new ReactionRefusedError(
        403,
        error.code === 'inklings_disabled' ? 'inklings_disabled' : 'inkling_thread_refused',
        error.message
      );
    }
    throw error;
  }

  const reactorColumns =
    reactor.kind === 'sb'
      ? { reactor_sb_id: reactor.sbId, reactor_user_id: null }
      : { reactor_user_id: reactor.userId, reactor_sb_id: null };
  if (request.remove) {
    const { error } = await client
      .from(REACTIONS_TABLE)
      .delete()
      .eq('message_id', canonicalMessageId)
      .eq(reactor.kind === 'sb' ? 'reactor_sb_id' : 'reactor_user_id', reactorId)
      .eq('emoji', emoji);
    if (error) throw new Error(`Failed to remove the reaction: ${error.message}`);
  } else {
    const { error } = await client.from(REACTIONS_TABLE).insert({
      message_id: canonicalMessageId,
      thread_id: threadRow.id,
      workspace_id: threadRow.workspace_id,
      ...reactorColumns,
      emoji,
    });
    if (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.message?.includes(REACTION_LIMIT_TOKEN)) {
        throw new ReactionRefusedError(
          409,
          'reaction_limit',
          `At most ${REACTION_LIMIT_PER_REACTOR} reactions per person on one message`
        );
      }
      // Gone between the lookup and the insert.
      if (failure.code === '23503') {
        throw new ReactionRefusedError(
          404,
          'message_not_found',
          'That message is not in this thread'
        );
      }
      // 23505: the reaction is already there, which is what was asked for.
      if (failure.code !== '23505') {
        throw new Error(`Failed to add the reaction: ${failure.message ?? 'unknown error'}`);
      }
    }
  }

  const reactions = await loadReactions(client, [canonicalMessageId], reactorOf(reactor));
  return {
    messageId: canonicalMessageId,
    reactions: reactions.get(canonicalMessageId) ?? [],
  };
}
