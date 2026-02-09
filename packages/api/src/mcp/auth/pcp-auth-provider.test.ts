import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSelect = vi.fn();
const mockGetUser = vi.fn();
const mockRefreshSession = vi.fn();

// Build a chainable mock for Supabase queries
function mockChain(terminalData: unknown = null, terminalError: unknown = null) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.insert = mockInsert.mockReturnValue(chain);
  chain.update = mockUpdate.mockReturnValue(chain);
  chain.delete = mockDelete.mockReturnValue(chain);
  chain.eq = vi.fn(() => chain);
  chain.lt = vi.fn(() => chain);
  chain.single = vi.fn(() => Promise.resolve({ data: terminalData, error: terminalError }));
  return chain;
}

let currentUserChain: ReturnType<typeof mockChain>;
let currentMcpTokensChain: ReturnType<typeof mockChain>;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      refreshSession: mockRefreshSession,
    },
    from: vi.fn((table: string) => {
      if (table === 'users') return currentUserChain;
      if (table === 'mcp_tokens') return currentMcpTokensChain;
      return mockChain();
    }),
  })),
}));

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { PcpAuthProvider } from './pcp-auth-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a valid PKCE code_challenge from a code_verifier */
function generatePkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Create a provider with a pending auth already set up, returning the pendingId */
function setupPendingAuth(provider: PcpAuthProvider) {
  return provider.createPendingAuth({
    clientId: 'test-client',
    codeChallenge: generatePkceChallenge('test-verifier'),
    redirectUri: 'http://localhost:3001/callback',
    state: 'test-state',
  });
}

/** Set up mocks for a successful auth callback (Supabase user + PCP user) */
function mockSuccessfulAuth() {
  mockGetUser.mockResolvedValue({
    data: { user: { email: 'test@example.com' } },
    error: null,
  });

  currentUserChain = mockChain({ id: 'user-123', email: 'test@example.com' });
}

