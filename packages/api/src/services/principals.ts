/**
 * Principals — who a thread row belongs to (spec inkmail-thread-scope §3).
 *
 * Every inbox thread row (message, participant, read pointer, creator,
 * closer) names its principal by kind: an SB by identity UUID, a person by
 * user UUID, or the system with no identity at all. Slugs are display and
 * routing hints resolved at the boundary — inside one workspace, to exactly
 * one identity — and never stored as authorship (§3: "prefer UUID, fall back
 * to slug" is a display rule, never a delivery rule; routing fails closed
 * when a canonical principal cannot be resolved).
 */

import { logger } from '../utils/logger';

export interface SbPrincipal {
  kind: 'sb';
  /** agent_identities.id — the canonical identity. */
  sbId: string;
  /** agent_identities.agent_id — the workspace-local slug, for display and routing. */
  sbSlug: string;
  /** agent_identities.user_id — the runtime owner (§1a: who the SB is spawned for). */
  userId: string;
  /** agent_identities.workspace_id — the one workspace this identity lives in. */
  workspaceId: string;
}

export interface UserPrincipal {
  kind: 'user';
  userId: string;
}

export interface SystemPrincipal {
  kind: 'system';
}

export type Principal = SbPrincipal | UserPrincipal | SystemPrincipal;

export const SYSTEM_PRINCIPAL: SystemPrincipal = { kind: 'system' };

export function userPrincipal(userId: string): UserPrincipal {
  return { kind: 'user', userId };
}

/** The one conflict key for participants and read pointers ('sb:<id>' | 'user:<id>'). */
export function principalKey(p: SbPrincipal | UserPrincipal): string {
  return p.kind === 'sb' ? `sb:${p.sbId}` : `user:${p.userId}`;
}

/** The sender columns of inbox_thread_messages for a principal. */
export function senderColumns(p: Principal): {
  sender_kind: 'sb' | 'user' | 'system';
  sender_sb_id: string | null;
  sender_user_id: string | null;
  sender_agent_id: string | null;
} {
  switch (p.kind) {
    case 'sb':
      return {
        sender_kind: 'sb',
        sender_sb_id: p.sbId,
        sender_user_id: null,
        sender_agent_id: p.sbSlug,
      };
    case 'user':
      return {
        sender_kind: 'user',
        sender_sb_id: null,
        sender_user_id: p.userId,
        sender_agent_id: null,
      };
    case 'system':
      return {
        sender_kind: 'system',
        sender_sb_id: null,
        sender_user_id: null,
        sender_agent_id: null,
      };
  }
}

/** The principal columns of inbox_thread_participants / inbox_thread_read_status. */
export function principalColumns(p: SbPrincipal | UserPrincipal): {
  sb_id: string | null;
  user_id: string | null;
} {
  return p.kind === 'sb' ? { sb_id: p.sbId, user_id: null } : { sb_id: null, user_id: p.userId };
}

/** A display label: the slug for an SB, 'user' for a person, 'system' otherwise. */
export function principalLabel(p: Principal): string {
  return p.kind === 'sb' ? p.sbSlug : p.kind;
}

export function isSb(p: Principal | null | undefined): p is SbPrincipal {
  return p?.kind === 'sb';
}

interface IdentityRow {
  id: string;
  agent_id: string;
  user_id: string;
  workspace_id: string | null;
}

// A client shape narrow enough for both the typed client and test fakes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

