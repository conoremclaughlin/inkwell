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
import type { Database } from '../data/supabase/types';

// ============================================================================
// Types
// ============================================================================

export interface PcpTokenPayload {
  type: 'mcp_access' | 'pcp_admin';
  sub: string; // PCP user ID
  email: string;
  scope: string;
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

/**
 * Create a refresh token in the mcp_tokens table.
 * Used for both MCP and admin auth — the `client_id` distinguishes them.
 */
export async function createRefreshToken(
  supabase: SupabaseClient<Database>,
  userId: string,
  clientId: string,
  scopes: string[],
  lifetimeDays: number
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = `pcp-rt-${crypto.randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from('mcp_tokens').insert({
    user_id: userId,
    client_id: clientId,
    refresh_token: refreshToken,
    supabase_refresh_token: null,
    scopes,
    expires_at: expiresAt.toISOString(),
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
  tokenType: PcpTokenPayload['type'],
  accessTokenLifetimeSeconds: number
): Promise<{ accessToken: string; userId: string; email: string } | null> {
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

  const accessToken = signPcpAccessToken(
    {
      type: tokenType,
      sub: tokenRecord.user_id,
      email: userEmail,
      scope,
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
  };
}
