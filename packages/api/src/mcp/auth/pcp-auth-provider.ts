/**
 * PCP OAuth Provider for MCP Authentication
 *
 * Issues self-signed JWTs as MCP access tokens (30-day expiry).
 * Supabase is used only for initial identity verification during login.
 * After that, all token operations are local (sign/verify with JWT_SECRET).
 *
 * Token chain: MCP client refresh_token (opaque, DB-backed) -> jwt.sign() -> self-issued JWT
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { Database } from '../../data/supabase/types';
import {
  signPcpAccessToken,
  verifyPcpAccessToken,
  createRefreshToken,
  exchangeRefreshToken as exchangeRefreshTokenShared,
} from '../../auth/pcp-tokens';

// ============================================================================
// Types
// ============================================================================

export interface PendingAuth {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
  expiresAt: number;
}

/** JWT payload for pending auth tokens (replaces in-memory Map) */
interface PendingAuthPayload {
  type: 'pending_auth';
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
}

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  userId: string;
  userEmail: string;
  expiresAt: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

export interface AuthCallbackResult {
  code: string;
  redirectUri: string;
  state: string;
}

// ============================================================================
// Constants
// ============================================================================

const ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REFRESH_TOKEN_LIFETIME_DAYS = 90;
const AUTH_CODE_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_AUTH_LIFETIME_SECONDS = 600; // 10 minutes

// ============================================================================
// Provider
// ============================================================================

export class PcpAuthProvider {
  private authCodes = new Map<string, AuthCode>();
  private supabase: SupabaseClient<Database>;

