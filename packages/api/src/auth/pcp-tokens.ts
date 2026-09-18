/**
 * Shared PCP Token Utilities
 *
 * Self-issued JWT operations used by both MCP auth and admin dashboard auth.
 * All verification is local (jwt.verify with JWT_SECRET) — no network calls.
 * Refresh tokens are opaque strings backed by the mcp_tokens table.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  DAY_MS,
  REFRESH_ABSOLUTE_DAYS,
  REFRESH_RETRY_OVERLAP_SECONDS,
  effectiveGrantDeadline,
  isWithinRetryOverlap,
} from './refresh-policy';

// Re-exported so callers and tests have one import site for the token module's
// own surface. Modules that only need the policy (admin routes, the OAuth
// provider) import './refresh-policy' directly — many suites mock this module
// wholesale, and every export added here becomes a broken mock in one of them.
export {
  DAY_MS,
  REFRESH_ABSOLUTE_DAYS,
  REFRESH_RETRY_OVERLAP_SECONDS,
  effectiveGrantDeadline,
  isWithinRetryOverlap,
} from './refresh-policy';
import type { Database } from '../data/supabase/types';

// ============================================================================
// Types
// ============================================================================

export interface PcpTokenPayload {
  type: 'mcp_access' | 'pcp_admin';
  sub: string; // PCP user ID
  email: string;
  scope: string;
  sbSlug?: string; // Bound agent identity label (absent for human users)
  identityId?: string; // Canonical agent_identities UUID (JWT claim — kept as identityId for token compat)
  sbId?: string; // New-style alias for identityId in runner tokens
  /**
   * Session and contact this runner token was minted FOR.
   *
   * These are the authenticated binding between a runner process and the
   * conversation it serves. The `x-ink-context` header carries the same two
   * values, but it is unsigned base64url JSON the caller composes, so it can
   * only ever be a routing hint. One SB identity serves many contacts, which
   * means without a signed claim there is no authenticated per-contact
   * distinction at all — naming another contact's session would pass an
   * identity check that only compares sbId (Lumen, PR #501 round 3).
   */
  sessionId?: string;
  contactId?: string;
}

// ============================================================================
// Sign
// ============================================================================

/**
 * Sign a PCP access token (self-issued JWT).
 * Both MCP and admin auth use this to issue access tokens.
 */
export function signPcpAccessToken(payload: PcpTokenPayload, expiresInSeconds: number): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: expiresInSeconds,
  });
}

/**
 * Sign the access token a spawned runner carries.
 *
 * Lives here, beside the verifier, because the two have to agree on the claim
 * names for the contact boundary to hold — a runner issued without
 * `contactId` looks owner-scoped and is refused its own contact's session.
 * SessionService used to sign these inline with its own jwt.sign() against
 * process.env.JWT_SECRET while verification read env.JWT_SECRET; identical
 * today, but two signing paths for one verifier is a latent way to break that
 * agreement silently.
 */
export function signRunnerAccessToken(
  claims: {
    userId: string;
    email: string;
    sbSlug?: string;
    sbId?: string;
    /** The session this runner was spawned for. */
    sessionId?: string;
    /** The contact conversation it serves; absent for owner sessions. */
    contactId?: string;
  },
  expiresInSeconds = 60 * 60
): string {
  return signPcpAccessToken(
    {
      type: 'mcp_access',
      sub: claims.userId,
      email: claims.email,
      scope: 'mcp:tools',
      ...(claims.sbSlug ? { sbSlug: claims.sbSlug } : {}),
      ...(claims.sbId ? { sbId: claims.sbId } : {}),
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
      ...(claims.contactId ? { contactId: claims.contactId } : {}),
    },
    expiresInSeconds
  );
}

// ============================================================================
// Verify
// ============================================================================

/**
 * Verify a PCP access token (local jwt.verify, ~0ms).
 * Returns the payload if valid, null otherwise.
 *
 * @param token      Raw JWT string (not "Bearer ...")
 * @param expectedType  If provided, only accept tokens whose `type` field matches
 */
