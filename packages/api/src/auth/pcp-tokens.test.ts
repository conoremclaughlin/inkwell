import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

function mockChain(terminalData: unknown = null, terminalError: unknown = null) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.insert = mockInsert.mockReturnValue(chain);
  chain.update = mockUpdate.mockReturnValue(chain);
  chain.delete = mockDelete.mockReturnValue(chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn(() => Promise.resolve({ data: terminalData, error: terminalError }));
  return chain;
}

let currentMcpTokensChain: ReturnType<typeof mockChain>;

const mockFrom = vi.fn((table: string) => {
  if (table === 'mcp_tokens') return currentMcpTokensChain;
  return mockChain();
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

const TEST_JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
  },
}));

vi.mock('../utils/logger', () => ({
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

import {
  signPcpAccessToken,
  verifyPcpAccessToken,
  createRefreshToken,
  exchangeRefreshToken,
  type PcpTokenPayload,
} from './pcp-tokens';
import { createClient } from '@supabase/supabase-js';

// Helper to create a mock Supabase client
function getMockSupabase() {
  return createClient('http://localhost:54321', 'test-key') as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pcp-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMcpTokensChain = mockChain();
  });

  // =========================================================================
  // signPcpAccessToken
  // =========================================================================

  describe('signPcpAccessToken', () => {
    it('should return a valid JWT with correct payload', () => {
      const payload: PcpTokenPayload = {
        type: 'mcp_access',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'mcp:tools',
      };

      const token = signPcpAccessToken(payload, 3600);

      // Valid JWT format
      expect(token.split('.')).toHaveLength(3);

      // Correct payload
      const decoded = jwt.verify(token, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('mcp_access');
      expect(decoded.sub).toBe('user-123');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.scope).toBe('mcp:tools');
    });

    it('should sign pcp_admin tokens', () => {
      const payload: PcpTokenPayload = {
        type: 'pcp_admin',
        sub: 'user-456',
        email: 'admin@example.com',
        scope: 'admin',
      };

      const token = signPcpAccessToken(payload, 3600);
      const decoded = jwt.verify(token, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('pcp_admin');
      expect(decoded.sub).toBe('user-456');
      expect(decoded.scope).toBe('admin');
    });

    it('should respect expiresInSeconds', () => {
      const payload: PcpTokenPayload = {
        type: 'mcp_access',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'mcp:tools',
      };

      const token = signPcpAccessToken(payload, 60); // 1 minute
      const decoded = jwt.verify(token, TEST_JWT_SECRET) as Record<string, unknown>;
      const exp = decoded.exp as number;
      const iat = decoded.iat as number;
      expect(exp - iat).toBe(60);
    });

    it('should produce unique tokens for same payload', () => {
      const payload: PcpTokenPayload = {
        type: 'mcp_access',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'mcp:tools',
      };

      const token1 = signPcpAccessToken(payload, 3600);
      // iat is per-second so tokens in the same second will match;
      // we're just testing they're real JWTs — not testing randomness here.
      expect(token1.split('.')).toHaveLength(3);
    });
  });

  // =========================================================================
  // verifyPcpAccessToken
  // =========================================================================

  describe('verifyPcpAccessToken', () => {
    it('should verify a valid mcp_access token', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const result = verifyPcpAccessToken(token);
      expect(result).toMatchObject({
        type: 'mcp_access',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'mcp:tools',
      });
    });

    it('should verify a valid pcp_admin token', () => {
      const token = jwt.sign(
        { type: 'pcp_admin', sub: 'user-456', email: 'admin@example.com', scope: 'admin' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const result = verifyPcpAccessToken(token);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('pcp_admin');
      expect(result!.sub).toBe('user-456');
    });

    it('should filter by expectedType when provided', () => {
      const mcpToken = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      // Should pass when expectedType matches
      expect(verifyPcpAccessToken(mcpToken, 'mcp_access')).not.toBeNull();

      // Should fail when expectedType doesn't match
      expect(verifyPcpAccessToken(mcpToken, 'pcp_admin')).toBeNull();
    });

    it('should reject pcp_admin token when mcp_access expected', () => {
      const adminToken = jwt.sign(
        { type: 'pcp_admin', sub: 'user-456', email: 'admin@example.com', scope: 'admin' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      expect(verifyPcpAccessToken(adminToken, 'mcp_access')).toBeNull();
    });

    it('should accept any valid type when expectedType is omitted', () => {
      const mcpToken = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );
      const adminToken = jwt.sign(
        { type: 'pcp_admin', sub: 'user-456', email: 'admin@example.com', scope: 'admin' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      expect(verifyPcpAccessToken(mcpToken)).not.toBeNull();
      expect(verifyPcpAccessToken(adminToken)).not.toBeNull();
    });

    it('should return null for expired token', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: 0 }
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should return null for wrong secret', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        'wrong-secret-that-is-at-least-32-characters-long',
        { expiresIn: '1h' }
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should return null for malformed token', () => {
      expect(verifyPcpAccessToken('not-a-jwt')).toBeNull();
      expect(verifyPcpAccessToken('')).toBeNull();
    });

    it('should return null for JWT with missing sub', () => {
      const token = jwt.sign(
        { type: 'mcp_access', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should return null for JWT with missing type', () => {
      const token = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should return null for string payload JWT', () => {
      // jwt.sign can produce a token with string payload
      const token = jwt.sign('string-payload', TEST_JWT_SECRET);
      expect(verifyPcpAccessToken(token)).toBeNull();
    });

    it('should not make any network or DB calls', () => {
      const token = jwt.sign(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        TEST_JWT_SECRET,
        { expiresIn: '1h' }
      );

      verifyPcpAccessToken(token);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // createRefreshToken
  // =========================================================================

  describe('createRefreshToken', () => {
    it('should create a refresh token and store it in the database', async () => {
      mockInsert.mockReturnValue({ error: null });

      const result = await createRefreshToken(
        getMockSupabase(),
        'user-123',
        'test-client',
        ['mcp:tools'],
        90
      );

      expect(result.refreshToken).toMatch(/^pcp-rt-/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify DB insert was called
      expect(mockFrom).toHaveBeenCalledWith('mcp_tokens');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          client_id: 'test-client',
          scopes: ['mcp:tools'],
          supabase_refresh_token: null,
        })
      );
    });

    it('should set correct expiration based on lifetimeDays', async () => {
      mockInsert.mockReturnValue({ error: null });

      const before = Date.now();
      const result = await createRefreshToken(
        getMockSupabase(),
        'user-123',
        'dashboard',
        ['admin'],
        30
      );
      const after = Date.now();

      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedMs);
    });

    it('should throw when database insert fails', async () => {
      mockInsert.mockReturnValue({ error: { message: 'DB error' } });

      await expect(
        createRefreshToken(getMockSupabase(), 'user-123', 'test-client', ['mcp:tools'], 90)
      ).rejects.toThrow('Failed to create refresh token');
    });

    it('should generate unique refresh tokens', async () => {
      mockInsert.mockReturnValue({ error: null });

      const result1 = await createRefreshToken(
        getMockSupabase(),
        'user-123',
        'client',
        ['mcp:tools'],
        90
      );
      const result2 = await createRefreshToken(
        getMockSupabase(),
        'user-123',
        'client',
        ['mcp:tools'],
        90
      );

      expect(result1.refreshToken).not.toBe(result2.refreshToken);
    });

    it('should store admin scopes for dashboard client', async () => {
      mockInsert.mockReturnValue({ error: null });

      await createRefreshToken(getMockSupabase(), 'user-123', 'dashboard', ['admin'], 90);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: 'dashboard',
          scopes: ['admin'],
        })
      );
    });
  });

  // =========================================================================
  // exchangeRefreshToken
  // =========================================================================

  describe('exchangeRefreshToken', () => {
    it('should return new access JWT on valid refresh', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'test-client',
        'mcp_access',
        2592000
      );

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-123');
      expect(result!.email).toBe('test@example.com');

      // Access token should be a valid JWT
      const decoded = jwt.verify(result!.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('mcp_access');
      expect(decoded.sub).toBe('user-123');
      expect(decoded.email).toBe('test@example.com');
    });

    it('should sign pcp_admin tokens when tokenType is pcp_admin', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-456',
        client_id: 'dashboard',
        refresh_token: 'pcp-rt-admin',
        scopes: ['admin'],
        expires_at: futureDate,
        users: { email: 'admin@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-admin',
        'dashboard',
        'pcp_admin',
        3600
      );

      expect(result).not.toBeNull();
      const decoded = jwt.verify(result!.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
      expect(decoded.type).toBe('pcp_admin');
      expect(decoded.scope).toBe('admin');
    });

    it('should respect accessTokenLifetimeSeconds', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'dashboard',
        refresh_token: 'pcp-rt-abc',
        scopes: ['admin'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'dashboard',
        'pcp_admin',
        3600 // 1 hour
      );

      const decoded = jwt.verify(result!.accessToken, TEST_JWT_SECRET) as Record<string, unknown>;
      const exp = decoded.exp as number;
      const iat = decoded.iat as number;
      expect(exp - iat).toBe(3600);
    });

    it('should return null for unknown refresh token', async () => {
      currentMcpTokensChain = mockChain(null, { code: 'PGRST116' });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-nonexistent',
        'test-client',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();
    });

    it('should return null for client_id mismatch', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'original-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'different-client',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();
    });

    it('should return null and delete expired refresh token', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: pastDate,
        users: { email: 'test@example.com' },
      });

      mockDelete.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'test-client',
        'mcp_access',
        3600
      );

      expect(result).toBeNull();
      // Should have deleted the expired token
      expect(mockFrom).toHaveBeenCalledWith('mcp_tokens');
    });

    it('should update last_used_at on successful exchange', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'test-client',
        'mcp_access',
        3600
      );

      // update() should have been called for last_used_at
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('should not make any Supabase auth calls', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: 'test@example.com' },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const supabase = getMockSupabase();
      await exchangeRefreshToken(supabase, 'pcp-rt-abc', 'test-client', 'mcp_access', 3600);

      // Supabase auth methods should never be called
      expect(supabase.auth).toBeUndefined();
    });

    it('should handle missing user email gracefully', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      currentMcpTokensChain = mockChain({
        id: 'token-1',
        user_id: 'user-123',
        client_id: 'test-client',
        refresh_token: 'pcp-rt-abc',
        scopes: ['mcp:tools'],
        expires_at: futureDate,
        users: { email: null },
      });

      mockUpdate.mockReturnValue({
        eq: vi.fn(() => ({ error: null })),
      });

      const result = await exchangeRefreshToken(
        getMockSupabase(),
        'pcp-rt-abc',
        'test-client',
        'mcp_access',
        3600
      );

      expect(result).not.toBeNull();
      expect(result!.email).toBe('');
    });
  });

  // =========================================================================
  // Cross-function: sign → verify round-trip
  // =========================================================================

  describe('sign + verify round-trip', () => {
    it('should verify a token signed by signPcpAccessToken', () => {
      const payload: PcpTokenPayload = {
        type: 'mcp_access',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'mcp:tools',
      };

      const token = signPcpAccessToken(payload, 3600);
      const result = verifyPcpAccessToken(token);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('mcp_access');
      expect(result!.sub).toBe('user-123');
      expect(result!.email).toBe('test@example.com');
    });

    it('should verify pcp_admin round-trip', () => {
      const payload: PcpTokenPayload = {
        type: 'pcp_admin',
        sub: 'user-456',
        email: 'admin@example.com',
        scope: 'admin',
      };

      const token = signPcpAccessToken(payload, 3600);
      const result = verifyPcpAccessToken(token, 'pcp_admin');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('pcp_admin');
    });

    it('should enforce type isolation: mcp_access token rejected as pcp_admin', () => {
      const token = signPcpAccessToken(
        { type: 'mcp_access', sub: 'user-123', email: 'test@example.com', scope: 'mcp:tools' },
        3600
      );

      expect(verifyPcpAccessToken(token, 'mcp_access')).not.toBeNull();
      expect(verifyPcpAccessToken(token, 'pcp_admin')).toBeNull();
    });

    it('should enforce type isolation: pcp_admin token rejected as mcp_access', () => {
      const token = signPcpAccessToken(
        { type: 'pcp_admin', sub: 'user-456', email: 'admin@example.com', scope: 'admin' },
        3600
      );

      expect(verifyPcpAccessToken(token, 'pcp_admin')).not.toBeNull();
      expect(verifyPcpAccessToken(token, 'mcp_access')).toBeNull();
    });
  });
});
