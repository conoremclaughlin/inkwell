/**
 * Who is calling, and which session are they actually running in?
 *
 * Two questions every write that stamps a session onto a record has to answer,
 * and answer the same way. The session tools (update_session_state, get_session,
 * end_session, compact_session, remember) answered them here under
 * memory-handlers; send_response answered them by trusting whatever the request
 * context said. That second answer stamped an unchecked `x-ink-context` session
 * onto `message_out` rows — a legacy agent token could name another user's,
 * identity's or contact's session, and a nonexistent id failed the activity
 * insert after the message had already gone out (Lumen, PR #596).
 *
 * So the identity and the authorization rule live in one module, and every
 * caller that turns "the session named by my request" into a stored session id
 * goes through `loadAuthorizedAmbientSession`. There is no second copy to drift.
 */

import type { DataComposer } from '../../data/composer';
import type { Session } from '../../data/models/memory';
import { logger } from '../../utils/logger';
import {
  getPinnedAgentId,
  getRequestContext,
  getSessionContext,
} from '../../utils/request-context';

/**
 * The identity behind the current call.
 *
 * `sbId` is the canonical `agent_identities.id`. `agentId` is the slug, which is
 * unique only per (user_id, workspace_id) — two identities named "wren" in
 * different workspaces collide, so the slug alone is not an ownership predicate.
 * `agentBound` distinguishes an SB's token from a human user/admin token, which
 * retains same-user repair authority that agents deliberately do not get.
 */
export interface CallerIdentity {
  sbId?: string;
  agentId?: string;
  /**
   * Contact scope the caller is confined to; undefined means owner scope
   * (sessions with no contact). Never taken from a tool parameter — a caller
   * that could name its own contact scope could name someone else's.
   */
  contactId?: string;
  agentBound: boolean;
}

/**
 * The authenticated identity behind this call, from verified sources only.
 *
 * Three things here are deliberate, and each one was a hole:
 *
 * 1. On HTTP the bearer token is the ONLY authentication fact. `ctx.agentId`
 *    and `ctx.sbId` may have been enriched from the caller's ambient session
 *    so routing and workspace derivation work for ink-routed user-token calls;
 *    that is a hint, not a credential. Authorization reads `tokenAgentId` /
 *    `tokenSbId`, captured before enrichment.
 * 2. `callerProfile` is NOT an agent-bound signal — it defaults to 'agent' on
 *    every HTTP request, including web-dashboard user tokens.
 * 3. `explicitAgentId` never confers agent authority. It previously flowed
 *    through `getEffectiveAgentId()`, which returns the caller's own value
 *    whenever no identity is pinned, so a request with no verified identity
 *    could name any agent it liked. It survives only as attribution on
 *    non-agent-bound calls.
 */
export function resolveCallerIdentity(explicitAgentId?: string): CallerIdentity {
  const ctx = getRequestContext();

  if (ctx) {
    if (ctx.agentTokenBound) {
      return {
        sbId: ctx.tokenSbId,
        agentId: ctx.tokenAgentId,
        // The SIGNED claim, never ctx.contactId — that one comes from the
        // unsigned x-ink-context header.
        contactId: ctx.tokenContactId,
        agentBound: true,
      };
    }
    // User/admin token: keeps same-user repair authority.
    return { agentId: explicitAgentId, agentBound: false };
  }

  // stdio: one session per process, so bootstrap's pin is the identity.
  const pinned = getPinnedAgentId();
  if (!pinned) return { agentId: explicitAgentId, agentBound: false };

  const sess = getSessionContext();
  return {
    sbId: sess?.agentId === pinned ? sess.sbId : undefined,
    agentId: pinned,
    contactId: sess?.contactId,
    agentBound: true,
  };
}

/**
 * The session the caller is actually running in.
 *
 * Prefers the signed token claim over the `x-ink-context` header. The header
 * still serves callers whose token predates the claim, but it is a caller
 * assertion, so the session it names is authorized before use either way.
 */
export function ambientSessionId(): string | undefined {
  const ctx = getRequestContext();
  return ctx?.tokenSessionId ?? ctx?.sessionId;
}

/**
 * Decide whether `caller` may act on `session`.
 *
 * Same-user is the floor and is never waived — the server repository runs as the
 * service role, so RLS will not stop a cross-user UUID and this check is the only
 * thing that does. Agent-bound callers are further confined to their own identity:
 * naming a peer's session is not an authorization primitive (repairing another
 * agent's row is a user/admin action, not something an SB grants itself).
 */
