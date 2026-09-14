/**
 * Shared identity resolution utility.
 *
 * Resolves an SB's canonical UUID from the agent_identities table given a
 * (user_id, agent_id) pair.  Used across all write paths that store sb_id
 * alongside the text agent_id slug.
 *
 * A slug is unique only *within a workspace* — the workspace is an SB's
 * identity boundary, and two workspaces may each legitimately have their own
 * "wren".  The schema says so: `agent_identities_user_workspace_agent_id_key`
 * is UNIQUE (user_id, workspace_id, agent_id).  So a slug lookup is only
 * well-formed when it is given the workspace to resolve inside of.  Without
 * one, a slug that exists in two workspaces has no single right answer, and
 * this resolver refuses rather than guessing — picking the most recently
 * updated row would silently attribute one SB's work to another.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { getRequestContext } from '../utils/request-context';
import { logger } from '../utils/logger';

interface IdentityCandidate {
  id: string;
  workspace_id: string | null;
}

/**
 * Resolve the canonical identity UUID for a slug inside a workspace.
 *
 * @param workspaceId The workspace to resolve the slug inside.  When omitted,
 *   the ambient request context's workspace is used — the server resolves that
 *   from the `x-ink-workspace-id` header or the caller's own identity, so tool
 *   handlers and repositories do not each have to thread it down by hand.
 *   Callers that already hold a workspace should pass it explicitly.
 */
export async function resolveIdentityId(
  supabase: SupabaseClient<Database>,
  userId: string,
  agentId: string,
  workspaceId?: string
): Promise<string | null> {
  const scope = workspaceId ?? getRequestContext()?.workspaceId;

  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', agentId);

  if (error) {
    logger.warn('Failed to resolve identity UUID for agent slug', {
      userId,
      agentId,
      workspaceId: scope,
      error: error.message,
    });
    return null;
  }

  const candidates = (data ?? []) as IdentityCandidate[];
  if (candidates.length === 0) return null;

  if (scope) {
    // At most one row can match exactly: UNIQUE (user_id, workspace_id, agent_id).
    const scoped = candidates.find((row) => row.workspace_id === scope);
    if (scoped) return scoped.id;

    // Legacy rows predating workspace scoping carry a NULL workspace and are not
    // yet claimed by any workspace.  At most one can exist:
    // `agent_identities_user_agent_null_workspace_key` is a partial UNIQUE on
    // (user_id, agent_id) WHERE workspace_id IS NULL.  Accept it so identities
    // that have not been backfilled keep resolving, and say so loudly.
    const unscoped = candidates.find((row) => row.workspace_id === null);
    if (unscoped) {
      logger.warn('Resolved agent slug to a legacy identity with no workspace', {
        userId,
        agentId,
        workspaceId: scope,
        identityId: unscoped.id,
        hint: 'Backfill agent_identities.workspace_id for this row',
      });
      return unscoped.id;
    }

    logger.warn('Agent slug does not exist in this workspace', {
      userId,
      agentId,
      workspaceId: scope,
      candidateWorkspaceCount: candidates.length,
    });
    return null;
  }

  if (candidates.length === 1) return candidates[0].id;

  // No workspace to resolve inside and more than one answer.  Refuse: choosing
  // between two SBs who share a slug is a coin flip, and the loser's memories,
  // activity and leases would be written under the winner's UUID.
  logger.error('Refusing to resolve an ambiguous agent slug without a workspace', {
    userId,
    agentId,
    candidateCount: candidates.length,
  });
  return null;
}

/**
 * Reverse lookup: resolve an agent slug from a canonical identity UUID.
 *
 * Unambiguous in the direction that matters — a UUID names exactly one row.
 */
export async function resolveAgentSlug(
  supabase: SupabaseClient<Database>,
  sbId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('agent_identities')
    .select('agent_id')
    .eq('id', sbId)
    .single();

  if (error) {
    logger.warn('Failed to resolve agent slug from identity UUID', {
      sbId,
      error: error.message,
    });
    return null;
  }

  return (data as { agent_id: string } | null)?.agent_id ?? null;
}
