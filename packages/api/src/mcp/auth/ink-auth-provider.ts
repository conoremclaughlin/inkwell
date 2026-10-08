/**
 * Inkwell OAuth Provider for MCP Authentication
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
  signInkAccessToken,
  verifyInkAccessToken,
  createRefreshToken,
  exchangeRefreshToken as exchangeRefreshTokenShared,
} from '../../auth/ink-tokens';
import { resolveAccountForPrincipal } from '../../services/account-deletion/principal';
import { accountGate } from '../../services/account-deletion/gate';
import { tokenIdentityState } from '../../auth/token-identity';

/** A signed, unexpired `mcp_access` token's claims. */
export interface VerifiedAccessToken {
  userId: string;
  email: string;
  sbSlug?: string;
  sbId?: string;
  /** Signed runner binding — authenticated, unlike the x-ink-context header. */
  sessionId?: string;
  contactId?: string;
  /** The token's `exp`, seconds since the epoch. Nothing minted from it may outlive it. */
  expiresAt?: number;
}

/**
 * A request's bearer token, judged:
 * - `ok`: signed, unexpired, and any SB it names still exists;
 * - 401: missing, invalid or expired, or naming an SB with no identity row;
 * - 503: the SB it names couldn't be read, so the request can't be judged.
 */
export type AccessTokenVerdict =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; status: 401 | 503 };

/**
 * Carry an SB binding across the rename on a pending-auth JWT.
 *
 * handleAuthCallback verifies this JWT with jwt.verify() directly, so it never
 * reaches the normalization inside verifyInkAccessToken(). A pending request
 * created before the deploy is still valid; dropping its slug mints the access
 * and refresh credentials with no SB binding at all (Lumen, PR #635).
 */
export function normalizePendingAuth(payload: PendingAuthPayload): PendingAuthPayload {
  const raw = payload as PendingAuthPayload & { agentId?: string };
  return !raw.sbSlug && raw.agentId ? { ...raw, sbSlug: raw.agentId } : raw;
}

// ============================================================================
// Types
// ============================================================================

export interface PendingAuth {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
  sbSlug?: string;
  expiresAt: number;
}

/** JWT payload for pending auth tokens (replaces in-memory Map) */
interface PendingAuthPayload {
  type: 'pending_auth';
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
  sbSlug?: string;
}

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  userId: string;
  userEmail: string;
  sbSlug?: string;
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

