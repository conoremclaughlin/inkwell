/**
 * A shared inkling conversation: a group its creator started with other
 * people of the space, beside the space's inkling (Conor, 2026-10-15: two
 * people in one group chat with the space's inkling).
 *
 * Only a team space (`workspaces.type = 'team'`) shares its inklings this
 * way. A personal space keeps the owner-only rule of inkling-thread-gate.ts
 * unchanged, and so does every conversation not created as a group: a member
 * never writes into the owner's 1:1 with its inkling. The inkling starter
 * mark (`metadata.starter`) does not tell them apart: awakening an inkling
 * gives any space the starter set, a team space included. The inkling still runs as an ordinary turn on
 * its owner's account; the space's people are who it answers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The thread-row metadata key that marks a conversation shared with the space's people. */
export const INKLING_SHARED_MARK = 'inklingShared';

/** Roles that may write in a space's conversations. Viewers read only. */
const WRITE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

export type SpaceProof = 'yes' | 'no' | 'unreadable';

/** Is this space a team space, not a person's own? */
export async function isSharedInklingSpace(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<SpaceProof> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('type')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) return 'unreadable';
  if (!data) return 'no';
  return (data as { type: string | null }).type === 'team' ? 'yes' : 'no';
}

/** Is every one of these people a member of the space with a role that writes? */
export async function areSpaceWriters(
  supabase: SupabaseClient,
  workspaceId: string,
  userIds: Iterable<string>
): Promise<SpaceProof> {
  const wanted = [...new Set([...userIds].map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return 'yes';
  const { data, error } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .in('user_id', wanted);
  if (error) return 'unreadable';
  const writers = new Set(
    ((data ?? []) as Array<{ user_id: string; role: string }>)
      .filter((row) => WRITE_ROLES.has(row.role))
      .map((row) => row.user_id.toLowerCase())
  );
  return wanted.every((id) => writers.has(id)) ? 'yes' : 'no';
}

/**
 * What an inkling's turn is told in a shared group with more than one
 * person: who is present, by display name, and that what someone said to it
 * privately stays private here. Null for any other conversation.
 */
export async function sharedGroupNote(
  supabase: SupabaseClient,
  input: { workspaceId: string | undefined; threadKey: string }
): Promise<string | null> {
  if (!input.workspaceId) return null;
  const { data: thread, error } = await supabase
    .from('inbox_threads')
    .select('id, metadata')
    .eq('workspace_id', input.workspaceId)
    .eq('thread_key', input.threadKey)
    .maybeSingle();
  if (error || !thread) return null;
  const row = thread as { id: string; metadata: Record<string, unknown> | null };
  if (row.metadata?.[INKLING_SHARED_MARK] !== true) return null;
  const { data: participants, error: participantError } = await supabase
    .from('inbox_thread_participants')
    .select('user_id')
    .eq('thread_id', row.id);
  if (participantError) return null;
  const userIds = ((participants ?? []) as Array<{ user_id: string | null }>)
    .map((p) => p.user_id)
    .filter((id): id is string => !!id);
  if (userIds.length < 2) return null;
  const { data: users } = await supabase
    .from('users')
    .select('id, first_name, last_name, username')
    .in('id', userIds);
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
    `This is a group conversation. People present: ${names.join(', ')}.`,
    'Each message names who sent it; answer that person, in front of everyone here.',
    'Something a person told you privately elsewhere stays private unless that person shares it here.',
  ].join('\n');
}
