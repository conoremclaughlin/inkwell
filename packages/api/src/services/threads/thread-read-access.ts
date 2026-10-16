/**
 * Who may read a conversation (ink://specs/inkling-multi-person-groups, D3,
 * and Conor, 2026-10-16 11:12 AM: "It's just a flag whether it's private or
 * public").
 *
 * A conversation that holds an inkling is marked `inklingConversation: true`
 * on its thread row, in the insert that creates it (INKLING_CONVERSATION_MARK).
 * Its mode (inbox_threads.conversation_mode, conversation-mode.ts) is fixed by
 * that same insert:
 * - `'public'`: readable by everyone the route admits to the workspace, like
 *   any ordinary thread, and joinable by posting.
 * - `'private'`, or no mode at all (every conversation made before modes,
 *   and any create that names none): readable only by its participants, a
 *   person with a row in inbox_thread_participants. A workspace role confers
 *   nothing here, owner and admin included, and neither does a trusted
 *   user's access to the workspace. A group made with other people of the
 *   space (`inklingShared`) is one of these unless it was created public.
 * Every other thread keeps its workspace-wide read.
 *
 * A reader who is not a participant of a private conversation learns
 * nothing: it is answered exactly as a key with no thread is, and it is left
 * out of every list, count and preview, so its existence is not disclosed
 * either.
 *
 * The mark is matched as JSON `true`, the same test the inkling thread gate
 * and the turn gate apply, and the mode as exactly `'public'`. The PostgREST
 * filters below say the same thing in the database's terms, so a list can
 * leave a conversation out before it takes its window, not after. A reader
 * that does not select the mode reads every inkling conversation as
 * private: the failure is a hidden thread, never a disclosed one.
 */

import { INKLING_SHARED_MARK } from '../inklings/inkling-shared-space';
import { INKLING_CONVERSATION_MARK } from '../inklings/inkling-thread-gate';
import { isPublicConversation } from './conversation-mode';

export { isPublicConversation };

// A narrow client both the typed client and the test fakes satisfy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

/** The mode that opens an inkling conversation to its space. */
const PUBLIC = 'public';

/**
 * The thread-row columns a list selects to judge a row with
 * isParticipantOnlyRow: the inkling mark, as JSON, and the mode.
 */
export const READ_ACCESS_COLUMNS = `inkling_conversation:metadata->${INKLING_CONVERSATION_MARK}, conversation_mode`;

/** What READ_ACCESS_COLUMNS projects onto a row. */
export interface ReadAccessColumns {
  inkling_conversation?: unknown;
  conversation_mode?: unknown;
}

/**
 * Threads every reader in the workspace may read: the inkling mark is absent
 * or anything but JSON `true`, or the conversation is public. For `.or()` on
 * an inbox_threads query.
 */
export const OPEN_THREADS_FILTER = `metadata->${INKLING_CONVERSATION_MARK}.is.null,metadata->${INKLING_CONVERSATION_MARK}.neq.true,conversation_mode.eq.${PUBLIC}`;

/** The mark's path, for `.eq(PARTICIPANT_ONLY_PATH, true)` on an inbox_threads query. */
export const PARTICIPANT_ONLY_PATH = `metadata->${INKLING_CONVERSATION_MARK}`;

/**
 * Leaves out public conversations, for `.or()` beside
 * `.eq(PARTICIPANT_ONLY_PATH, true)`: together they select the
 * participant-only conversations. A read of a viewer's own participant-only
 * conversations needs it, or a public one the viewer is in would arrive
 * from it and from the open read both.
 */
export const NOT_PUBLIC_FILTER = `conversation_mode.is.null,conversation_mode.neq.${PUBLIC}`;

/**
 * The thread-row column a list selects to learn whether a row is a group
 * chat created with other people of the space (INKLING_SHARED_MARK). It
 * says what kind of chat it is, for the wire; who reads it is decided by
 * the mode, as for every inkling conversation.
 */
export const SHARED_GROUP_COLUMN = `inkling_shared:metadata->${INKLING_SHARED_MARK}`;

/** True when a thread row's metadata marks a group chat created with other people. */
export function isSharedGroupThread(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)[INKLING_SHARED_MARK] === true
  );
}

/** isSharedGroupThread, for a row read with SHARED_GROUP_COLUMN. */
export function isSharedGroupRow(row: { inkling_shared?: unknown }): boolean {
  return row.inkling_shared === true;
}

/**
 * True when a thread row makes it readable only by its participants: an
 * inkling conversation that is not public. The row must carry its mode
 * (`conversation_mode`), or the conversation reads as private.
 */
export function isParticipantOnlyThread(row: {
  metadata: unknown;
  conversation_mode: unknown;
}): boolean {
  const metadata = row.metadata;
  const inklingConversation =
    !!metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)[INKLING_CONVERSATION_MARK] === true;
  return inklingConversation && !isPublicConversation(row);
}

/** isParticipantOnlyThread, for a row read with READ_ACCESS_COLUMNS. */
export function isParticipantOnlyRow(row: ReadAccessColumns): boolean {
  return row.inkling_conversation === true && !isPublicConversation(row);
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
  thread: { id: string; metadata: unknown; conversation_mode: unknown },
  userId: string
): Promise<boolean> {
  if (!isParticipantOnlyThread(thread)) return true;
  return isThreadParticipant(supabase, thread.id, userId);
}
