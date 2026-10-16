/**
 * What an inkling's turn is told about who can read the conversation it is
 * answering in, and what it may repeat there
 * (ink://specs/inkling-multi-person-groups, D3 and D4), appended to the
 * trigger that wakes it.
 *
 * Conor, 2026-10-16: an inkling keeps its memory of everyone in its space,
 * and is prompted heavily not to share what someone disclosed to it. So the
 * rule is told, not enforced by any read:
 * - In a group shared with the space's people (inkling-shared-space.ts),
 *   only the people in it read it (thread-read-access.ts), and nothing
 *   private anyone told the inkling belongs in it unless that person says so.
 * - Every other inkling conversation is private to the people in it (D3),
 *   so what is said there is remembered as private, with who said it (D4).
 *
 * Told only to an SB on the conversation, like the thread's descriptor:
 * who is in a group is told only to the group's own inkling (Lumen's review
 * of 4f7896e6).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { INKLING_SHARED_MARK } from './inkling-shared-space';
import { INKLING_CONVERSATION_MARK } from './inkling-thread-gate';

/** The rule for a group chat: what anyone told the inkling stays theirs to share. */
export const GROUP_PRIVACY_RULE = [
  'Never share personal things someone told you, especially in a private chat, unless that person is the one asking here or has said you may. That covers health, relationships, money, trouble at work, family, and anything they called private.',
  "If you aren't sure whether something is private, leave it out here, and ask that person privately the next time you talk with them alone.",
  "When you leave something private out, answer as you would if you'd never heard it. Don't say or hint that you're keeping something back.",
  'What you know about people can still help, such as their preferences when you plan something together, as long as no private detail shows.',
].join('\n');

/** The rule for a conversation only its people can read. */
export const PRIVATE_CONVERSATION_NOTE = [
  'This conversation is private: only the people in it can read it.',
  'When you remember something from it, note who told you and that they told you privately.',
  "Don't repeat personal things from here in a group, or to anyone else, unless that person asks you to or says you may.",
].join('\n');

/**
 * The note for one inkling conversation, or null: for any other thread, and
 * for a recipient that is not one of its participants.
 */
export async function inklingConversationNote(
  supabase: SupabaseClient,
  input: { workspaceId: string | undefined; threadKey: string; recipientSbId: string | undefined }
): Promise<string | null> {
  if (!input.workspaceId || !input.recipientSbId) return null;
  const { data: thread, error } = await supabase
    .from('inbox_threads')
    .select('id, metadata')
    .eq('workspace_id', input.workspaceId)
    .eq('thread_key', input.threadKey)
    .maybeSingle();
  if (error || !thread) return null;
  const row = thread as { id: string; metadata: Record<string, unknown> | null };
  const shared = row.metadata?.[INKLING_SHARED_MARK] === true;
  if (!shared && row.metadata?.[INKLING_CONVERSATION_MARK] !== true) return null;
  const { data: participants, error: participantError } = await supabase
    .from('inbox_thread_participants')
    .select('sb_id, user_id')
    .eq('thread_id', row.id);
  if (participantError) return null;
  const rows = (participants ?? []) as Array<{ sb_id: string | null; user_id: string | null }>;
  if (!rows.some((p) => p.sb_id === input.recipientSbId)) return null;
  if (!shared) return PRIVATE_CONVERSATION_NOTE;

  const userIds = rows.map((p) => p.user_id).filter((id): id is string => !!id);
  const { data: users } =
    userIds.length > 0
      ? await supabase.from('users').select('id, first_name, last_name, username').in('id', userIds)
      : { data: [] };
  const names = userIds.map((id) => {
    const user = (
      (users ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        username: string | null;
      }>
    ).find((u) => u.id === id);
    // Never an email address: the group reads what the inkling says.
    const full = [user?.first_name, user?.last_name]
      .map((part) => (part ?? '').trim())
      .filter(Boolean)
      .join(' ');
    return full || (user?.username ?? '').trim() || 'a member of this space';
  });
  return [
    names.length > 0
      ? `This is a group chat. Only the people here can read it: ${names.join(', ')}.`
      : 'This is a group chat. Only the people here can read it.',
    'Each message names who sent it; answer that person, in front of everyone here.',
    GROUP_PRIVACY_RULE,
  ].join('\n');
}