export class InkAuthProvider {
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
    sbSlug?: string;
  }): string {
    const payload: PendingAuthPayload = {
      type: 'pending_auth',
      clientId: params.clientId,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      ...(params.sbSlug ? { sbSlug: params.sbSlug } : {}),
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
      pending = normalizePendingAuth(decoded as PendingAuthPayload);
    } catch (err) {
      const desc =
        err instanceof jwt.TokenExpiredError
          ? 'Authorization request expired'
          : 'Invalid or expired authorization request';
      return { error: 'invalid_request', error_description: desc };
    }

    try {
      // Verify Supabase token and resolve Inkwell user
      const {
        data: { user },
        error: authError,
      } = await this.supabase.auth.getUser(params.accessToken);
      if (authError || !user) {
        logger.error('Supabase auth verification failed in callback', { error: authError });
        return { error: 'access_denied', error_description: 'Authentication failed' };
      }

      // The account bound to this sign-in, created bound on first OAuth
      // login. Never resolved by email alone (ink://specs/account-deletion
      // §7), and never one that is being deleted.
      const resolved = await resolveAccountForPrincipal(this.supabase, {
        authUid: user.id,
        email: user.email ?? null,
        create: true,
      });
      if (!resolved.ok) {
        if (resolved.status === 500) {
          logger.error('Inkwell user lookup failed', { reason: resolved.reason });
          return { error: 'server_error', error_description: 'User lookup failed' };
        }
        return { error: 'access_denied', error_description: resolved.reason };
      }
      if (resolved.created) {
        logger.info('Auto-created Inkwell user on first MCP auth', { userId: resolved.userId });
      }
      const inkUser = { id: resolved.userId, email: user.email ?? null };

      // Create authorization code
      const code = `ink-code-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

      this.authCodes.set(code, {
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        userId: inkUser.id,
        userEmail: inkUser.email || '',
        ...(pending.sbSlug ? { sbSlug: pending.sbSlug } : {}),
        expiresAt: Date.now() + AUTH_CODE_LIFETIME_MS,
      });

      this.cleanupExpired(this.authCodes);

      logger.info('MCP auth callback complete', { userId: inkUser.id, email: inkUser.email });

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

    // A code issued before its account's deletion closed it is spent, not
    // exchanged (ink://specs/account-deletion §7).
    if (accountGate.isClosed(codeData.userId)) {
      this.authCodes.delete(params.code);
      return { error: 'invalid_grant', error_description: 'This account is being deleted' };
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

    // Resolve canonical identity UUID when agent_id is provided
    let sbId: string | undefined;
    if (codeData.sbSlug) {
      const { data: identity } = await this.supabase
        .from('agent_identities')
        .select('id')
        .eq('user_id', codeData.userId)
        .eq('agent_id', codeData.sbSlug)
        .maybeSingle();
      sbId = identity?.id;
      if (!sbId) {
        logger.warn('No agent_identities record found for token binding', {
          userId: codeData.userId,
          sbSlug: codeData.sbSlug,
        });
      }
    }

    // Create refresh token in database (with optional identity binding)
    let refreshToken: string;
    let expiresAt: Date;
    try {
      const result = await createRefreshToken(
        this.supabase,
        codeData.userId,
        clientId,
        ['mcp:tools'],
        REFRESH_TOKEN_LIFETIME_DAYS,
        codeData.sbSlug,
        sbId
      );
      refreshToken = result.refreshToken;
      expiresAt = result.expiresAt;
    } catch {
      return { error: 'server_error', error_description: 'Failed to create token' };
    }

    // Consume the authorization code
    this.authCodes.delete(params.code);

    // Sign our own JWT as the access token (with optional identity binding)
    const accessToken = signInkAccessToken(
      {
        type: 'mcp_access',
        sub: codeData.userId,
        email: codeData.userEmail,
        scope: 'mcp:tools',
        ...(codeData.sbSlug ? { sbSlug: codeData.sbSlug } : {}),
        ...(sbId ? { identityId: sbId } : {}),
      },
      ACCESS_TOKEN_LIFETIME_SECONDS
    );

    logger.info('MCP tokens issued', {
      userId: codeData.userId,
      email: codeData.userEmail,
      clientId,
      sbSlug: codeData.sbSlug || 'none',
      sbId: sbId || 'none',
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
    if (accountGate.isClosed(result.userId)) {
      return { error: 'invalid_grant', error_description: 'This account is being deleted' };
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

  /**
   * Every server path that takes an `mcp_access` token checks it here: the
   * signature and expiry, and then that the SB it names still exists. A
   * deleted space takes its SBs' identity rows with it, and its tokens are
   * refused from their next request (token-identity.ts, task 3f7f6a8f).
   */
  async verifyAccessToken(authHeader: string | undefined): Promise<AccessTokenVerdict> {
    const token = this.verifyAccessTokenSignature(authHeader);
    if (!token) return { ok: false, status: 401 };
    const state = await tokenIdentityState(this.supabase, {
      userId: token.userId,
      sbId: token.sbId,
      sbSlug: token.sbSlug,
    });
    if (state === 'gone') return { ok: false, status: 401 };
    if (state === 'unreadable') return { ok: false, status: 503 };
    return { ok: true, token };
  }

  /**
   * The signature and expiry alone, with no database read. A request is
   * never authorised on this: use verifyAccessToken.
   */
  verifyAccessTokenSignature(authHeader: string | undefined): VerifiedAccessToken | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.substring(7);

    const payload = verifyInkAccessToken(token, 'mcp_access');
    if (!payload) return null;
    const exp = (payload as { exp?: unknown }).exp;

    return {
      userId: payload.sub,
      email: payload.email,
      ...(payload.sbSlug ? { sbSlug: payload.sbSlug } : {}),
      ...(payload.sbId
        ? { sbId: payload.sbId }
        : payload.identityId
          ? { sbId: payload.identityId }
          : {}),
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.contactId ? { contactId: payload.contactId } : {}),
      ...(typeof exp === 'number' ? { expiresAt: exp } : {}),
    };
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
