import { getRequestContext, getSessionContext } from '../../utils/request-context.js';
import { logger } from '../../utils/logger.js';

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
  agentId?: string | null,
  sbId?: string | null
): Promise<boolean> {
  if (!supabase) return false;
  if (!sbId && !agentId) return false;
  try {
    let query = supabase.from('agent_identities').select('metadata').eq('user_id', userId).limit(2);
    // Prefer the canonical UUID. A slug is ambiguous across workspaces, so
    // slug-only classification can read the WRONG identity's bridge flag
    // (Lumen, PR #514 round 2).
    query = sbId ? query.eq('id', sbId) : query.eq('agent_id', agentId);
    const { data, error } = await query;

    if (error) {
      // Fail toward "is a bridge", i.e. skip caller-repo inference. The two
      // outcomes are not symmetric: skipping inference costs a hold, which is
      // recoverable and loud, while a wrong inference routes a thread into a
      // relay's own worktree silently. Previously this returned false — the
      // dangerous direction — despite the comment claiming otherwise.
      logger.warn('[SenderContext] Bridge lookup failed; skipping caller-repo inference', {
        agentId: agentId || null,
        sbId: sbId || null,
        error: error.message,
      });
      return true;
    }

    if (!data?.length) return false;
    if (data.length > 1 && !sbId) {
      logger.warn('[SenderContext] Ambiguous sender slug; skipping caller-repo inference', {
        agentId,
      });
      return true;
    }

    const meta = data[0]?.metadata;
    return !!(
      meta &&
      typeof meta === 'object' &&
      (meta as Record<string, unknown>).bridge === true
    );
  } catch (err) {
    logger.warn('[SenderContext] Bridge lookup threw; skipping caller-repo inference', {
      agentId: agentId || null,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
