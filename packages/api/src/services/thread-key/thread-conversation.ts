/**
 * Conversation reads behind the threads chat view: the newest message of
 * every thread in the browse list, and the timeline paged backwards.
 *
 * Both are PostgREST reads with semantics the fake builders in route tests
 * cannot show (per-parent embed limits, filters that apply to the embed and
 * not the parent, compound cursors), so the query shapes live here where
 * thread-conversation.integration.test.ts runs them against a real database.
 */

/**
 * The newest message of each thread, embedded in the thread row under the
 * alias `last_message`. PostgREST applies the embed's order and limit PER
 * PARENT, so one request answers "latest message" for every thread in the
 * window, with no per-thread round trip and no migration.
 */
export const LAST_MESSAGE_EMBED =
  'last_message:inbox_thread_messages(id, sender_kind, sender_agent_id, sender_user_id, content, message_type, created_at)';

/**
 * How much of a message the browse list carries. The list only ever shows
 * one or two lines; the full body is a click away.
 */
export const PREVIEW_MAX_CHARS = 240;

/** Newest page size for a conversation, and the size of every older page. */
export const MESSAGES_PAGE_SIZE = 100;

/**
 * The three builder methods the helpers below call. Kept structural and
 * non-generic on purpose: checking a supabase-js builder type against a
 * self-referential constraint sends tsc into "excessively deep"
 * instantiation, and these helpers only ever return the builder they took.
 */
interface EmbedOrderable {
  order(column: string, options: { ascending: boolean; referencedTable: string }): EmbedOrderable;
  limit(count: number, options: { referencedTable: string }): EmbedOrderable;
  neq(column: string, value: unknown): EmbedOrderable;
}

/**
 * Narrow the `last_message` embed to the newest DELIVERABLE message. System
 * events (closed, reopened) are excluded for the same reason unread
 * candidacy excludes them: "wren closed the thread" is not something anyone
 * has left unread, and it makes a poor preview of the conversation.
 *
 * The filter is on the embed, so a thread whose only messages are system
 * events still comes back — with `last_message: []` — rather than vanishing
 * from the list.
 */
export function withLastMessage<Q>(query: Q): Q {
  return (query as unknown as EmbedOrderable)
    .neq('last_message.message_type', 'system')
    .order('created_at', { ascending: false, referencedTable: 'last_message' })
    .limit(1, { referencedTable: 'last_message' }) as unknown as Q;
}

export interface ThreadLastMessage {
  id: string;
  /** The author's principal kind (spec inkmail-thread-scope §3). */
  senderKind: 'sb' | 'user' | 'system';
  /** The SB's slug; for a person or the system, the kind. */
  senderSlug: string;
  /** Named for the viewer: the SB's slug, a person's name, or 'system'. */
  senderName: string;
  /** The viewer wrote it. */
  isOwn: boolean;
  messageType: string;
  /** Whitespace-collapsed and capped at PREVIEW_MAX_CHARS. */
  preview: string;
  createdAt: string;
}

interface LastMessageRow {
  id: string;
  sender_kind: string;
  sender_agent_id: string | null;
  sender_user_id: string | null;
  content: string | null;
  message_type: string;
  created_at: string;
}

/** Collapse whitespace and cap, ending on an ellipsis when cut. */
export function previewText(content: string, max: number = PREVIEW_MAX_CHARS): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function lastMessageRow(embed: unknown): LastMessageRow | undefined {
  return Array.isArray(embed) ? (embed as LastMessageRow[])[0] : undefined;
}

/** The person who wrote the embedded message, to be named with the rest. */
export function lastMessageUserIds(embed: unknown): string[] {
  const row = lastMessageRow(embed);
  return row?.sender_kind === 'user' && row.sender_user_id ? [row.sender_user_id] : [];
}

/**
 * The `last_message` embed as the list carries it. PostgREST answers a
 * to-many embed as an array; an empty one (no deliverable message yet) is
 * null here, never a fabricated preview. `describePerson` names a person
 * author for the viewer and says whether it is them — the same labelling
 * the conversation's own messages get.
 */
export function toLastMessage(
  embed: unknown,
  describePerson: (userId: string) => { name: string; isOwn: boolean }
): ThreadLastMessage | null {
  const row = lastMessageRow(embed);
  if (!row) return null;
  const senderKind: ThreadLastMessage['senderKind'] =
    row.sender_kind === 'sb' || row.sender_kind === 'user' ? row.sender_kind : 'system';
  const person =
    senderKind === 'user' && row.sender_user_id ? describePerson(row.sender_user_id) : null;
  return {
    id: row.id,
    senderKind,
    senderSlug: row.sender_agent_id ?? senderKind,
    senderName: person?.name ?? (senderKind === 'sb' ? (row.sender_agent_id ?? 'an SB') : 'system'),
    isOwn: person?.isOwn ?? false,
    messageType: row.message_type,
    preview: previewText(row.content ?? ''),
    createdAt: row.created_at,
  };
}

interface CursorFilterable {
  or(filters: string): CursorFilterable;
}

/**
 * Restrict a conversation query to messages strictly OLDER than the cursor
 * message. The cursor is compound — (created_at, id) — because two messages
 * can share a timestamp, and a created_at-only cursor would skip the
 * sibling that shares it. Pair with an order of created_at desc, id desc.
 *
 * Values are double-quoted: a timestamp carries characters ('+', ':') that
 * PostgREST's or() grammar would otherwise have to guess about.
 */
export function olderThan<Q>(query: Q, cursor: { id: string; createdAt: string }): Q {
  const at = `"${cursor.createdAt}"`;
  return (query as unknown as CursorFilterable).or(
    `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`
  ) as unknown as Q;
}
