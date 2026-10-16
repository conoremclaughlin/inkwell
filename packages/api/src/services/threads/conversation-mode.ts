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
 * Nothing reads the mode to decide anything yet. The shared-turn and read
 * rules that use it are later pieces of Phase 3.
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
