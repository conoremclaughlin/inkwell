import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { logger } from './logger';

/**
 * What to do when an agent slug maps to more than one workspace.
 *
 * Read paths ('warn') degrade to "no workspace context" and let the caller fall
 * back. Write paths ('throw') refuse, because picking one of two workspaces to
 * write into is how a row ends up in the wrong one.
 */
export type AmbiguousWorkspaceBehavior = 'warn' | 'throw';

export interface DeriveWorkspaceIdFromAgentParams {
  supabase: SupabaseClient<Database>;
  userId: string;
  agentId: string;
  /** Defaults to 'warn' — the safe choice for read paths. */
  onAmbiguous?: AmbiguousWorkspaceBehavior;
  /** Log context so ambiguity warnings say which call site hit it. */
  origin?: string;
}

/**
 * The workspace an agent slug belongs to, derived from its identity rows.
 *
 * Rows whose workspace_id is NULL are ignored rather than counted. A NULL row
 * is an orphan (see resolveWorkspaceForIdentityWrite in identity-handlers), and
 * letting one vote here would turn a repairable duplicate into an agent with no
 * derivable workspace at all.
 */
export async function deriveWorkspaceIdFromAgent({
  supabase,
  userId,
  agentId,
  onAmbiguous = 'warn',
  origin,
}: DeriveWorkspaceIdFromAgentParams): Promise<string | null> {
  const { data, error } = await supabase
    .from('agent_identities')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', agentId);

  if (error) {
    logger.warn('Failed to derive workspace from agent identity', {
      userId,
      agentId,
      origin,
      error: error.message,
    });
    return null;
  }

  const workspaceIds = Array.from(
    new Set(
      (data || [])
        .map((row) => row.workspace_id)
        .filter((workspaceId): workspaceId is string => typeof workspaceId === 'string')
    )
  );

  if (workspaceIds.length === 1) return workspaceIds[0];

  if (workspaceIds.length > 1) {
    if (onAmbiguous === 'throw') {
      throw new Error(
        `Workspace is ambiguous for agent "${agentId}". Provide workspaceId or X-PCP-Workspace-Id.`
      );
    }
    logger.warn('Ambiguous workspace mapping for agent identity', {
      userId,
      agentId,
      origin,
      workspaceCount: workspaceIds.length,
    });
  }

  return null;
}
