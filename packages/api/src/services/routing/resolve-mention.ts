/**
 * Mention-Based Agent Resolution
 *
 * For group chats where multiple SBs may be present, resolves which agent
 * is being @mentioned. This runs BEFORE the channel_routes specificity
 * cascade, allowing per-message routing in shared channels.
 *
 * Resolution order:
 *   1. Check mentionedUsernames against agent identity names (case-insensitive)
 *   2. Check message text for agent name mentions (e.g., "hey wren, ...")
 *   3. Return null if no mention match — caller falls through to channel_routes
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export interface MentionResolvedAgent {
  agentId: string;
  identityId: string;
}

/**
 * Resolve which agent is being @mentioned in a group message.
 *
 * @param supabase - Supabase client
 * @param userId - The user who owns the agent identities
 * @param messageText - Raw message text (for text-based name matching)
 * @param mentionedUsernames - Platform-native @mentioned usernames (already resolved by listener)
 * @returns The matched agent, or null if no mention detected
 */
export async function resolveAgentFromMention(
  supabase: SupabaseClient,
  userId: string,
  messageText: string,
  mentionedUsernames: string[]
): Promise<MentionResolvedAgent | null> {
  // Fetch all agent identities for this user
  const { data: identities, error } = await supabase
    .from('agent_identities')
    .select('id, agent_id, name')
    .eq('user_id', userId);

  if (error) {
    logger.error('[Mention] Failed to query agent_identities', { error, userId });
    return null;
  }

  if (!identities || identities.length === 0) {
    return null;
  }

  // Normalize mentioned usernames to lowercase for comparison
  const mentionedLower = mentionedUsernames.map((u) => u.toLowerCase());

  // 1. Check mentionedUsernames against identity agent_id and name
  for (const identity of identities) {
    const agentIdLower = identity.agent_id.toLowerCase();
    const nameLower = identity.name?.toLowerCase();

    if (mentionedLower.includes(agentIdLower)) {
      logger.debug('[Mention] Matched by mentioned username → agent_id', {
        agentId: identity.agent_id,
        identityId: identity.id,
      });
      return { agentId: identity.agent_id, identityId: identity.id };
    }

    if (nameLower && mentionedLower.includes(nameLower)) {
      logger.debug('[Mention] Matched by mentioned username → name', {
        agentId: identity.agent_id,
        name: identity.name,
        identityId: identity.id,
      });
      return { agentId: identity.agent_id, identityId: identity.id };
    }
  }

  // 2. Check message text for agent names (word-boundary match)
  const textLower = messageText.toLowerCase();
  for (const identity of identities) {
    const agentId = identity.agent_id;
    const name = identity.name;

    // Match agent_id as a word boundary (e.g., "wren" but not "wrench")
    if (new RegExp(`\\b${escapeRegex(agentId)}\\b`, 'i').test(textLower)) {
      logger.debug('[Mention] Matched by text mention → agent_id', {
        agentId: identity.agent_id,
        identityId: identity.id,
      });
      return { agentId: identity.agent_id, identityId: identity.id };
    }

    // Match identity name as word boundary
    if (name && new RegExp(`\\b${escapeRegex(name)}\\b`, 'i').test(textLower)) {
      logger.debug('[Mention] Matched by text mention → name', {
        agentId: identity.agent_id,
        name,
        identityId: identity.id,
      });
      return { agentId: identity.agent_id, identityId: identity.id };
    }
  }

  return null;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
