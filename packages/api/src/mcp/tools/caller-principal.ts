/**
 * Who is calling a thread tool, as a principal (spec inkmail-thread-scope §3).
 *
 * An MCP caller names itself by slug (`agentId`), pinned to the token when
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
  agentId: string
): Promise<SbPrincipal> {
  const reqCtx = getRequestContext() || getSessionContext();
  const ctxSbId = reqCtx?.sbId;
  if (ctxSbId) {
    const sb = await resolveSbById(client, ctxSbId);
    if (sb && sb.agentId === agentId) return sb;
    // A token bound to one identity naming another slug is the mismatch
    // enforce-identity guards against; fall through to the owned-slug rule
    // only when the bound identity is gone.
    if (sb) {
      throw new Error(`Agent identity mismatch: token is ${sb.agentId}, call names ${agentId}`);
    }
  }
  const { data, error } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', agentId)
    .not('workspace_id', 'is', null);
  if (error) {
    throw new Error(`Failed to resolve caller ${agentId}: ${error.message}`);
  }
  const rows = (data || []) as IdentityRow[];
  if (rows.length === 0) {
    throw new Error(`Unknown agent for user: ${agentId}. Register in agent_identities first.`);
  }
  if (rows.length > 1) {
    throw new Error(
      `Agent ${agentId} exists in ${rows.length} of your workspaces; the connection must be bound to one identity`
    );
  }
  const row = rows[0];
  return {
    kind: 'sb',
    sbId: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    workspaceId: row.workspace_id as string,
  };
}

/**
 * The workspace a tool call acts in when the caller may be anonymous
 * (add_thread_participant's `addedByAgentId` is optional): the named SB's
 * workspace, else the token-bound identity's, else the user's personal one
 * (§6: personal is the no-selection fallback).
 */
export async function resolveCallerWorkspace(
  client: Client,
  userId: string,
  agentId?: string | null
): Promise<{ workspaceId: string; sb: SbPrincipal | null }> {
  if (agentId) {
    const sb = await resolveCallerSb(client, userId, agentId);
    return { workspaceId: sb.workspaceId, sb };
  }
  const reqCtx = getRequestContext() || getSessionContext();
  if (reqCtx?.sbId) {
    const sb = await resolveSbById(client, reqCtx.sbId);
    if (sb) return { workspaceId: sb.workspaceId, sb };
  }
  return { workspaceId: await personalWorkspaceOf(client, userId), sb: null };
}
