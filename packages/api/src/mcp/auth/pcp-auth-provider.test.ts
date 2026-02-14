import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSelect = vi.fn();
const mockGetUser = vi.fn();

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
    },
    from: vi.fn((table: string) => {
      if (table === 'users') return currentUserChain;
      if (table === 'mcp_tokens') return currentMcpTokensChain;
      return mockChain();
    }),
  })),
}));

const TEST_JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';

vi.mock('../../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
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
    it('should return a valid signed JWT', () => {
      const pendingId = setupPendingAuth(provider);
      // JWT format: three base64url segments separated by dots
      expect(pendingId.split('.')).toHaveLength(3);

      // Should be verifiable with the secret
      const decoded = jwt.verify(pendingId, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('pending_auth');
      expect(decoded.clientId).toBe('test-client');
      expect(decoded.redirectUri).toBe('http://localhost:3001/callback');
      expect(decoded.state).toBe('test-state');
    });

    it('should generate unique tokens for each call', () => {
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
      });

      expect(result).toEqual({
        error: 'access_denied',
        error_description: 'Authentication failed',
      });
    });

    it('should auto-create PCP user when not found and return auth code', async () => {
      const pendingId = setupPendingAuth(provider);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'new@example.com' } },
        error: null,
      });

      // First from('users') call: SELECT returns PGRST116 (not found)
      // Second from('users') call: INSERT returns the new user
      let userCallCount = 0;
      const selectChain = mockChain(null, { code: 'PGRST116' });
      const insertChain = mockChain({ id: 'new-user-123', email: 'new@example.com' });
      const originalFrom = vi.mocked(provider['supabase'].from);
      originalFrom.mockImplementation((table: string) => {
        if (table === 'users') {
          userCallCount++;
          return userCallCount === 1 ? selectChain : insertChain;
        }
        if (table === 'mcp_tokens') return currentMcpTokensChain;
        return mockChain();
      });

      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });

      expect(result).toHaveProperty('code');
      expect(result).toHaveProperty('redirectUri');
    });

    it('should return error when auto-create fails', async () => {
      const pendingId = setupPendingAuth(provider);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'unknown@example.com' } },
        error: null,
      });
      // Mock returns PGRST116 for both SELECT and INSERT (chain is shared)
      currentUserChain = mockChain(null, { code: 'PGRST116' });

      const result = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });

      expect(result).toEqual({
        error: 'server_error',
        error_description: 'Failed to create user account',
      });
    });

    it('should work without refresh_token (no longer needed)', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt',
      });

      expect('code' in callbackResult).toBe(true);
      if (!('code' in callbackResult)) return;

      // Exchange the code
      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const tokenResult = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect('access_token' in tokenResult).toBe(true);

      // supabase_refresh_token should be null (self-issued JWTs, no Supabase dependency)
      expect(mockInsert).toHaveBeenCalled();
      const insertArgs = mockInsert.mock.calls[0]?.[0];
      expect(insertArgs).toHaveProperty('supabase_refresh_token', null);
    });

    it('should accept the same JWT on re-callback (stateless, PKCE prevents replay)', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      const result1 = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });

      expect('code' in result1).toBe(true);

      // Second call with same pendingId should also succeed (stateless JWT)
      mockSuccessfulAuth();
      const result2 = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });

      expect('code' in result2).toBe(true);
    });

    it('should return error for expired JWT', async () => {
      // Sign a JWT that's already expired
      const expiredToken = jwt.sign(
        {
          type: 'pending_auth',
          clientId: 'test',
          codeChallenge: 'ch',
          redirectUri: 'http://localhost/cb',
          state: 's',
        },
        TEST_JWT_SECRET,
        { expiresIn: 0 }
      );

      // Wait a tick so the token is expired
      await new Promise((r) => setTimeout(r, 10));

      const result = await provider.handleAuthCallback({
        pendingId: expiredToken,
        accessToken: 'jwt',
      });

      expect(result).toEqual({
        error: 'invalid_request',
        error_description: 'Authorization request expired',
      });
    });

    it('should return error for wrong JWT type', async () => {
      const wrongTypeToken = jwt.sign({ type: 'wrong_type', clientId: 'test' }, TEST_JWT_SECRET, {
        expiresIn: 600,
      });

      const result = await provider.handleAuthCallback({
        pendingId: wrongTypeToken,
        accessToken: 'jwt',
      });

      expect(result).toEqual({
        error: 'invalid_request',
        error_description: 'Invalid authorization request',
      });
    });
  });

  // =========================================================================
  // exchangeAuthorizationCode
  // =========================================================================

  describe('exchangeAuthorizationCode', () => {
    it('should return a self-signed JWT access_token and refresh_token on success', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt-123',
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
        // Access token is a self-signed JWT (3 dot-separated segments)
        expect(result.access_token.split('.')).toHaveLength(3);
        // Verify JWT payload
        const decoded = jwt.verify(result.access_token, TEST_JWT_SECRET) as Record<string, unknown>;
        expect(decoded.type).toBe('mcp_access');
        expect(decoded.sub).toBe('user-123');
        expect(decoded.email).toBe('test@example.com');
        expect(decoded.scope).toBe('mcp:tools');

        expect(result.refresh_token).toMatch(/^pcp-rt-/);
        expect(result.token_type).toBe('Bearer');
        expect(result.expires_in).toBe(30 * 24 * 60 * 60);
        expect(result.scope).toBe('mcp:tools');
      }
    });

    it('should store refresh token in database with null supabase_refresh_token', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      currentMcpTokensChain = mockChain();
      mockInsert.mockReturnValue({ error: null });

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });
      if (!('code' in callbackResult)) return;

      await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'test-client',
      });

      expect(mockInsert).toHaveBeenCalled();
      const insertArgs = mockInsert.mock.calls[0]?.[0];
      expect(insertArgs).toHaveProperty('supabase_refresh_token', null);
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

    it('should return error for client_id mismatch', async () => {
      const pendingId = setupPendingAuth(provider);
      mockSuccessfulAuth();

      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'jwt',
      });
      if (!('code' in callbackResult)) return;

      const result = await provider.exchangeAuthorizationCode({
        code: callbackResult.code,
        codeVerifier: 'test-verifier',
        clientId: 'different-client', // doesn't match 'test-client' from setupPendingAuth
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Client ID mismatch',
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
    it('should return a self-signed JWT access_token on successful refresh', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: null,
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect('access_token' in result).toBe(true);
      if ('access_token' in result) {
        // Verify it's a self-signed JWT
        const decoded = jwt.verify(result.access_token, TEST_JWT_SECRET) as Record<string, unknown>;
        expect(decoded.type).toBe('mcp_access');
        expect(decoded.sub).toBe('user-123');
        expect(decoded.email).toBe('test@example.com');
        expect(decoded.scope).toBe('mcp:tools');

        expect(result.refresh_token).toBe('pcp-rt-abc');
        expect(result.token_type).toBe('Bearer');
        expect(result.expires_in).toBe(30 * 24 * 60 * 60);
      }
    });

    it('should not call supabase.auth.refreshSession (no Supabase dependency)', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        supabase_refresh_token: null,
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      // No Supabase auth calls should be made during refresh
      expect(mockGetUser).not.toHaveBeenCalled();
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
        supabase_refresh_token: null,
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
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
        supabase_refresh_token: null,
        scopes: ['mcp:tools'],
        expires_at: pastDate,
        users: { email: 'test@example.com' },
      });

      mockDelete.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await provider.exchangeRefreshToken({
        refreshToken: 'pcp-rt-abc',
        clientId: 'test-client',
      });

      expect(result).toEqual({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      });
    });
  });

  // =========================================================================
  // verifyAccessToken
  // =========================================================================

  describe('verifyAccessToken', () => {
    it('should return user info for valid self-signed JWT', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '30d' }
      );

      const result = provider.verifyAccessToken(`Bearer ${token}`);
      expect(result).toEqual({ userId: 'user-123', email: 'test@example.com' });
    });

    it('should return null for missing auth header', () => {
      const result = provider.verifyAccessToken(undefined);
      expect(result).toBeNull();
    });

    it('should return null for non-Bearer auth header', () => {
      const result = provider.verifyAccessToken('Basic abc123');
      expect(result).toBeNull();
    });

    it('should return null for expired JWT', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: 0 }
      );

      const result = provider.verifyAccessToken(`Bearer ${token}`);
      expect(result).toBeNull();
    });

    it('should return null for wrong JWT type', () => {
      const token = jwt.sign({ type: 'pending_auth', clientId: 'test' }, TEST_JWT_SECRET, {
        expiresIn: '1h',
      });

      const result = provider.verifyAccessToken(`Bearer ${token}`);
      expect(result).toBeNull();
    });

    it('should return null for JWT signed with wrong secret', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        'wrong-secret-that-is-at-least-32-characters-long',
        { expiresIn: '30d' }
      );

      const result = provider.verifyAccessToken(`Bearer ${token}`);
      expect(result).toBeNull();
    });

    it('should not make any Supabase calls', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '30d' }
      );

      provider.verifyAccessToken(`Bearer ${token}`);
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Full flow integration
  // =========================================================================

  describe('full OAuth flow', () => {
    it('should complete authorize → callback → code exchange → refresh → verify', async () => {
      // Step 1: Create pending auth
      const pendingId = setupPendingAuth(provider);

      // Step 2: Auth callback
      mockSuccessfulAuth();
      const callbackResult = await provider.handleAuthCallback({
        pendingId,
        accessToken: 'supabase-jwt-original',
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

      // Access token is a self-signed JWT
      const decoded = jwt.verify(tokens.access_token, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('mcp_access');
      expect(decoded.sub).toBe('user-123');
      expect(tokens.refresh_token).toMatch(/^pcp-rt-/);

      // Step 4: Refresh the token
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: tokens.refresh_token,
        supabase_refresh_token: null,
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const refreshResult = await provider.exchangeRefreshToken({
        refreshToken: tokens.refresh_token!,
        clientId: 'test-client',
      });

      expect('access_token' in refreshResult).toBe(true);
      if (!('access_token' in refreshResult)) return;

      // Refreshed token is also a self-signed JWT
      const refreshedDecoded = jwt.verify(refreshResult.access_token, TEST_JWT_SECRET) as Record<
        string,
        unknown
      >;
      expect(refreshedDecoded.type).toBe('mcp_access');
      expect(refreshedDecoded.sub).toBe('user-123');
      expect(refreshResult.refresh_token).toBe(tokens.refresh_token);

      // Step 5: Verify the access token
      const verified = provider.verifyAccessToken(`Bearer ${refreshResult.access_token}`);
      expect(verified).toEqual({ userId: 'user-123', email: 'test@example.com' });

      // No Supabase auth calls after initial callback
      expect(mockGetUser).toHaveBeenCalledTimes(1); // Only during handleAuthCallback
    });
  });
});
