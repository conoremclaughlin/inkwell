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