function toSb(row: IdentityRow): SbPrincipal {
  if (!row.workspace_id) {
    throw new Error(
      `Identity ${row.agent_id} (${row.id}) has no workspace and cannot take part in a thread`
    );
  }
  return {
    kind: 'sb',
    sbId: row.id,
    sbSlug: row.agent_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * Resolve a slug inside ONE workspace to exactly one identity (§1c: the
 * workspace-local slug is the boundary alias). Zero or several is an error,
 * not a guess — the cutover guarantees uniqueness of (workspace_id, agent_id),
 * so "several" means the database and this code disagree.
 */
export async function resolveSbInWorkspace(
  client: Client,
  workspaceId: string,
  sbSlug: string
): Promise<SbPrincipal> {
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', sbSlug);
  if (error) {
    throw new Error(`Failed to resolve ${sbSlug} in workspace ${workspaceId}: ${error.message}`);
  }
  const rows = (data || []) as IdentityRow[];
  if (rows.length === 0) {
    throw new Error(`Unknown recipient: ${sbSlug} (no identity in this workspace)`);
  }
  if (rows.length > 1) {
    logger.error('Ambiguous identity slug inside a workspace', { workspaceId, sbSlug });
    throw new Error(`Ambiguous recipient: ${sbSlug} names ${rows.length} identities here`);
  }
  return toSb(rows[0]);
}

/** Resolve several slugs in one workspace; fails closed on the first miss. */
export async function resolveSbsInWorkspace(
  client: Client,
  workspaceId: string,
  sbSlugs: string[]
): Promise<SbPrincipal[]> {
  const out: SbPrincipal[] = [];
  for (const slug of sbSlugs) {
    out.push(await resolveSbInWorkspace(client, workspaceId, slug));
  }
  return out;
}

/** Resolve a canonical identity id. NULL when it does not exist. */
export async function resolveSbById(client: Client, sbId: string): Promise<SbPrincipal | null> {
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('id', sbId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to resolve identity ${sbId}: ${error.message}`);
  }
  return data ? toSb(data as IdentityRow) : null;
}

/** Resolve many identity ids at once (for participant lists). Missing ids are skipped. */
export async function resolveSbsByIds(client: Client, sbIds: string[]): Promise<SbPrincipal[]> {
  if (sbIds.length === 0) return [];
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .in('id', sbIds);
  if (error) {
    throw new Error(`Failed to resolve identities: ${error.message}`);
  }
  return ((data || []) as IdentityRow[]).filter((r) => r.workspace_id).map(toSb);
}

/**
 * The workspace an SB session belongs to: sessions carry the canonical
 * `sb_id`, and an identity lives in exactly one workspace. This is the
 * server-resolved scope a regrant or a thread-home lookup uses — never a
 * caller-claimed value (Lumen, #616).
 */
export async function workspaceOfSb(client: Client, sbId: string): Promise<string | null> {
  const sb = await resolveSbById(client, sbId);
  return sb?.workspaceId ?? null;
}

/**
 * The workspace a user acts in when no explicit selection is made: their
 * personal one (§6: "personal only as the no-selection fallback"). Provisioned
 * by the database on user insert since the cutover.
 */
export async function personalWorkspaceOf(client: Client, userId: string): Promise<string> {
  const { data, error } = await client
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'personal')
    .eq('slug', 'personal')
    .is('archived_at', null)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to find the personal workspace of ${userId}: ${error.message}`);
  }
  if (!data?.id) {
    throw new Error(`User ${userId} has no personal workspace`);
  }
  return data.id as string;
}

/**
 * The one workspace-scoped identity a user owns under a slug — read from
 * the table alone, never from the request's bound identity. The server's
 * own sends resolve their recipient this way: inside an ambient SB request
 * the pin would otherwise be consulted and refuse a recipient that is not
 * the caller (Lumen, #624).
 */
export async function resolveSbOwnedBy(
  client: Client,
  userId: string,
  sbSlug: string
): Promise<SbPrincipal> {
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', sbSlug)
    .not('workspace_id', 'is', null);
  if (error) {
    throw new Error(`Failed to resolve ${sbSlug} for its owner: ${error.message}`);
  }
  const rows = (data || []) as IdentityRow[];
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `Unknown recipient: ${sbSlug} (no identity owned by this user)`
        : `Ambiguous recipient: ${sbSlug} exists in ${rows.length} of this user's workspaces`
    );
  }
  return toSb(rows[0]);
}

/** Is this user a member of the workspace (any role)? */
export async function isWorkspaceMember(
  client: Client,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const { data } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}
