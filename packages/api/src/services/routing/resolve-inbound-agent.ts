/**
 * Inbound Agent Resolution
 *
 * Decides which SB handles an incoming channel message, by running the tiers in
 * precedence order and stopping at the first one that matches:
 *
 *   1. @mention      — a deliberate address written in the new message
 *   2. reply author  — the message being answered, for group and DM alike
 *   3. channel_routes — the configured default for this account/chat
 *   4. the server's AGENT_ID, when nothing above matched
 *
 * WHY THIS IS A MODULE. It used to be inline in the server bootstrap, where
 * each tier asked "is the slug still the default?" to decide whether an earlier
 * tier had matched. That is not the same question. A mention of the default SB,
 * or a reply to a message the default SB wrote, selects the default slug on
 * purpose — and the sentinel read that as "nothing matched", letting the next
 * tier overwrite a correct answer with a different SB. The distinction lives in
 * `source` here, so no tier has to infer it. The module has no import-time side
 * effects, so the cascade can be tested without starting a server.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import { resolveAgentFromMention } from './resolve-mention';
import { resolveReplyAuthorship, type ReplyAuthorshipFailure } from './resolve-reply-authorship';
import { resolveRouteSlug } from './resolve-route';

/** Which tier selected the SB. `default` means no tier matched. */
export type InboundAgentSource = 'mention' | 'reply' | 'channel_route' | 'default';

export interface InboundAgentResolution {
  sbSlug: string;
  sbId?: string;
  source: InboundAgentSource;
  studioHint: string | null;
  routeId: string | null;
  /** Present only when the message was a reply, so a misroute stays diagnosable. */
  replyRouting?: { resolved: true } | { resolved: false; reason: ReplyAuthorshipFailure };
}

export interface InboundAgentInput {
  supabase: SupabaseClient;
  userId: string;
  /** The server's AGENT_ID — used only when no tier matches. */
  defaultSlug: string;
  platform: string;
  conversationId: string;
  content: string;
  isGroupChat: boolean;
  mentionedUserIds?: string[];
  platformAccountId?: string;
  replyToMessageId?: string;
}

export async function resolveInboundAgent(
  input: InboundAgentInput
): Promise<InboundAgentResolution> {
  const {
    supabase,
    userId,
    defaultSlug,
    platform,
    conversationId,
    content,
    isGroupChat,
    mentionedUserIds = [],
    platformAccountId,
    replyToMessageId,
  } = input;

  // Tier 1 — @mention. Group chats only: in a DM there is one human and one
  // bot, so a name in the text is talking about an SB, not addressing one.
  // Always called for group chats, because text matching works even where the
  // platform has no native mentions (WhatsApp) or excludes the bot (Slack).
  if (isGroupChat) {
    const mention = await resolveAgentFromMention(supabase, userId, content, mentionedUserIds);
    if (mention) {
      logger.debug('[Route] Resolved agent from @mention', {
        platform,
        sbSlug: mention.sbSlug,
        sbId: mention.sbId,
      });
      return {
        sbSlug: mention.sbSlug,
        sbId: mention.sbId,
        source: 'mention',
        studioHint: null,
        routeId: null,
      };
    }
  }

  // Tier 2 — the message being replied to. All SBs share one bot, so a reply is
  // the only way to address a specific SB in a DM; without this tier it lands on
  // whoever owns the channel, silently.
  const authorship = await resolveReplyAuthorship(
    supabase,
    userId,
    platform,
    conversationId,
    replyToMessageId
  );

  if (authorship.resolved) {
    logger.info('[Route] Resolved agent from reply authorship', {
      platform,
      sbSlug: authorship.sbSlug,
      sbId: authorship.sbId,
      replyToMessageId,
    });
    return {
      sbSlug: authorship.sbSlug,
      sbId: authorship.sbId ?? undefined,
      source: 'reply',
      studioHint: null,
      routeId: null,
      replyRouting: { resolved: true },
    };
  }

  // Only noteworthy when the user actually replied to something. A non-reply
  // message failing to resolve is not a failure, and logging it would bury the
  // cases that are.
  if (authorship.reason !== 'no_reply_id') {
    logger.warn('[Route] Reply could not be attributed — falling through to channel_routes', {
      platform,
      conversationId,
      replyToMessageId,
      reason: authorship.reason,
    });
  }

  const replyRouting =
    authorship.reason === 'no_reply_id'
      ? undefined
      : ({ resolved: false, reason: authorship.reason } as const);

  // Tier 3 — the configured route for this account/chat.
  const route = await resolveRouteSlug(
    supabase,
    userId,
    platform,
    platformAccountId,
    conversationId
  );

  if (route) {
    logger.debug('[Route] Resolved agent from channel_routes', {
      platform,
      sbSlug: route.sbSlug,
      sbId: route.sbId,
      routeId: route.routeId,
      studioHint: route.studioHint,
    });
    return {
      sbSlug: route.sbSlug,
      sbId: route.sbId,
      source: 'channel_route',
      studioHint: route.studioHint,
      routeId: route.routeId,
      ...(replyRouting ? { replyRouting } : {}),
    };
  }

  logger.warn(
    `[Route] No channel_route found for ${platform}, falling back to AGENT_ID=${defaultSlug}`,
    {
      userId,
      platform,
      conversationId,
    }
  );

  return {
    sbSlug: defaultSlug,
    source: 'default',
    studioHint: null,
    routeId: null,
    ...(replyRouting ? { replyRouting } : {}),
  };
}
