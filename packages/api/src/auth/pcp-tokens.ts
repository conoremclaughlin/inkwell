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
import { DAY_MS, REFRESH_ABSOLUTE_DAYS, effectiveGrantDeadline } from './refresh-policy';

// Re-exported so callers and tests have one import site for the token module's
// own surface. Modules that only need the policy (admin routes, the OAuth
// provider) import './refresh-policy' directly — many suites mock this module
// wholesale, and every export added here becomes a broken mock in one of them.
export { DAY_MS, REFRESH_ABSOLUTE_DAYS, effectiveGrantDeadline } from './refresh-policy';
import type { Database } from '../data/supabase/types';

// ============================================================================
// Types
// ============================================================================

export interface PcpTokenPayload {
  type: 'mcp_access' | 'pcp_admin';
  sub: string; // PCP user ID
  email: string;
  scope: string;
  agentId?: string; // Bound agent identity label (absent for human users)
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
    agentId?: string;
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
      ...(claims.agentId ? { agentId: claims.agentId } : {}),
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

    const payload = decoded as PcpTokenPayload;
    if (!payload.type || !payload.sub) return null;

    if (expectedType && payload.type !== expectedType) return null;

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

function newRefreshTokenValue(): string {
  return `pcp-rt-${crypto.randomBytes(32).toString('hex')}`;
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
  agentId?: string,
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
    ...(agentId ? { agent_id: agentId } : {}),
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
 * @returns  Access token, the ROTATED refresh token and user info, or null
 */
export async function exchangeRefreshToken(
  supabase: SupabaseClient<Database>,
  refreshToken: string,
  clientId: string,
  tokenType: PcpTokenPayload['type'],
  accessTokenLifetimeSeconds: number
): Promise<{
  accessToken: string;
  /** ROTATED — the presented token is now dead. Return this to the client. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  userId: string;
  email: string;
  agentId?: string;
  identityId?: string;
} | null> {
  const { data: tokenRecord, error: lookupError } = await supabase
    .from('mcp_tokens')
    .select('*, users(email)')
    .eq('refresh_token', refreshToken)
    .single();

  if (lookupError || !tokenRecord) {
    logger.warn('Refresh token not found', { clientId });
    return null;
  }

  if (tokenRecord.client_id !== clientId) {
    logger.warn('Refresh token client_id mismatch', {
      expected: tokenRecord.client_id,
      received: clientId,
    });
    return null;
  }

  const now = new Date();

  if (new Date(tokenRecord.expires_at) < now) {
    logger.warn('Refresh token expired', { userId: tokenRecord.user_id, clientId });
    await supabase.from('mcp_tokens').delete().eq('id', tokenRecord.id);
    return null;
  }

  // The absolute ceiling is checked on its own, because a row whose stored
  // expires_at was written too generously — or migrated in from an older
  // scheme — is still finished, and its expires_at is not where that shows up.
  const createdAt = (tokenRecord as Record<string, unknown>).created_at as string | null;
  if (createdAt && new Date(createdAt).getTime() + REFRESH_ABSOLUTE_DAYS * DAY_MS < now.getTime()) {
    logger.warn('Refresh token past its absolute lifetime', {
      userId: tokenRecord.user_id,
      clientId,
      createdAt,
    });
    await supabase.from('mcp_tokens').delete().eq('id', tokenRecord.id);
    return null;
  }

  const userEmail = (tokenRecord.users as unknown as { email: string | null })?.email || '';

  const scope = tokenRecord.scopes?.join(' ') || 'mcp:tools';
  const tokenAny = tokenRecord as Record<string, unknown>;
  const agentId = tokenAny.agent_id as string | null;
  const sbId = tokenAny.sb_id as string | null;

  const accessToken = signPcpAccessToken(
    {
      type: tokenType,
      sub: tokenRecord.user_id,
      email: userEmail,
      scope,
      ...(agentId ? { agentId } : {}),
      ...(sbId ? { identityId: sbId } : {}),
    },
    accessTokenLifetimeSeconds
  );

  // Rotate and stamp — one write, conditional on the value presented. Matching
  // on refresh_token as well as id is what makes a concurrent second exchange
  // lose: it updates zero rows rather than handing out a second live token for
  // the same grant.
  //
  // `expires_at` and `created_at` are deliberately absent from this update. The
  // deadline belongs to the grant, not to the secret currently representing it,
  // so rotating cannot move it and neither can a retry.
  const rotated = newRefreshTokenValue();
  const { expiresAt, atAbsoluteCeiling } = effectiveGrantDeadline({
    createdAt,
    currentExpiresAt: tokenRecord.expires_at,
  });

  const { data: updated, error: rotateError } = await supabase
    .from('mcp_tokens')
    .update({
      refresh_token: rotated,
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
    // Someone else rotated this grant between our read and our write. Refusing
    // is the safe direction: the winner holds the live token.
    logger.warn('Refresh token was rotated concurrently; refusing this exchange', {
      userId: tokenRecord.user_id,
      clientId,
    });
    return null;
  }

  if (atAbsoluteCeiling) {
    // The stored expiry reaches past created_at + REFRESH_ABSOLUTE_DAYS, so the
    // ceiling is the deadline actually in force and the client has less time
    // than its row claims.
    logger.info('Refresh grant is capped by its absolute ceiling; re-authentication due', {
      userId: tokenRecord.user_id,
      clientId,
      storedExpiresAt: tokenRecord.expires_at,
      effectiveExpiresAt: expiresAt.toISOString(),
    });
  }

  return {
    accessToken,
    refreshToken: rotated,
    refreshTokenExpiresAt: expiresAt,
    userId: tokenRecord.user_id,
    email: userEmail,
    ...(agentId ? { agentId } : {}),
    ...(sbId ? { identityId: sbId } : {}),
  };
}
