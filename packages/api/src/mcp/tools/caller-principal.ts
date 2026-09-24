/**
 * Who is calling a thread tool, as a principal (spec inkmail-thread-scope §3).
 *
 * An MCP caller names itself by slug (`sbSlug`), pinned to the token when
 * the connection is bound to an identity. The canonical identity comes from
 * the request context's `sbId` when the token carries one; otherwise the
 * slug must resolve to exactly one workspace-scoped identity the user owns.
 * Zero or several is an error, not a guess: the thread a caller may see is
 * the one in ITS workspace, so an unresolved caller has no workspace to look
 * in (§1c: routing fails closed when a canonical principal cannot be
 * resolved).
 */

import { getRequestContext, getSessionContext } from '../../utils/request-context';
import { personalWorkspaceOf, resolveSbById, type SbPrincipal } from '../../services/principals';
import type { WorkspaceMemberRole } from '../../data/repositories/workspaces.repository';

/**
 * A caller's SB together with what it may do. An SB acts with its OWNER's
 * membership in the identity's workspace (spec inkmail-thread-scope §1):
 * an identity whose owner is no longer a member acts on nothing, and one
 * whose owner is a viewer reads but never writes. The identity row alone
 * used to be the whole check — a revoked member's SB kept reading and a
 * viewer's SB kept writing (Lumen, #621 P1).
 */
export interface CallerSb extends SbPrincipal {
  ownerRole: WorkspaceMemberRole;
}

/** Roles that may write to threads and the workspace namespace (§1, §6). */
const WRITE_ROLES: ReadonlySet<WorkspaceMemberRole> = new Set(['owner', 'admin', 'member']);

/** Refuses a write for a read-only role, naming the action. */
export function assertWriteRole(role: WorkspaceMemberRole, action: string): void {
  if (!WRITE_ROLES.has(role)) {
    throw new Error(`Your role in this workspace (${role}) cannot ${action}`);
  }
}

/** A person's role in a workspace — refused when they are not a member. */
export async function roleOfUserIn(
  client: Client,
  workspaceId: string,
  userId: string,
  who: string
): Promise<WorkspaceMemberRole> {
  const { data, error } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to check workspace membership for ${who}: ${error.message}`);
  }
  if (!data?.role) {
    throw new Error(`${who} cannot act in this workspace: not a member`);
  }
  return data.role as WorkspaceMemberRole;
}

async function withOwnerMembership(client: Client, sb: SbPrincipal): Promise<CallerSb> {
  const ownerRole = await roleOfUserIn(client, sb.workspaceId, sb.userId, `${sb.sbSlug}'s owner`);
  return { ...sb, ownerRole };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

interface IdentityRow {
  id: string;
  agent_id: string;
  user_id: string;
  workspace_id: string | null;
}

export async function resolveCallerSb(
  client: Client,
  userId: string,
  sbSlug: string
): Promise<CallerSb> {
  const reqCtx = getRequestContext() || getSessionContext();
  const ctxSbId = reqCtx?.sbId;
  if (ctxSbId) {
    const sb = await resolveSbById(client, ctxSbId);
    if (sb && sb.sbSlug === sbSlug) return withOwnerMembership(client, sb);
    // A token bound to one identity naming another slug is the mismatch
    // enforce-identity guards against; fall through to the owned-slug rule
    // only when the bound identity is gone.
    if (sb) {
      throw new Error(`Agent identity mismatch: token is ${sb.sbSlug}, call names ${sbSlug}`);
    }
  }
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', sbSlug)
    .not('workspace_id', 'is', null);
  if (error) {
    throw new Error(`Failed to resolve caller ${sbSlug}: ${error.message}`);
  }
  const rows = (data || []) as IdentityRow[];
  if (rows.length === 0) {
    throw new Error(`Unknown agent for user: ${sbSlug}. Register in agent_identities first.`);
  }
  if (rows.length > 1) {
    throw new Error(
      `Agent ${sbSlug} exists in ${rows.length} of your workspaces; the connection must be bound to one identity`
    );
  }
  const row = rows[0];
  return withOwnerMembership(client, {
    kind: 'sb',
    sbId: row.id,
    sbSlug: row.agent_id,
    userId: row.user_id,
    workspaceId: row.workspace_id as string,
  });
}

/**
 * The workspace a tool call acts in when the caller may be anonymous
 * (add_thread_participant's `addedBySlug` is optional): the named SB's
 * workspace, else the token-bound identity's, else the user's personal one
 * (§6: personal is the no-selection fallback).
 */
export async function resolveCallerWorkspace(
  client: Client,
  userId: string,
  sbSlug?: string | null
): Promise<{ workspaceId: string; sb: CallerSb | null; role: WorkspaceMemberRole }> {
  if (sbSlug) {
    const sb = await resolveCallerSb(client, userId, sbSlug);
    return { workspaceId: sb.workspaceId, sb, role: sb.ownerRole };
  }
  const reqCtx = getRequestContext() || getSessionContext();
  if (reqCtx?.sbId) {
    const bound = await resolveSbById(client, reqCtx.sbId);
    if (bound) {
      const sb = await withOwnerMembership(client, bound);
      return { workspaceId: sb.workspaceId, sb, role: sb.ownerRole };
    }
  }
  // The person themselves, in their personal workspace — whose membership
  // row still says what they may do there.
  const workspaceId = await personalWorkspaceOf(client, userId);
  const role = await roleOfUserIn(client, workspaceId, userId, 'You');
  return { workspaceId, sb: null, role };
}