  constructor() {
    this.supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Authorization flow (GET /authorize)
  // --------------------------------------------------------------------------

  createPendingAuth(params: {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    state: string;
  }): string {
    const payload: PendingAuthPayload = {
      type: 'pending_auth',
      clientId: params.clientId,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
    };

    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: PENDING_AUTH_LIFETIME_SECONDS,
      jwtid: crypto.randomBytes(8).toString('hex'),
    });
  }

  // --------------------------------------------------------------------------
  // Auth callback (GET /mcp/auth/callback)
  // --------------------------------------------------------------------------

  async handleAuthCallback(params: {
    pendingId: string;
    accessToken: string;
    refreshToken?: string;
  }): Promise<AuthCallbackResult | OAuthErrorResponse> {
    // Verify the signed pending auth JWT
    let pending: PendingAuthPayload;
    try {
      const decoded = jwt.verify(params.pendingId, env.JWT_SECRET);
      if (typeof decoded === 'string' || (decoded as PendingAuthPayload).type !== 'pending_auth') {
        return { error: 'invalid_request', error_description: 'Invalid authorization request' };
      }
      pending = decoded as PendingAuthPayload;
    } catch (err) {
      const desc =
        err instanceof jwt.TokenExpiredError
          ? 'Authorization request expired'
          : 'Invalid or expired authorization request';
      return { error: 'invalid_request', error_description: desc };
    }

    try {
      // Verify Supabase token and resolve PCP user
      const {
        data: { user },
        error: authError,
      } = await this.supabase.auth.getUser(params.accessToken);
      if (authError || !user) {
        logger.error('Supabase auth verification failed in callback', { error: authError });
        return { error: 'access_denied', error_description: 'Authentication failed' };
      }

      // Look up or create PCP user
      let { data: pcpUser, error: userError } = await this.supabase
        .from('users')
        .select('id, email')
        .eq('email', user.email!)
        .single();

      // Auto-create PCP user on first OAuth login (if not found)
      if (userError?.code === 'PGRST116') {
        logger.info('Auto-creating PCP user on first MCP auth', { email: user.email });
        const { data: newUser, error: createError } = await this.supabase
          .from('users')
          .insert({ email: user.email })
          .select('id, email')
          .single();

        if (createError) {
          // Check if user was created by another request (race condition or unique violation)
          if (createError.code === '23505') {
            logger.info('User already exists (race condition), retrying lookup', {
              email: user.email,
            });
            const { data: existingUser, error: retryError } = await this.supabase
              .from('users')
              .select('id, email')
              .eq('email', user.email!)
              .single();

            if (retryError || !existingUser) {
              logger.error('Failed to fetch existing user after unique violation', {
                email: user.email,
                error: retryError,
              });
              return { error: 'server_error', error_description: 'User lookup failed' };
            }

            pcpUser = existingUser;
          } else {
            logger.error('Failed to create PCP user', { email: user.email, error: createError });
            return { error: 'server_error', error_description: 'Failed to create user account' };
          }
        } else {
          pcpUser = newUser;
        }
      } else if (userError || !pcpUser) {
        logger.error('PCP user lookup failed', { email: user.email, error: userError });
        return { error: 'access_denied', error_description: 'User lookup failed' };
      }

      // Create authorization code
      const code = `pcp-code-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

      this.authCodes.set(code, {
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        userId: pcpUser.id,
        userEmail: pcpUser.email || '',
        expiresAt: Date.now() + AUTH_CODE_LIFETIME_MS,
      });

      this.cleanupExpired(this.authCodes);

      logger.info('MCP auth callback complete', { userId: pcpUser.id, email: pcpUser.email });

      return {
        code,
        redirectUri: pending.redirectUri,
        state: pending.state,
      };
    } catch (error) {
      logger.error('Error handling auth callback', { error });
      return { error: 'server_error', error_description: 'Authentication error' };
    }
  }

  // --------------------------------------------------------------------------
  // Token exchange: authorization_code (POST /token)
  // --------------------------------------------------------------------------

  async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
    clientId?: string;
  }): Promise<OAuthTokenResponse | OAuthErrorResponse> {
    const codeData = this.authCodes.get(params.code);
    if (!codeData) {
      return { error: 'invalid_grant', error_description: 'Authorization code not found' };
    }

    if (Date.now() > codeData.expiresAt) {
      this.authCodes.delete(params.code);
      return { error: 'invalid_grant', error_description: 'Authorization code expired' };
    }

    // Fall back to the client_id stored in the auth code (from /authorize).
    // Some clients (e.g. Codex) don't send client_id in the token exchange body.
    // If a different client_id is explicitly provided, reject it.
    if (params.clientId && params.clientId !== codeData.clientId) {
      logger.warn('client_id mismatch in code exchange', {
        expected: codeData.clientId,
        received: params.clientId,
      });
      return { error: 'invalid_grant', error_description: 'Client ID mismatch' };
    }
    const clientId = params.clientId || codeData.clientId;

    // Verify PKCE
    if (codeData.codeChallenge && params.codeVerifier) {
      const computedChallenge = crypto
        .createHash('sha256')
        .update(params.codeVerifier)
        .digest('base64url');

      if (computedChallenge !== codeData.codeChallenge) {
        logger.warn('PKCE verification failed', {
          expected: codeData.codeChallenge,
          computed: computedChallenge,
        });
        return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
      }
    }

    // Create refresh token in database
    let refreshToken: string;
    let expiresAt: Date;
    try {
      const result = await createRefreshToken(
        this.supabase,
        codeData.userId,
        clientId,
        ['mcp:tools'],
        REFRESH_TOKEN_LIFETIME_DAYS
      );
      refreshToken = result.refreshToken;
      expiresAt = result.expiresAt;
    } catch {
      return { error: 'server_error', error_description: 'Failed to create token' };
    }

    // Consume the authorization code
    this.authCodes.delete(params.code);

    // Sign our own JWT as the access token
    const accessToken = signPcpAccessToken(
      {
        type: 'mcp_access',
        sub: codeData.userId,
        email: codeData.userEmail,
        scope: 'mcp:tools',
      },
      ACCESS_TOKEN_LIFETIME_SECONDS
    );

    logger.info('MCP tokens issued', {
      userId: codeData.userId,
      email: codeData.userEmail,
      clientId,
      refreshTokenExpires: expiresAt.toISOString(),
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      scope: 'mcp:tools',
    };
  }

  // --------------------------------------------------------------------------
  // Token exchange: refresh_token (POST /token)
  // --------------------------------------------------------------------------

  async exchangeRefreshToken(params: {
    refreshToken: string;
    clientId: string;
  }): Promise<OAuthTokenResponse | OAuthErrorResponse> {
    const result = await exchangeRefreshTokenShared(
      this.supabase,
      params.refreshToken,
      params.clientId,
      'mcp_access',
      ACCESS_TOKEN_LIFETIME_SECONDS
    );

    if (!result) {
      return { error: 'invalid_grant', error_description: 'Invalid refresh token' };
    }

    logger.info('MCP token refreshed', {
      userId: result.userId,
      clientId: params.clientId,
    });

    return {
      access_token: result.accessToken,
      refresh_token: params.refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      scope: 'mcp:tools',
    };
  }

  // --------------------------------------------------------------------------
  // Token verification (for /mcp endpoint auth)
  // --------------------------------------------------------------------------

  verifyAccessToken(authHeader: string | undefined): { userId: string; email: string } | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);

    const payload = verifyPcpAccessToken(token, 'mcp_access');
    if (!payload) return null;

    return { userId: payload.sub, email: payload.email };
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  async cleanupExpiredDatabaseTokens(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await this.supabase
        .from('mcp_tokens')
        .delete()
        .lt('expires_at', cutoff)
        .select('id');

      if (!error && data && data.length > 0) {
        logger.info(`Cleaned up ${data.length} expired MCP tokens`);
      }
    } catch (error) {
      logger.error('Error cleaning up expired MCP tokens', { error });
    }
  }

  private cleanupExpired<T extends { expiresAt: number }>(map: Map<string, T>): void {
    const now = Date.now();
    for (const [key, value] of map.entries()) {
      if (now > value.expiresAt) {
        map.delete(key);
      }
    }
  }
}
