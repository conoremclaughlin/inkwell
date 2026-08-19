import { getRequestContext, getSessionContext } from '../../utils/request-context.js';

/**
 * Server-derived sender routing context for a trigger payload.
 *
 * Everything here comes from the decoded `x-ink-context` token (or the
 * server's own session context), never from the caller's request body. Both
 * the session and studio claims are carried: routing cross-checks them
 * against the session row, because the token is unsigned and a lone studio
 * claim proves nothing on its own (spec §Tier 7, v5 trust boundary).
 *
 * A single helper because the gap this closes was *coverage*: caller-repo
 * inference silently degrades to refuse-and-hold on any dispatch path that
 * forgets to stamp it, and three of four paths had (Lumen, PR #514 round 1).
 */
export function senderRoutingContext(isBridge?: boolean): {
  senderStudioId?: string;
  senderSessionId?: string;
  senderIsBridge?: boolean;
} {
  const reqCtx = getRequestContext();
  const sessCtx = getSessionContext();
  const senderStudioId = reqCtx?.studioId || sessCtx?.studioId || undefined;
  const senderSessionId = reqCtx?.sessionId || sessCtx?.sessionId || undefined;
  return {
    ...(senderStudioId ? { senderStudioId } : {}),
    ...(senderSessionId ? { senderSessionId } : {}),
    ...(isBridge ? { senderIsBridge: true } : {}),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Is this identity a relay (Telegram/WhatsApp bridge, Discord/Slack bridge)?
 *
 * Read from `agent_identities.metadata.bridge`, deliberately rather than from
 * a hardcoded slug list: bridges are a property of the deployment, and slugs
 * are ambiguous across workspaces. A relay is ambiently "in" its own home
 * repo, never the repo a conversation is about, so caller-repo inference must
 * be skipped for one that did not address explicitly.
 *
 * Fails CLOSED toward "is a bridge" only on a clean negative — an unreadable
 * identity returns false, matching the rest of routing, where the cost of a
 * miss is a hold rather than a misroute.
 */
export async function isBridgeIdentity(
  supabase: any,
  userId: string,
  agentId?: string | null
): Promise<boolean> {
  if (!supabase || !agentId) return false;
  try {
    const { data } = await supabase
      .from('agent_identities')
      .select('metadata')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .maybeSingle();
    const meta = data?.metadata;
    return !!(
      meta &&
      typeof meta === 'object' &&
      (meta as Record<string, unknown>).bridge === true
    );
  } catch {
    return false;
  }
}
