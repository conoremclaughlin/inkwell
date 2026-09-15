/**
 * Reply-Based Agent Resolution
 *
 * Every SB reaches Conor through one Telegram bot, so the channel owner is the
 * only identity visible on an outgoing message. When he replies to a specific
 * message, the reply lands on whoever owns the channel — not on whoever wrote
 * the thing he is answering. This resolves the latter.
 *
 * The correlation key is the Telegram `message_id`: it is stamped onto the
 * `message_out` activity row when the message is sent, and it arrives back on
 * the inbound message as `reply_to_message.message_id`.
 *
 * That key is unique only WITHIN a chat (https://core.telegram.org/bots/api#message),
 * so the lookup is scoped to the conversation the reply arrived in. Without that
 * scope, id 4242 in one chat answers a reply to id 4242 in another and the result
 * is a confident wrong author — the failure mode this module exists to remove,
 * reintroduced one column over.
 *
 * This runs AFTER @mention resolution and BEFORE the channel_routes cascade.
 * A mention wins because it is a deliberate address written in the new message;
 * a reply is a strong signal but a older one.
 *
 * Never guesses. Every non-resolving path returns an explicit reason, because a
 * silent fall back to the channel owner is the behaviour this replaces — and it
 * is invisible precisely because it always produces a plausible recipient.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

/** Why a reply could not be attributed. Each is distinguishable by a caller. */
export type ReplyAuthorshipFailure =
  /** The inbound message was not a reply — nothing to resolve. */
  | 'no_reply_id'
  /** The reply arrived without a conversation to scope the lookup to. */
  | 'no_conversation_scope'
  /** No outgoing message with that platform id is on record in this conversation. */
  | 'no_matching_message'
  /** The message is on record but was logged before its author was known. */
  | 'unattributed_author'
  /** The lookup itself failed. Distinct from "nothing found". */
  | 'lookup_failed';

export type ReplyAuthorshipResult =
  | { resolved: true; sbSlug: string; sbId: string | null }
  | { resolved: false; reason: ReplyAuthorshipFailure };

/**
 * Every shape the same chat can be written in, on either side of the lookup.
 *
 * Inbound conversation ids arrive bare (`String(msg.chat.id)`), while an
 * outgoing send may be addressed as `telegram:<id>` and is stamped onto the row
 * verbatim. Comparing one form against the other finds nothing and reads as
 * "the user replied to a message we never sent", so match against both.
 */
function conversationCandidates(platform: string, conversationId: string): string[] {
  const prefix = `${platform}:`;
  const bare = conversationId.startsWith(prefix)
    ? conversationId.slice(prefix.length)
    : conversationId;
  if (!bare) return [];
  return [bare, `${prefix}${bare}`];
}

/**
 * Resolve which SB authored the message an inbound reply is answering.
 *
 * @param supabase - Supabase client
 * @param userId - The user who owns the conversation
 * @param platform - Channel the reply arrived on (e.g. 'telegram')
 * @param conversationId - Chat the reply arrived in; scopes the id lookup
 * @param replyToMessageId - Platform message id the user replied to, if any
 */
export async function resolveReplyAuthorship(
  supabase: SupabaseClient,
  userId: string,
  platform: string,
  conversationId: string | undefined,
  replyToMessageId: string | undefined
): Promise<ReplyAuthorshipResult> {
  if (!replyToMessageId) {
    return { resolved: false, reason: 'no_reply_id' };
  }

  const chatIds = conversationId ? conversationCandidates(platform, conversationId) : [];
  if (chatIds.length === 0) {
    // Unscoped, a platform message id is not unique. Refusing is the only safe
    // answer: matching without the chat would attribute whichever conversation
    // happened to reuse the number.
    return { resolved: false, reason: 'no_conversation_scope' };
  }

  const { data, error } = await supabase
    .from('activity_stream')
    .select('agent_id, sb_id, payload')
    .eq('user_id', userId)
    .eq('type', 'message_out')
    .eq('platform', platform)
    .eq('platform_message_id', replyToMessageId)
    .in('platform_chat_id', chatIds)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    // Distinguished from 'no_matching_message' on purpose: "we failed to look"
    // and "we looked and it is not there" are different facts, and collapsing
    // them is what lets a broken lookup read as an absent message.
    logger.error('[ReplyRoute] Failed to query activity_stream for reply authorship', {
      error,
      userId,
      platform,
      conversationId,
      replyToMessageId,
    });
    return { resolved: false, reason: 'lookup_failed' };
  }

  const row = data?.[0];
  if (!row) {
    return { resolved: false, reason: 'no_matching_message' };
  }

  // Rows written before the author was resolvable carry the channel owner's
  // slug as a display value. Routing on it would send the reply to the owner
  // while claiming it had identified an author — the exact failure this tier
  // exists to remove.
  const payload = row.payload as { authorship?: unknown } | null;
  if (payload?.authorship !== 'session') {
    return { resolved: false, reason: 'unattributed_author' };
  }

  if (!row.agent_id) {
    return { resolved: false, reason: 'unattributed_author' };
  }

  return { resolved: true, sbSlug: row.agent_id, sbId: row.sb_id ?? null };
}
