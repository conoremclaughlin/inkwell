/**
 * Shared identity resolution utility.
 *
 * Resolves an agent's canonical UUID from the agent_identities table
 * given a (user_id, agent_id) pair.  Used across all write paths
 * that store sb_id alongside the text agent_id slug.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { logger } from '../utils/logger';

export async function resolveIdentityId(
  supabase: SupabaseClient<Database>,
  userId: string,
  agentId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, workspace_id, updated_at')
    .eq('user_id', userId)
    .eq('agent_id', agentId)
    .order('updated_at', { ascending: false });

  if (error) {
    logger.warn('Failed to resolve identity UUID for agent slug', {
      userId,
      agentId,
      error: error.message,
    });
    return null;
  }

  if (!data || data.length === 0) return null;

  if (data.length > 1) {
    // Prefer workspace-scoped identities over legacy null workspace rows.
    const scoped = data.find((row) => row.workspace_id !== null);
    if (scoped) {
      logger.warn(
        'Resolved identity UUID from multiple candidates (preferred workspace-scoped row)',
        {
          userId,
          agentId,
          chosenIdentityId: scoped.id,
        }
      );
      return scoped.id;
    }
  }

  return data[0]?.id ?? null;
}