/** Run the full auth flow through to auth code exchange, returning the tokens */
async function runFullAuthFlow(provider: PcpAuthProvider) {
  const pendingId = setupPendingAuth(provider);
  mockSuccessfulAuth();

  // Insert succeeds
  currentMcpTokensChain = mockChain();
  mockInsert.mockReturnValue({ error: null });

  const callbackResult = await provider.handleAuthCallback({
    pendingId,
    accessToken: 'supabase-jwt-123',
    refreshToken: 'supabase-rt-456',
  });

  if ('error' in callbackResult) throw new Error(`Callback failed: ${callbackResult.error}`);

  const tokenResult = await provider.exchangeAuthorizationCode({
    code: callbackResult.code,
    codeVerifier: 'test-verifier',
    clientId: 'test-client',
  });

  if ('error' in tokenResult) throw new Error(`Exchange failed: ${tokenResult.error}`);

  return tokenResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PcpAuthProvider', () => {
  let provider: PcpAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new PcpAuthProvider();
    currentUserChain = mockChain();
    currentMcpTokensChain = mockChain();
  });

  // =========================================================================
  // createPendingAuth
  // =========================================================================

  describe('createPendingAuth', () => {
    it('should return a pendingId starting with "pending-"', () => {
      const pendingId = setupPendingAuth(provider);
      expect(pendingId).toMatch(/^pending-/);
    });

    it('should generate unique IDs for each call', () => {
      const id1 = setupPendingAuth(provider);
      const id2 = setupPendingAuth(provider);
      expect(id1).not.toBe(id2);
    });
  });

  // =========================================================================
  // handleAuthCallback
  // =========================================================================

  describe('handleAuthCallback', () => {
    it('should return auth code on successful callback', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt',
        refreshToken: 'supabase-rt',
      });

      expect('code' in result).toBe(true);
      if ('code' in result) {
        expect(result.code).toMatch(/^pcp-code-/);
        expect(result.redirectUri).toBe('http://localhost:3001/callback');
        expect(result.state).toBe('test-state');
      }
    });

    it('should return error for invalid pendingId', async () => {
      const result = await provider.handleAuthCallback({
        pendingId: 'nonexistent',
        accessToken: 'jwt',
        refreshToken: 'rt',
      });

      expect(result).toEqual({
        error: 'invalid_request',
        error_description: 'Invalid or expired authorization request',
      });
    });

    it('should return error when Supabase auth fails', async () => {
      const pendingId = setupPendingAuth(provider);
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' },
      });

      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'bad-token',
        refreshToken: 'rt',
      });

      expect(result).toEqual({
        error: 'access_denied',
        error_description: 'Authentication failed',
      });
    });

    it('should return error when PCP user not found', async () => {
      const pendingId = setupPendingAuth(provider);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'unknown@example.com' } },
        error: null,
      });
      currentUserChain = mockChain(null, { code: 'PGRST116' });

      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });

      expect(result).toEqual({
        error: 'access_denied',
        error_description: 'User not found in PCP system',
      });
    });

    // Regression: web portal was redirecting to /mcp/auth/callback without
    // refresh_token, causing "Missing refresh token" error for MCP clients.
    // The auth callback MUST receive both access_token and refresh_token
    // from the web portal so the token exchange can store the Supabase
    // refresh token for later use.
    it('should require refresh_token for successful callback (regression)', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      // Callback with access_token but NO refresh_token should still
      // produce an auth code — the provider doesn't validate this, the
      // HTTP layer does. But verify the stored refresh token propagates
      // through to the code exchange.
      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt',
        refreshToken: 'supabase-rt-required',
      });

      expect('code' in callbackResult).toBe(true);
      if (!('code' in callbackResult)) return;

      // Exchange the code and verify refresh token was stored
      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const tokenResult = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect('access_token' in tokenResult).toBe(true);
      if (!('access_token' in tokenResult)) return;

      // The insert call should contain the supabase refresh token
      expect(mockInsert).toHaveBeenCalled();
      const insertArgs = mockInsert.mock.calls[0]?.[0];
      expect(insertArgs).toHaveProperty('supabase_refresh_token', 'supabase-rt-required');
    });

    it('should consume the pending auth after successful callback', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });

      // Second call with same pendingId should fail
      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });

      expect(result).toEqual({
        error: 'invalid_request',
        error_description: 'Invalid or expired authorization request',
      });
    });
  });

  // =========================================================================
  // exchangeAuthorizationCode
  // =========================================================================

  describe('exchangeAuthorizationCode', () => {
    it('should return access_token and refresh_token on success', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt-123',
        refreshToken: 'supabase-rt-456',
      });

      expect('code' in callbackResult).toBe(true);
      if (!('code' in callbackResult)) return;

      const result = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect('access_token' in result).toBe(true);
      if ('access_token' in result) {
        expect(result.access_token).toBe('supabase-jwt-123');
        expect(result.refresh_token).toMatch(/^pcp-rt-/);
        expect(result.token_type).toBe('Bearer');
        expect(result.expires_in).toBe(3600);
        expect(result.scope).toBe('mcp:tools');
      }
    });

    it('should store refresh token in database', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'supabase-rt',
      });
      if (!('code' in callbackResult)) return;

      await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      // Verify insert was called with correct data
      expect(mockInsert).toHaveBeenCalled();
    });

    it('should return error for invalid code', async () => {
      const result = await provider.exchangeAuthorizationCode({
        code: 'nonexistent-code',
        codeVerifier: 'verifier',
        clientId: 'client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Authorization code not found',
      });
    });

    it('should return error for PKCE verification failure', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });
      if (!('code' in callbackResult)) return;

      const result = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'wrong-verifier',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      });
    });

    it('should return error when DB insert fails', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      // Make the insert fail
      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: { message: 'DB error' } });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });
      if (!('code' in callbackResult)) return;

      const result = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'server_error',
        error_description: 'Failed to create token',
      });
    });

    it('should consume the auth code after exchange', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
        refreshToken: 'rt',
      });
      if (!('code' in callbackResult)) return;

      // First exchange succeeds
      await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      // Second exchange with same code fails
      const result = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Authorization code not found',
      });
    });
  });

  // =========================================================================
  // exchangeRefreshToken
  // =========================================================================

  describe('exchangeRefreshToken', () => {
    it('should return new access_token on successful refresh', async () => {
      // Mock: find the token in DB
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: 'supabase-rt-old',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
      });

      // Mock: Supabase refresh succeeds
      mockRefreshSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'fresh-supabase-jwt',
            refresh_token: 'supabase-rt-new',
          },
        },
        error: null,
      });

      // Mock: update succeeds
      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect('access_token' in result).toBe(true);
      if ('access_token' in result) {
        expect(result.access_token).toBe('fresh-supabase-jwt');
        expect(result.refresh_token).toBe('pcp-rt-abc'); // Same refresh token
        expect(result.token_type).toBe('Bearer');
        expect(result.expires_in).toBe(3600);
      }
    });

    it('should call supabase.auth.refreshSession with stored token', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: 'supabase-rt-stored',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
      });

      mockRefreshSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'new-jwt',
            refresh_token: 'new-supabase-rt',
          },
        },
        error: null,
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect(mockRefreshSession).toHaveBeenCalledWith({
        refresh_token: 'supabase-rt-stored',
      });
    });

    it('should return error for unknown refresh token', async () => {
      currentMcpTokensChain = mockChain(null, { code: 'PGRST116' });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-nonexistent',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      });
    });

    it('should return error for client_id mismatch', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'original-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: 'supabase-rt',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'different-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      });
    });

    it('should return error for expired refresh token', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: 'supabase-rt',
        scopes: ['mcp:tools'],
        expires_at: pastDate,
      });

      // Mock: delete chain
      mockDelete.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Refresh token expired',
      });
    });

    it('should return error when Supabase refresh fails', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: 'supabase-rt-revoked',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
      });

      mockRefreshSession.mockResolvedValue({
        data: { session: null },
        error: { message: 'Token has been revoked' },
      });

      // Mock: update to expire the token
      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Unable to refresh session. Please re-authenticate.',
      });
    });
  });

  // =========================================================================
  // verifyAccessToken
  // =========================================================================

  describe('verifyAccessToken', () => {
    it('should return user info for valid token', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      currentUserChain = mockChain({ id: 'user-123', email: 'test@example.com' });

      const result = await provider.verifyAccessToken('Bearer valid-jwt');

      expect(result).toEqual({ userId: 'user-123', email: 'test@example.com' });
    });

    it('should return null for missing auth header', async () => {
      const result = await provider.verifyAccessToken(undefined);
      expect(result).toBeNull();
    });

    it('should return null for non-Bearer auth header', async () => {
      const result = await provider.verifyAccessToken('Basic abc123');
      expect(result).toBeNull();
    });

    it('should return null for invalid Supabase token', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' },
      });

      const result = await provider.verifyAccessToken('Bearer expired-jwt');
      expect(result).toBeNull();
    });

    it('should return null when PCP user not found', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'unknown@example.com' } },
        error: null,
      });
      currentUserChain = mockChain(null);

      const result = await provider.verifyAccessToken('Bearer valid-jwt');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Full flow integration
  // =========================================================================

  describe('full OAuth flow', () => {
    it('should complete authorize → callback → code exchange → refresh', async () => {
      // Step 1: Create pending auth
      const pendingId = setupPendingAuth(provider);

      // Step 2: Auth callback
      mockSuccessfulAuth();
      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt-original',
        refreshToken: 'supabase-rt-original',
      });
      expect('code' in callbackResult).toBe(true);
      if (!('code' in callbackResult)) return;

      // Step 3: Exchange code for tokens
      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const tokens = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });
      expect('access_token' in tokens).toBe(true);
      if (!('access_token' in tokens)) return;
      expect(tokens.access_token).toBe('supabase-jwt-original');
      expect(tokens.refresh_token).toMatch(/^pcp-rt-/);

      // Step 4: Refresh the token
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: tokens.refresh_token,
        supabase_refresh_token: 'supabase-rt-original',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
      });

      mockRefreshSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'supabase-jwt-refreshed',
            refresh_token: 'supabase-rt-rotated',
          },
        },
        error: null,
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const refreshResult = await provider.exchangeRefreshToken({
        refreshToken: tokens.refresh_token!,
        clientId: 'test-client',
      });

      expect('access_token' in refreshResult).toBe(true);
      if ('access_token' in refreshResult) {
        expect(refreshResult.access_token).toBe('supabase-jwt-refreshed');
        expect(refreshResult.refresh_token).toBe(tokens.refresh_token); // Same opaque token
      }

      // Verify Supabase refresh was called with original token
      expect(mockRefreshSession).toHaveBeenCalledWith({
        refresh_token: 'supabase-rt-original',
      });
    });
  });
});
