/**
 * Who may read a conversation (ink://specs/inkling-multi-person-groups, D3).
 *
 * A conversation that holds an inkling is marked `inklingConversation: true`
 * on its thread row, in the insert that creates it (INKLING_CONVERSATION_MARK).
 * Such a conversation is readable only by its participants: a person with a
 * row in inbox_thread_participants. A workspace role confers nothing here,
 * owner and admin included, and neither does a trusted user's access to the
 * workspace. Every other thread keeps its workspace-wide read.
 *
 * A reader who is not a participant learns nothing: the conversation is
 * answered exactly as a key with no thread is, and it is left out of every
 * list, count and preview, so its existence is not disclosed either.
 *
 * The rule is the thread's own mark, matched as JSON `true`, the same test
 * the inkling thread gate and the turn gate apply. The PostgREST filters
 * below say the same thing in the database's terms, so a list can leave a
 * conversation out before it takes its window, not after.
 */

import { INKLING_CONVERSATION_MARK } from '../inklings/inkling-thread-gate';

// A narrow client both the typed client and the test fakes satisfy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** The thread-row column a list selects to learn whether a row is participant-only. */
export const PARTICIPANT_ONLY_COLUMN = `participant_only:metadata->${INKLING_CONVERSATION_MARK}`;

/**
 * Threads every reader in the workspace may read: the mark is absent, or is
 * anything but JSON `true`. For `.or()` on an inbox_threads query.
 */
export const OPEN_THREADS_FILTER = `metadata->${INKLING_CONVERSATION_MARK}.is.null,metadata->${INKLING_CONVERSATION_MARK}.neq.true`;

/** The mark's path, for `.eq(PARTICIPANT_ONLY_PATH, true)` on an inbox_threads query. */
export const PARTICIPANT_ONLY_PATH = `metadata->${INKLING_CONVERSATION_MARK}`;

/** True when a thread row's metadata makes it readable only by its participants. */
export function isParticipantOnlyThread(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)[INKLING_CONVERSATION_MARK] === true
  );
}

/** Whether this person has a participant row on the thread. A failed read throws. */
export async function isThreadParticipant(
  supabase: Client,
  threadId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('inbox_thread_participants')
    .select('thread_id')
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .limit(1);
  if (error) throw new Error(`Failed to read the conversation's members: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Whether this person may read the thread: any thread that isn't
 * participant-only, and a participant-only one only as a participant.
 */
export async function mayReadThread(
  supabase: Client,
  thread: { id: string; metadata: unknown },
  userId: string
): Promise<boolean> {
  if (!isParticipantOnlyThread(thread.metadata)) return true;
  return isThreadParticipant(supabase, thread.id, userId);
}