export function verifyPcpAccessToken(
  token: string,
  expectedType?: PcpTokenPayload['type']
): PcpTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;

    const payload = decoded as PcpTokenPayload & { agentId?: string };
    if (!payload.type || !payload.sub) return null;

    if (expectedType && payload.type !== expectedType) return null;

    // Tokens minted before the agentId -> sbSlug rename carry `agentId`, and
    // stay valid for their full lifetime (an hour for runner tokens, days for
    // refreshed CLI ones). Normalize here, at the single boundary every
    // consumer goes through, so a session that authenticated before the deploy
    // does not silently lose its identity binding mid-flight.
    if (!payload.sbSlug && payload.agentId) {
      return { ...payload, sbSlug: payload.agentId };
    }

    return payload;
  } catch {
    return null;
  }
}

// ============================================================================
// Refresh Tokens (DB-backed)
// ============================================================================
//
// A grant has a FIXED deadline, and both expressions of it are enforced on
// every exchange, earlier winning:
//
//   STORED    — `expires_at`, written once at issue and never moved.
//   ABSOLUTE  — `created_at` + REFRESH_ABSOLUTE_DAYS, recomputed each time so a
//               row whose stored expiry outruns the policy is still cut off.
//
// The grant ROTATES: each exchange issues a new secret and invalidates the one
// presented, so a captured refresh token is useful only until its owner next
// refreshes. The update is conditional on the presented value, so exactly one
// caller can win a race; the loser is refused rather than handed a second live
// token.
//
// Rotation deliberately does NOT touch `expires_at` or `created_at`. Rotating
// the secret is not a reason to extend the grant — if it were, an active client
// would hold one forever and the ceiling would never arrive. Re-authentication
// lands on the original schedule regardless of how often the secret changes.
//
// Rotation alone, though, refuses two clients who have done nothing wrong: the
// loser of a race between processes sharing one grant, and a client whose
// successful response never arrived and which retried the only secret it had.
// So the row keeps ONE generation of history — `previous_refresh_token` and
// `rotated_at` — and for a bounded overlap after a rotation the replaced value
// is answered with the successor that was already committed, rotating nothing.
// Retries converge rather than cascade. The window is exposure: inside it the
// previous secret is redeemable by whoever holds it. See
// REFRESH_RETRY_OVERLAP_SECONDS.

function newRefreshTokenValue(): string {
  return `pcp-rt-${crypto.randomBytes(32).toString('hex')}`;
}

/** The subset of a grant row this module reads. Columns come back untyped. */
type GrantRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  client_id: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[] | null;
};

