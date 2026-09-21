/**
 * Shared Inkwell Token Utilities
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
import type { Database } from '../data/supabase/types';

// ============================================================================
// Types
// ============================================================================

export interface InkTokenPayload {
  type: 'mcp_access' | 'pcp_admin';
  sub: string; // Inkwell user ID
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
 * Sign a Inkwell access token (self-issued JWT).
 * Both MCP and admin auth use this to issue access tokens.
 */
export function signInkAccessToken(payload: InkTokenPayload, expiresInSeconds: number): string {
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
  return signInkAccessToken(
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
 * Verify a Inkwell access token (local jwt.verify, ~0ms).
 * Returns the payload if valid, null otherwise.
 *
 * @param token      Raw JWT string (not "Bearer ...")
 * @param expectedType  If provided, only accept tokens whose `type` field matches
 */
export function verifyInkAccessToken(
  token: string,
  expectedType?: InkTokenPayload['type']
): InkTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;

    const payload = decoded as InkTokenPayload & { agentId?: string };
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
  const refreshToken = `ink-rt-${crypto.randomBytes(32).toString('hex')}`;
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
 * Exchange a refresh token for a new access JWT.
 * Looks up the token in mcp_tokens, verifies expiry, signs a fresh JWT.
 *
 * @returns  Access token + user info on success, null on failure
 */
export async function exchangeRefreshToken(
  supabase: SupabaseClient<Database>,
  refreshToken: string,
  clientId: string,
  tokenType: InkTokenPayload['type'],
  accessTokenLifetimeSeconds: number
): Promise<{
  accessToken: string;
  userId: string;
  email: string;
  sbSlug?: string;
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

  if (new Date(tokenRecord.expires_at) < new Date()) {
    logger.warn('Refresh token expired', { userId: tokenRecord.user_id });
    await supabase.from('mcp_tokens').delete().eq('id', tokenRecord.id);
    return null;
  }

  const userEmail = (tokenRecord.users as unknown as { email: string | null })?.email || '';

  const scope = tokenRecord.scopes?.join(' ') || 'mcp:tools';
  const tokenAny = tokenRecord as Record<string, unknown>;
  const sbSlug = tokenAny.agent_id as string | null;
  const sbId = tokenAny.sb_id as string | null;

  const accessToken = signInkAccessToken(
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

  // Update last_used_at
  await supabase
    .from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenRecord.id);

  return {
    accessToken,
    userId: tokenRecord.user_id,
    email: userEmail,
    ...(sbSlug ? { sbSlug } : {}),
    ...(sbId ? { identityId: sbId } : {}),
  };
}
