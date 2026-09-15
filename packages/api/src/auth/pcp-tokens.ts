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
  assertRefreshWindowIsReachable,
  slidingExpiry,
} from './refresh-policy';

// Re-exported so callers and tests have one import site for the token module's
// own surface. Modules that only need the policy (admin routes, the OAuth
// provider) import './refresh-policy' directly — many suites mock this module
// wholesale, and every export added here becomes a broken mock in one of them.
export {
  DAY_MS,
  REFRESH_ABSOLUTE_DAYS,
  REFRESH_IDLE_DAYS,
  assertRefreshWindowIsReachable,
  slidingExpiry,
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
// A grant has TWO deadlines, and both are enforced on every exchange:
//
//   IDLE      — `expires_at`, pushed forward to now + REFRESH_IDLE_DAYS each
//               time the grant is used. A client that stops calling loses the
//               grant a week later instead of keeping it for three months.
//   ABSOLUTE  — `created_at` + REFRESH_ABSOLUTE_DAYS, which sliding can never
//               push past. Re-authentication is required eventually no matter
//               how active the client is.
//
// The grant also ROTATES: each exchange issues a new secret and invalidates the
// one presented, so a captured refresh token is useful only until its owner
// next refreshes. The update is conditional on the presented value, so exactly
// one caller can win a race; the loser is refused rather than handed a second
// live token.
//
// INVARIANT, asserted below: the idle window must be comfortably longer than
// the access-token lifetime. A client only refreshes when its access token
// runs out, so an idle window shorter than that lifetime would expire every
// grant before it was ever used — silently logging everyone out on a schedule.

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
 * is locked out at its next refresh. Both deadlines are enforced, and the grant
 * slides one idle window forward on success.
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
  sbSlug?: string;
  identityId?: string;
} | null> {
  assertRefreshWindowIsReachable(accessTokenLifetimeSeconds, `exchangeRefreshToken(${clientId})`);

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

  // The absolute ceiling is checked on its own. A grant that has been slid
  // forward every week for three months is still finished, and its stored
  // expires_at is not where that shows up.
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
  const sbSlug = tokenAny.agent_id as string | null;
  const sbId = tokenAny.sb_id as string | null;

  const accessToken = signPcpAccessToken(
    {
      type: tokenType,
      sub: tokenRecord.user_id,
      email: userEmail,
      scope,
      ...(sbSlug ? { sbSlug } : {}),
      ...(sbId ? { identityId: sbId } : {}),
    },
    accessTokenLifetimeSeconds
  );

  // Rotate, slide, and stamp — one write, conditional on the value presented.
  // Matching on refresh_token as well as id is what makes a concurrent second
  // exchange lose: it updates zero rows rather than handing out a second live
  // token for the same grant.
  const rotated = newRefreshTokenValue();
  const { expiresAt, atAbsoluteCeiling } = slidingExpiry({
    now,
    createdAt,
    currentExpiresAt: tokenRecord.expires_at,
  });

  const { data: updated, error: rotateError } = await supabase
    .from('mcp_tokens')
    .update({
      refresh_token: rotated,
      expires_at: expiresAt.toISOString(),
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
    logger.info('Refresh grant is at its absolute ceiling; re-authentication due', {
      userId: tokenRecord.user_id,
      clientId,
      expiresAt: expiresAt.toISOString(),
    });
  }

  return {
    accessToken,
    refreshToken: rotated,
    refreshTokenExpiresAt: expiresAt,
    userId: tokenRecord.user_id,
    email: userEmail,
    ...(sbSlug ? { sbSlug } : {}),
    ...(sbId ? { identityId: sbId } : {}),
  };
}