interface ExchangeResult {
  accessToken: string;
  /** The grant's LIVE secret. The value presented is now dead. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  userId: string;
  email: string;
  sbSlug?: string;
  identityId?: string;
}

/**
 * Mint an access token carrying the grant's bindings, and package the reply.
 *
 * Shared by the rotating path and the retry-overlap path on purpose: a replayed
 * exchange must produce a token with exactly the same authority as the one the
 * winner got, never a broader or narrower one.
 */
function grantExchangeResult(
  record: GrantRow,
  liveRefreshToken: string,
  tokenType: PcpTokenPayload['type'],
  accessTokenLifetimeSeconds: number
): ExchangeResult {
  const email = (record.users as unknown as { email: string | null })?.email || '';
  const scope = record.scopes?.join(' ') || 'mcp:tools';
  // The COLUMN is still `agent_id`; the claim and the field are `sbSlug`.
  const sbSlug = record.agent_id as string | null;
  const sbId = record.sb_id as string | null;

  const accessToken = signPcpAccessToken(
    {
      type: tokenType,
      sub: record.user_id,
      email,
      scope,
      ...(sbSlug ? { sbSlug } : {}),
      ...(sbId ? { identityId: sbId } : {}),
    },
    accessTokenLifetimeSeconds
  );

  const { expiresAt } = effectiveGrantDeadline({
    createdAt: record.created_at as string | null,
    currentExpiresAt: record.expires_at,
  });

  return {
    accessToken,
    refreshToken: liveRefreshToken,
    refreshTokenExpiresAt: expiresAt,
    userId: record.user_id,
    email,
    ...(sbSlug ? { sbSlug } : {}),
    ...(sbId ? { identityId: sbId } : {}),
  };
}

/**
 * Whether a grant has outlived either expression of its deadline.
 *
 * Deletes the row when it has. Both deadlines are checked because a row whose
 * stored `expires_at` was written too generously — or migrated in from an older
 * scheme — is still finished, and its `expires_at` is not where that shows up.
 */
async function grantIsPastDeadline(
  supabase: SupabaseClient<Database>,
  record: GrantRow,
  clientId: string,
  now: Date
): Promise<boolean> {
  if (new Date(record.expires_at) < now) {
    logger.warn('Refresh token expired', { userId: record.user_id, clientId });
    await supabase.from('mcp_tokens').delete().eq('id', record.id);
    return true;
  }

  const createdAt = record.created_at as string | null;
  if (createdAt && new Date(createdAt).getTime() + REFRESH_ABSOLUTE_DAYS * DAY_MS < now.getTime()) {
    logger.warn('Refresh token past its absolute lifetime', {
      userId: record.user_id,
      clientId,
      createdAt,
    });
    await supabase.from('mcp_tokens').delete().eq('id', record.id);
    return true;
  }

  return false;
}

/**
 * Answer a secret that a rotation has already replaced.
 *
 * Reached two ways, and they are the same situation seen from either side of
 * the winner's write:
 *
 *   - the lookup missed, because the rotation committed before we read;
 *   - the lookup hit but our conditional update matched zero rows, because the
 *     rotation committed between our read and our write.
 *
 * Either way the question is whether the value presented is the one this grant
 * just replaced, and whether that happened recently enough. If so the answer is
 * the successor already committed — no second rotation, so concurrent retries
 * converge on one live secret instead of fighting over the grant.
 *
 * Past the window this refuses, and says so distinctly: with one generation on
 * the row the server can now tell a replayed secret from an unknown one. It
 * does NOT revoke the grant on that signal — breach detection (RFC 9700
 * §4.14.2) needs a full token family and a policy decision neither of which
 * exists yet — but the signal is in the log rather than indistinguishable from
 * an ordinary stale token.
 */
async function replayRotatedGrant(
  supabase: SupabaseClient<Database>,
  presentedToken: string,
  clientId: string,
  tokenType: PcpTokenPayload['type'],
  accessTokenLifetimeSeconds: number,
  overlapSeconds: number
): Promise<ExchangeResult | null> {
  if (overlapSeconds <= 0) return null;

  const { data, error } = await supabase
    .from('mcp_tokens')
    .select('*, users(email)')
    .eq('previous_refresh_token', presentedToken)
    .single();

  if (error || !data) return null;
  const record = data as unknown as GrantRow;

  if (record.client_id !== clientId) {
    logger.warn('Rotated refresh token client_id mismatch', {
      expected: record.client_id,
      received: clientId,
    });
    return null;
  }

  const now = new Date();

  if (
    !isWithinRetryOverlap({ rotatedAt: record.rotated_at as string | null, now, overlapSeconds })
  ) {
    logger.warn('Refresh token was already rotated and its retry window has closed', {
      userId: record.user_id,
      clientId,
      rotatedAt: record.rotated_at,
      overlapSeconds,
    });
    return null;
  }

  // A grant past its deadline is over however the secret was presented.
  if (await grantIsPastDeadline(supabase, record, clientId, now)) return null;

  logger.info('Honouring a just-rotated refresh token within its retry window', {
    userId: record.user_id,
    clientId,
    rotatedAt: record.rotated_at,
    overlapSeconds,
  });

  return grantExchangeResult(record, record.refresh_token, tokenType, accessTokenLifetimeSeconds);
}

/**
 * Create a refresh token in the mcp_tokens table.
 * Used for both MCP and admin auth — the `client_id` distinguishes them.
 */
export async function createRefreshToken(
  supabase: SupabaseClient<Database>,
  userId: string,
  clientId: string,
  scopes: string[],
  lifetimeDays: number,
  sbSlug?: string,
  sbId?: string
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = newRefreshTokenValue();
  const expiresAt = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from('mcp_tokens').insert({
    user_id: userId,
    client_id: clientId,
    refresh_token: refreshToken,
    supabase_refresh_token: null,
    scopes,
    expires_at: expiresAt.toISOString(),
    ...(sbSlug ? { agent_id: sbSlug } : {}),
    ...(sbId ? { sb_id: sbId } : {}),
  });

  if (error) {
    logger.error('Failed to store refresh token', { error, clientId });
    throw new Error('Failed to create refresh token');
  }

  return { refreshToken, expiresAt };
}

/**
 * Exchange a refresh token for a new access JWT, rotating the grant.
 *
 * The presented token is invalidated and a new one returned: callers MUST hand
 * `refreshToken` back to the client (OAuth response body, cookie) or the client
 * is locked out at its next refresh. Both deadlines are enforced, and the
 * grant's own deadline is left exactly where it was.
 *
 * `refreshTokenExpiresAt` is that unchanged deadline — the earlier of the
 * stored expiry and the absolute ceiling. Callers setting a cookie must use it
 * rather than computing a fresh window, or the cookie outlives the grant.
 *
 * A secret this grant rotated away from is still answered for
 * `retryOverlapSeconds` afterwards, with the successor already committed rather
 * than a second rotation. That is what keeps a retry, or the loser of a race
 * between two processes sharing a grant, from being logged out of a live
 * session. `refreshToken` in the reply is the grant's LIVE secret either way,
 * so a caller never needs to know which path answered it.
 *
 * @returns  Access token, the grant's live refresh token and user info, or null
 */
export async function exchangeRefreshToken(
  supabase: SupabaseClient<Database>,
  refreshToken: string,
  clientId: string,
  tokenType: PcpTokenPayload['type'],
  accessTokenLifetimeSeconds: number,
  options?: { retryOverlapSeconds?: number }
): Promise<ExchangeResult | null> {
  const overlapSeconds = options?.retryOverlapSeconds ?? REFRESH_RETRY_OVERLAP_SECONDS;
  const replay = () =>
    replayRotatedGrant(
      supabase,
      refreshToken,
      clientId,
      tokenType,
      accessTokenLifetimeSeconds,
      overlapSeconds
    );

  const { data, error: lookupError } = await supabase
    .from('mcp_tokens')
    .select('*, users(email)')
    .eq('refresh_token', refreshToken)
    .single();

  if (lookupError || !data) {
    // Not the live secret — but it may be the one this grant just replaced,
    // which is the ordinary shape of a retry. Ask before refusing.
    const replayed = await replay();
    if (!replayed) logger.warn('Refresh token not found', { clientId });
    return replayed;
  }

  const tokenRecord = data as unknown as GrantRow;

  if (tokenRecord.client_id !== clientId) {
    logger.warn('Refresh token client_id mismatch', {
      expected: tokenRecord.client_id,
      received: clientId,
    });
    return null;
  }

  const now = new Date();
  if (await grantIsPastDeadline(supabase, tokenRecord, clientId, now)) return null;

  // Rotate and stamp — one write, conditional on the value presented. Matching
  // on refresh_token as well as id is what makes a concurrent second exchange
  // lose: it updates zero rows rather than handing out a second live token for
  // the same grant.
  //
  // The value presented is kept as `previous_refresh_token`, stamped
  // `rotated_at`, so the loser of that race can be answered with THIS rotation's
  // result instead of being turned away.
  //
  // `expires_at` and `created_at` are deliberately absent from this update. The
  // deadline belongs to the grant, not to the secret currently representing it,
  // so rotating cannot move it and neither can a retry.
  const rotated = newRefreshTokenValue();

  const { data: updated, error: rotateError } = await supabase
    .from('mcp_tokens')
    .update({
      refresh_token: rotated,
      previous_refresh_token: refreshToken,
      rotated_at: now.toISOString(),
      last_used_at: now.toISOString(),
    })
    .eq('id', tokenRecord.id)
    .eq('refresh_token', refreshToken)
    .select('id');

  if (rotateError) {
    logger.error('Failed to rotate refresh token', { error: rotateError, clientId });
    return null;
  }
  if (!updated || updated.length === 0) {
    // Someone else rotated this grant between our read and our write. Their
    // write recorded the value we presented, so if we are inside the overlap
    // the answer is their successor — one live secret, both callers served.
    logger.warn('Refresh token was rotated concurrently; checking the retry window', {
      userId: tokenRecord.user_id,
      clientId,
    });
    return replay();
  }

  const result = grantExchangeResult(tokenRecord, rotated, tokenType, accessTokenLifetimeSeconds);

  const { atAbsoluteCeiling } = effectiveGrantDeadline({
    createdAt: tokenRecord.created_at as string | null,
    currentExpiresAt: tokenRecord.expires_at,
  });
  if (atAbsoluteCeiling) {
    // The stored expiry reaches past created_at + REFRESH_ABSOLUTE_DAYS, so the
    // ceiling is the deadline actually in force and the client has less time
    // than its row claims.
    logger.info('Refresh grant is capped by its absolute ceiling; re-authentication due', {
      userId: tokenRecord.user_id,
      clientId,
      storedExpiresAt: tokenRecord.expires_at,
      effectiveExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    });
  }

  return result;
}
