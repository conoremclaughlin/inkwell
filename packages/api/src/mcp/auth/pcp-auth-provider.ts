/**
 * PCP OAuth Provider for MCP Authentication
 *
 * Handles the OAuth 2.0 authorization code flow with refresh token support.
 * Uses Supabase as the identity provider, issuing our own opaque refresh tokens
 * backed by stored Supabase refresh tokens for server-side session renewal.
 *
 * Token chain: MCP client refresh_token -> this provider -> supabase.auth.refreshSession() -> fresh JWT
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { Database } from '../../data/supabase/types';

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

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  supabaseToken: string;
  supabaseRefreshToken: string;
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

// TODO: Consider extending Supabase JWT expiry to 30 days (2592000s) in dashboard
// and updating this constant to match. Current 1-hour expiry works via refresh
// tokens, but a longer JWT reduces refresh frequency for MCP clients.
const ACCESS_TOKEN_LIFETIME = 3600; // 1 hour (Supabase JWT default)
const REFRESH_TOKEN_LIFETIME_DAYS = 90;
const REFRESH_TOKEN_LIFETIME_MS = REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
const AUTH_CODE_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_AUTH_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Provider
// ============================================================================

export class PcpAuthProvider {
  private pendingAuths = new Map<string, PendingAuth>();
  private authCodes = new Map<string, AuthCode>();
  private supabase: SupabaseClient<Database>;

  constructor() {
    this.supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
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
    const pendingId = `pending-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

    this.pendingAuths.set(pendingId, {
      ...params,
      expiresAt: Date.now() + PENDING_AUTH_LIFETIME_MS,
    });

    this.cleanupExpired(this.pendingAuths);
    return pendingId;
  }

  // --------------------------------------------------------------------------
  // Auth callback (GET /mcp/auth/callback)
  // --------------------------------------------------------------------------

  async handleAuthCallback(params: {
    pendingId: string;
    accessToken: string;
    refreshToken: string;
  }): Promise<AuthCallbackResult | OAuthErrorResponse> {
    const pending = this.pendingAuths.get(params.pendingId);
    if (!pending) {
      return { error: 'invalid_request', error_description: 'Invalid or expired authorization request' };
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingAuths.delete(params.pendingId);
      return { error: 'invalid_request', error_description: 'Authorization request expired' };
    }

    try {
      // Verify Supabase token and resolve PCP user
      const { data: { user }, error: authError } = await this.supabase.auth.getUser(params.accessToken);
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

      // Auto-create PCP user on first OAuth login
      if (userError?.code === 'PGRST116') {
        logger.info('Auto-creating PCP user on first MCP auth', { email: user.email });
        const { data: newUser, error: createError } = await this.supabase
          .from('users')
          .insert({ email: user.email })
          .select('id, email')
          .single();

        if (createError || !newUser) {
          logger.error('Failed to create PCP user', { email: user.email, error: createError });
          return { error: 'server_error', error_description: 'Failed to create user account' };
        }

        pcpUser = newUser;
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
        supabaseToken: params.accessToken,
        supabaseRefreshToken: params.refreshToken,
        userId: pcpUser.id,
        userEmail: pcpUser.email || '',
        expiresAt: Date.now() + AUTH_CODE_LIFETIME_MS,
      });

      this.pendingAuths.delete(params.pendingId);
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

    // Generate our opaque refresh token
    const refreshToken = `pcp-rt-${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS);

    // Store in database
    const { error: dbError } = await this.supabase
      .from('mcp_tokens')
      .insert({
        user_id: codeData.userId,
        client_id: clientId,
        refresh_token: refreshToken,
        supabase_refresh_token: codeData.supabaseRefreshToken,
        scopes: ['mcp:tools'],
        expires_at: expiresAt.toISOString(),
      });

    if (dbError) {
      logger.error('Failed to store MCP token', { error: dbError });
      return { error: 'server_error', error_description: 'Failed to create token' };
    }

    // Consume the authorization code
    this.authCodes.delete(params.code);

    logger.info('MCP tokens issued', {
      userId: codeData.userId,
      email: codeData.userEmail,
      clientId,
      refreshTokenExpires: expiresAt.toISOString(),
    });

    return {
      access_token: codeData.supabaseToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME,
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
    // Look up token in database
    const { data: tokenRecord, error: lookupError } = await this.supabase
      .from('mcp_tokens')
      .select('*')
      .eq('refresh_token', params.refreshToken)
      .single();

    if (lookupError || !tokenRecord) {
      logger.warn('MCP refresh token not found', { clientId: params.clientId });
      return { error: 'invalid_grant', error_description: 'Invalid refresh token' };
    }

    // Verify client_id matches
    if (tokenRecord.client_id !== params.clientId) {
      logger.warn('MCP refresh token client_id mismatch', {
        expected: tokenRecord.client_id,
        received: params.clientId,
      });
      return { error: 'invalid_grant', error_description: 'Invalid refresh token' };
    }

    // Check expiration
    if (new Date(tokenRecord.expires_at) < new Date()) {
      logger.warn('MCP refresh token expired', { userId: tokenRecord.user_id });
      await this.supabase.from('mcp_tokens').delete().eq('id', tokenRecord.id);
      return { error: 'invalid_grant', error_description: 'Refresh token expired' };
    }

    // Use stored Supabase refresh token to get a fresh session
    const { data: sessionData, error: refreshError } = await this.supabase.auth.refreshSession({
      refresh_token: tokenRecord.supabase_refresh_token,
    });

    if (refreshError || !sessionData.session) {
      logger.error('Supabase token refresh failed', {
        error: refreshError,
        userId: tokenRecord.user_id,
      });
      // Expire the token so it's cleaned up, but don't delete (user can re-auth)
      await this.supabase
        .from('mcp_tokens')
        .update({ expires_at: new Date().toISOString() })
        .eq('id', tokenRecord.id);
      return { error: 'invalid_grant', error_description: 'Unable to refresh session. Please re-authenticate.' };
    }

    // Update stored Supabase refresh token (Supabase rotates on use)
    await this.supabase
      .from('mcp_tokens')
      .update({
        supabase_refresh_token: sessionData.session.refresh_token,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', tokenRecord.id);

    logger.info('MCP token refreshed', {
      userId: tokenRecord.user_id,
      clientId: params.clientId,
    });

    return {
      access_token: sessionData.session.access_token,
      refresh_token: params.refreshToken, // Keep same refresh token (don't rotate)
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME,
      scope: tokenRecord.scopes?.join(' ') || 'mcp:tools',
    };
  }

  // --------------------------------------------------------------------------
  // Token verification (for /mcp endpoint auth)
  // --------------------------------------------------------------------------

  async verifyAccessToken(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);

    try {
      const { data: { user }, error } = await this.supabase.auth.getUser(token);

      if (error || !user) {
        logger.debug('Supabase token validation failed', { error: error?.message });
        return null;
      }

      const { data: pcpUser } = await this.supabase
        .from('users')
        .select('id, email')
        .eq('email', user.email!)
        .single();

      if (!pcpUser) {
        logger.warn('Supabase user not found in PCP', { email: user.email });
        return null;
      }

      return { userId: pcpUser.id, email: pcpUser.email || '' };
    } catch (error) {
      logger.error('Error verifying access token', { error });
      return null;
    }
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