export function isIdentityAuthorized(
  session: Session,
  userId: string,
  caller: CallerIdentity
): boolean {
  if (session.userId !== userId) return false;
  if (!caller.agentBound) return true;

  if (session.sbId) {
    // The target names a canonical owner, so only a canonical caller can match
    // it. Falling back to the slug when the CALLER lacks an sbId would reopen
    // the collision this check exists to close: agent-bound tokens without a
    // canonical claim are valid today, and "wren" in two workspaces is two
    // different identities wearing the same name.
    return !!caller.sbId && session.sbId === caller.sbId;
  }

  // The target row predates sb_id, so the slug is the only identity it carries.
  return !!caller.agentId && session.agentId === caller.agentId;
}

/**
 * Decide whether `caller` may act on `session`.
 *
 * Same-user is the floor and is never waived — the server repository runs as the
 * service role, so RLS will not stop a cross-user UUID and this check is the only
 * thing that does. Agent-bound callers are further confined to their own identity
 * AND their own contact scope: naming a peer's session is not an authorization
 * primitive (repairing another agent's row is a user/admin action, not something
 * an SB grants itself), and one SB identity serves many contacts, so identity
 * alone does not keep two conversations apart.
 *
 * The contact comparison is symmetric on purpose. A contact-scoped caller cannot
 * reach an owner session and an owner-scoped caller cannot reach a contact
 * session, which mirrors how `findOwnedActiveSessions` already treats the two as
 * disjoint sets rather than a hierarchy.
 */
export function isSessionAuthorized(
  session: Session,
  userId: string,
  caller: CallerIdentity
): boolean {
  if (!isIdentityAuthorized(session, userId, caller)) return false;
  if (!caller.agentBound) return true;
  return (session.contactId ?? null) === (caller.contactId ?? null);
}

/** Why the ambient session could not be used. */
export type AmbientSessionFailure =
  | 'no-ambient-session'
  | 'not-found'
  | 'unauthorized'
  | 'lookup-failed';

export type AmbientSessionResult =
  | { session: Session; reason?: undefined }
  | { session: null; reason: AmbientSessionFailure };

/**
 * Load the session the request context names and authorize it for `caller`.
 *
 * Both forms the context can carry go through here — the signed token claim
 * and the unsigned header assertion — because the check costs one primary-key
 * read and buys the same guarantee for both: the row exists, it belongs to
 * `userId`, and (for an agent-bound caller) to the caller's own identity and
 * contact scope. Anything else yields `null` with the reason, never a guess.
 * Callers decide what a null means for them: the session tools fall through to
 * an identity-scoped lookup; attribution-only callers stamp nothing.
 */
export async function loadAuthorizedAmbientSession(
  dataComposer: DataComposer,
  userId: string,
  caller: CallerIdentity
): Promise<AmbientSessionResult> {
  const ambientId = ambientSessionId();
  if (!ambientId) return { session: null, reason: 'no-ambient-session' };

  let session: Session | null;
  try {
    session = await dataComposer.repositories.memory.getSession(ambientId);
  } catch (error) {
    logger.warn('Failed to load the ambient session; falling back to lookup', {
      contextSessionId: ambientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { session: null, reason: 'lookup-failed' };
  }

  if (!session) {
    logger.warn('Ambient sessionId names no session', { contextSessionId: ambientId });
    return { session: null, reason: 'not-found' };
  }

  if (!isSessionAuthorized(session, userId, caller)) {
    logger.warn('Ignoring ambient sessionId that does not belong to the caller', {
      contextSessionId: ambientId,
      sessionSbId: session.sbId,
      sessionAgentId: session.agentId,
      callerSbId: caller.sbId,
      callerAgentId: caller.agentId,
    });
    return { session: null, reason: 'unauthorized' };
  }

  return { session };
}

export type AttributedSession =
  | { sessionId: string; via: 'token' | 'header' }
  | { sessionId: undefined; reason: 'no-request-context' | 'no-user' | AmbientSessionFailure };

/**
 * The session to stamp onto a record produced by this request — or nothing.
 *
 * For attribution, absent provenance beats wrong provenance: a null session id
 * is a legible hole, a foreign one is indistinguishable from an answer and
 * corrupts exactly the evidence a reader would use to notice. So this never
 * falls back to a lookup and never returns an id it has not loaded and
 * authorized. Outside a request (stdio, heartbeats) there is nothing to
 * attribute and the caller logs null, as it always has.
 */
export async function resolveAttributedSession(
  dataComposer: DataComposer
): Promise<AttributedSession> {
  const ctx = getRequestContext();
  if (!ctx) return { sessionId: undefined, reason: 'no-request-context' };
  if (!ctx.userId) return { sessionId: undefined, reason: 'no-user' };

  const caller = resolveCallerIdentity();
  const ambient = await loadAuthorizedAmbientSession(dataComposer, ctx.userId, caller);
  if (!ambient.session) return { sessionId: undefined, reason: ambient.reason };

  return { sessionId: ambient.session.id, via: ctx.tokenSessionId ? 'token' : 'header' };
}
