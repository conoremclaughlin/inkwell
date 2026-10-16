/**
 * A person's pin on one of their threads.
 *
 * The pin is a column on the person's own participant row
 * (inbox_thread_participants.pinned; see
 * supabase/migrations/20261010203603_thread_participant_pins.sql), with three
 * states: null is no choice yet (the app applies its default pins), true is
 * pinned, false is unpinned on purpose.
 *
 * Writing it is one plain UPDATE filtered by the thread and the person, so a
 * person can only ever set their own pin, and only on a thread they are in.
 * A pin is not a message: it touches no thread row, read pointer or
 * recency, and wakes nobody. The caller checks the workspace role first.
 */

import { isParticipantOnlyThread } from './thread-read-access';

// A narrow client both the typed client and the test fakes satisfy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

export type PinRefusalCode =
  | 'invalid_thread_key'
  | 'invalid_pinned'
  | 'thread_not_found'
  | 'background_thread';

export type PinRefusalStatus = 400 | 403 | 404;

/** A refused pin: the HTTP status the route answers with, and a stable code. */
export class PinRefusedError extends Error {
  constructor(
    readonly status: PinRefusalStatus,
    readonly code: PinRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'PinRefusedError';
  }
}

export interface PinRequest {
  /** The person's selected workspace. */
  workspaceId: string;
  /** The person setting their own pin. */
  userId: string;
  threadKey: string;
  pinned: boolean | null;
}

export interface PinResult {
  threadKey: string;
  pinned: boolean | null;
}

/**
 * The request body, judged strictly: a non-empty threadKey string and a
 * `pinned` that is present and exactly true, false or null. Anything else,
 * a missing `pinned` included, is a 400 rather than a guess.
 */
export function parsePinBody(body: unknown): { threadKey: string; pinned: boolean | null } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const threadKey = typeof input.threadKey === 'string' ? input.threadKey.trim() : '';
  if (!threadKey) {
    throw new PinRefusedError(400, 'invalid_thread_key', 'threadKey is required');
  }
  const pinned = input.pinned;
  if (pinned !== true && pinned !== false && pinned !== null) {
    throw new PinRefusedError(400, 'invalid_pinned', 'pinned must be true, false or null');
  }
  return { threadKey, pinned };
}

/** Sets the person's pin on one thread in their workspace and answers with it. */
export async function setThreadPin(client: Client, request: PinRequest): Promise<PinResult> {
  const { workspaceId, userId, threadKey, pinned } = request;

  const { data: thread, error: threadError } = await client
    .from('inbox_threads')
    .select('id, metadata, conversation_mode')
    .eq('workspace_id', workspaceId)
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (threadError) throw new Error(`Failed to find the thread: ${threadError.message}`);
  if (!thread) {
    throw new PinRefusedError(404, 'thread_not_found', `No thread with key "${threadKey}"`);
  }
  const threadRow = thread as { id: string; metadata: unknown; conversation_mode: unknown };
  const threadId = threadRow.id;

  // The person's own row or nothing: no row matched means they are not in
  // this conversation (a background thread), and it stays theirs to read only.
  const { data: updated, error: updateError } = await client
    .from('inbox_thread_participants')
    .update({ pinned })
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .select('thread_id');
  if (updateError) throw new Error(`Failed to set the pin: ${updateError.message}`);
  if (!Array.isArray(updated) || updated.length === 0) {
    // A participant-only conversation (D3) is no thread at all to anyone
    // not in it.
    if (isParticipantOnlyThread(threadRow)) {
      throw new PinRefusedError(404, 'thread_not_found', `No thread with key "${threadKey}"`);
    }
    throw new PinRefusedError(
      403,
      'background_thread',
      'You are not in this conversation, so you cannot pin it'
    );
  }

  return { threadKey, pinned };
}
