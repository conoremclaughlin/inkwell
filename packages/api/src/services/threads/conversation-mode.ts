/**
 * A conversation's mode (ink://specs/inkling-multi-person-groups, D8):
 * `inbox_threads.conversation_mode`, the thread's own persisted marker.
 *
 * - `'public'`: the space's members may read and join it.
 * - `'private'`: its participants only.
 * - NULL: every other thread. Inkwell's own threads, and a conversation
 *   created without a mode.
 *
 * Fixed at creation. It is written by the insert that creates the thread
 * (findOrCreateThread) and never after: turning a private conversation public
 * would republish it, so a different mode is a new conversation. No server
 * update path carries it (inbox-threads-conversation-mode-writes.test.ts).
 *
 * Only an inkling conversation takes one. A send that names a mode must
 * create its thread, and that thread must be an inkling conversation;
 * anything else is refused before anything is written.
 *
 * Who reads and writes by it (Conor, 2026-10-16 11:12 AM): a public inkling
 * conversation reads like an ordinary thread (thread-read-access.ts), and a
 * write-role member of a team space may start one or join it by posting
 * (the thread and turn gates). 'private' and no mode both read as private,
 * participant-only. A public conversation is made only in a team space.
 */

export const CONVERSATION_MODES = ['public', 'private'] as const;

export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/** The stable code a refused mode carries to the caller. */
export const CONVERSATION_MODE_REFUSED = 'conversation_mode_refused';

/** A send that named a mode it may not set: refused before anything is written. */
export class ConversationModeRefusedError extends Error {
  readonly code = CONVERSATION_MODE_REFUSED;

  constructor(message: string) {
    super(message);
    this.name = 'ConversationModeRefusedError';
  }
}

/**
 * A request's `mode`, judged strictly: absent (undefined or null) is no mode,
 * and anything but exactly 'public' or 'private' is refused rather than
 * guessed at.
 */
export function parseConversationMode(
  raw: unknown
): { ok: true; mode: ConversationMode | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, mode: null };
  return typeof raw === 'string' && (CONVERSATION_MODES as readonly string[]).includes(raw)
    ? { ok: true, mode: raw as ConversationMode }
    : { ok: false };
}

/** A stored value as the payload carries it: one of the modes, or null. */
export function storedConversationMode(value: unknown): ConversationMode | null {
  return typeof value === 'string' && (CONVERSATION_MODES as readonly string[]).includes(value)
    ? (value as ConversationMode)
    : null;
}

/** True when a thread row's mode opens it to its space. */
export function isPublicConversation(row: { conversation_mode?: unknown }): boolean {
  return row.conversation_mode === 'public';
}
