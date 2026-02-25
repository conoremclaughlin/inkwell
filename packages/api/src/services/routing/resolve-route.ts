/**
 * Channel Route Resolution
 *
 * Resolves which agent should handle an incoming message based on the
 * channel_routes table. Uses a specificity cascade:
 *   1. Exact match: platform + account + chat
 *   2. Account default: platform + account (chat_id IS NULL)
 *   3. Platform default: platform only (both account + chat NULL)
 *
 * Returns null if no route matches — caller falls back to AGENT_ID env var.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export interface ResolvedRoute {
  agentId: string;
  identityId: string;
  routeId: string;
  studioId: string | null;
}

/**
 * Resolve which agent should handle a message on a given channel.
 *
 * Fetches all active routes for (user_id, platform), then picks the most
 * specific match in application code. This keeps the SQL simple and the
 * resolution logic testable.
 */
export async function resolveRouteAgentId(
  supabase: SupabaseClient,
  userId: string,
  platform: string,
  platformAccountId?: string,
  chatId?: string
): Promise<ResolvedRoute | null> {
  const { data: routes, error } = await supabase
    .from('channel_routes')
    .select(
      `
      id,
      platform_account_id,
      chat_id,
      identity_id,
      studio_id,
      agent_identities!inner ( agent_id )
    `
    )
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('is_active', true);

  if (error) {
    logger.error('[Route] Failed to query channel_routes', { error, userId, platform });
    return null;
  }

  if (!routes || routes.length === 0) {
    return null;
  }

  // Specificity cascade: exact > account > platform
  let bestMatch: (typeof routes)[number] | null = null;
  let bestScore = -1;

  for (const route of routes) {
    let score = 0;

    const routeAccountId = route.platform_account_id;
    const routeChatId = route.chat_id;

    // Platform match is implicit (filtered in query)

    // Account match
    if (routeAccountId != null) {
      if (platformAccountId && routeAccountId === platformAccountId) {
        score += 2;
      } else {
        continue; // Account specified but doesn't match — skip
      }
    }

    // Chat match
    if (routeChatId != null) {
      if (chatId && routeChatId === chatId) {
        score += 1;
      } else {
        continue; // Chat specified but doesn't match — skip
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = route;
    }
  }

  if (!bestMatch) {
    return null;
  }

  // Extract agent_id from the joined agent_identities
  const identityData = bestMatch.agent_identities as unknown as { agent_id: string };
  const agentId = identityData?.agent_id;

  if (!agentId) {
    logger.warn('[Route] Matched route but could not resolve agent_id from identity', {
      routeId: bestMatch.id,
      identityId: bestMatch.identity_id,
    });
    return null;
  }

  return {
    agentId,
    identityId: bestMatch.identity_id,
    routeId: bestMatch.id,
    studioId: (bestMatch as unknown as { studio_id: string | null }).studio_id ?? null,
  };
}
