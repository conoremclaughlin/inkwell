/**
 * Shared identity resolution utility.
 *
 * Resolves an agent's canonical UUID from the agent_identities table
 * given a (user_id, agent_id) pair.  Used across all write paths
 * that store identity_id alongside the text agent_id slug.
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
    .select('id')
    .eq('user_id', userId)
    .eq('agent_id', agentId)
    .maybeSingle();

  if (error) {
    logger.warn('Failed to resolve identity UUID for agent slug', {
      userId,
      agentId,
      error: error.message,
    });
    return null;
  }

  return data?.id ?? null;
}
