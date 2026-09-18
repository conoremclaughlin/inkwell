/**
 * Admin Auth Middleware Tests
 *
 * Tests the three-tier authentication flow:
 * - Tier 1: PCP admin access JWT (local verify, ~0ms)
 * - Tier 2: Refresh token exchange via cookie (1 DB call)
 * - Tier 3: Supabase verification (network call, first login only)
 *
 * Also tests cookie issuance, workspace resolution, and edge cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Mocks for pcp-tokens (the shared auth module)
// ---------------------------------------------------------------------------

const mockVerifyPcpAccessToken = vi.fn();
const mockExchangeRefreshToken = vi.fn();
const mockSignPcpAccessToken = vi.fn();
const mockCreateRefreshToken = vi.fn();

vi.mock('../auth/pcp-tokens', () => ({
  verifyPcpAccessToken: (...args: unknown[]) => mockVerifyPcpAccessToken(...args),
  exchangeRefreshToken: (...args: unknown[]) => mockExchangeRefreshToken(...args),
  signPcpAccessToken: (...args: unknown[]) => mockSignPcpAccessToken(...args),
  createRefreshToken: (...args: unknown[]) => mockCreateRefreshToken(...args),
}));

// ---------------------------------------------------------------------------
// Mocks for Supabase
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockSupabaseFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockSupabaseFrom,
  })),
}));

// ---------------------------------------------------------------------------
// Mocks for data layer
// ---------------------------------------------------------------------------

const mockFindById = vi.fn();
const mockFindRawById = vi.fn();
const mockEnsurePersonalWorkspace = vi.fn();
const mockListTrustedUsers = vi.fn();

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {
      workspaces: {
        findById: mockFindById,
        findRawById: mockFindRawById,
        ensurePersonalWorkspace: mockEnsurePersonalWorkspace,
      },
    },
  })),
}));

vi.mock('../services/authorization', () => ({
  getAuthorizationService: vi.fn(() => ({
    listTrustedUsers: mockListTrustedUsers,
  })),
}));

vi.mock('../services/oauth', () => ({
  getOAuthService: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Mocks for env, logger, request-context
// ---------------------------------------------------------------------------

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
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

let capturedRunContext: Record<string, unknown> | null = null;
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (context: Record<string, unknown>, fn: () => void) => {
    capturedRunContext = context;
    fn();
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import router from './admin';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Extract the adminAuthMiddleware from the router's stack */
function getMiddleware(): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  // The middleware is the first non-route handler in the router stack
  const layer = (router as any).stack.find(
    (entry: any) =>
      entry.name === 'adminAuthMiddleware' || (!entry.route && entry.handle?.length === 3)
  );
  if (!layer) {
    throw new Error('adminAuthMiddleware not found in router stack');
  }
  return layer.handle;
}

function createMockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: { authorization: 'Bearer test-token' },
    cookies: {},
    params: {},
    body: {},
    path: '/test',
    header: vi.fn((name: string) => {
      const headers = (overrides.headers || {}) as Record<string, string>;
      return headers[name.toLowerCase()] || headers[name];
    }),
    ...overrides,
  } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
  _cookies: Record<string, { value: string; options: Record<string, unknown> }>;
  _clearedCookies: Record<string, { options: Record<string, unknown> }>;
}

function createMockRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    _cookies: {} as Record<string, { value: string; options: Record<string, unknown> }>,
    _clearedCookies: {} as Record<string, { options: Record<string, unknown> }>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      (res._cookies as Record<string, unknown>)[name] = { value, options };
      return res;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      (res._clearedCookies as Record<string, unknown>)[name] = { options };
      return res;
    },
  };
  return res as unknown as MockResponse;
}

/** Set up mocks for Supabase queries used during Tier 3 (user lookup) */
function mockSupabaseUserLookup(pcpUser: Record<string, unknown>) {
  const userChain: Record<string, any> = {};
  userChain.select = vi.fn(() => userChain);
  userChain.insert = vi.fn(() => userChain);
  userChain.update = vi.fn(() => userChain);
  userChain.eq = vi.fn(() => userChain);
  userChain.single = vi.fn(() => Promise.resolve({ data: pcpUser, error: null }));

  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'users') return userChain;
    return userChain; // fallback
  });

  return userChain;
}

/** Standard workspace mock that returns a personal workspace */
function mockDefaultWorkspace() {
  mockEnsurePersonalWorkspace.mockResolvedValue({ id: 'workspace-1' });
  mockFindById.mockResolvedValue(null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adminAuthMiddleware', () => {
  let middleware: ReturnType<typeof getMiddleware>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRunContext = null;
    middleware = getMiddleware();
    mockDefaultWorkspace();
  });

  // =========================================================================
  // OAuth callback bypass
  // =========================================================================

  describe('OAuth callback bypass', () => {
    it('should skip auth for OAuth callback routes', async () => {
      const req = createMockReq({ path: '/oauth/google/callback', headers: {} });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res._status).toBe(200); // not 401
    });
  });

  // =========================================================================
  // Missing auth
  // =========================================================================

  describe('missing authorization', () => {
    it('should return 401 for missing authorization header', async () => {
      const req = createMockReq({ headers: {} });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Missing authorization header' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 for non-Bearer authorization', async () => {
      const req = createMockReq({ headers: { authorization: 'Basic abc123' } });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Tier 1: PCP admin JWT
  // =========================================================================

  describe('Tier 1: PCP admin access JWT', () => {
    it('should authenticate via valid PCP admin JWT and call next()', async () => {
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-123',
        email: 'test@example.com',
        scope: 'admin',
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockVerifyPcpAccessToken).toHaveBeenCalledWith('test-token', 'pcp_admin');
      // Should NOT call Supabase
      expect(mockGetUser).not.toHaveBeenCalled();
      // Should NOT issue new cookies
      expect(Object.keys(res._cookies)).toHaveLength(0);
    });

    it('should set pcpUserId and email from JWT claims', async () => {
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-abc',
        email: 'admin@test.com',
        scope: 'admin',
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      const authReq = req as any;
      expect(authReq.pcpUserId).toBe('user-abc');
      expect(authReq.user.email).toBe('admin@test.com');
    });

    it('should set request context with correct userId and email', async () => {
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-ctx',
        email: 'ctx@example.com',
        scope: 'admin',
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(capturedRunContext).toEqual({
        userId: 'user-ctx',
        email: 'ctx@example.com',
        workspaceId: 'workspace-1',
        workspaceSource: 'default',
      });
    });

    it('should NOT accept mcp_access tokens as admin auth', async () => {
      // verifyPcpAccessToken returns null when type doesn't match
      mockVerifyPcpAccessToken.mockReturnValue(null);
      // No refresh cookie, no Supabase
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should accept mcp_access tokens only for transcript sync route', async () => {
      mockVerifyPcpAccessToken
        .mockReturnValueOnce(null) // pcp_admin check
        .mockReturnValueOnce({
          type: 'mcp_access',
          sub: 'user-mcp',
          email: 'mcp@example.com',
          scope: 'mcp:tools',
        });

      const req = createMockReq({
        method: 'POST',
        path: '/sessions/session-123/sync-transcript',
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect((req as any).pcpUserId).toBe('user-mcp');
    });

    it('should accept mcp_access tokens for transcript list/export routes', async () => {
      mockVerifyPcpAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
        type: 'mcp_access',
        sub: 'user-mcp',
        email: 'mcp@example.com',
        scope: 'mcp:tools',
      });

      const listReq = createMockReq({
        method: 'GET',
        path: '/sessions/synced',
      });
      const listRes = createMockRes();
      const listNext = vi.fn();

      await middleware(listReq, listRes, listNext);

      expect(listNext).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();

      mockVerifyPcpAccessToken.mockReset();
      mockVerifyPcpAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
        type: 'mcp_access',
        sub: 'user-mcp',
        email: 'mcp@example.com',
        scope: 'mcp:tools',
      });

      const exportReq = createMockReq({
        method: 'GET',
        path: '/sessions/session-123/transcript',
      });
      const exportRes = createMockRes();
      const exportNext = vi.fn();

      await middleware(exportReq, exportRes, exportNext);

      expect(exportNext).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect((exportReq as any).pcpUserId).toBe('user-mcp');
    });
  });

  // =========================================================================
  // Tier 2: Refresh token exchange
  // =========================================================================

  describe('Tier 2: Refresh token exchange', () => {
    beforeEach(() => {
      // Tier 1 fails
      mockVerifyPcpAccessToken.mockReturnValue(null);
    });

    it('should authenticate via refresh cookie and issue new access token cookie', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        refreshToken: 'pcp-rt-rotated',
        refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        userId: 'user-456',
        email: 'refreshed@example.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'pcp-rt-existing' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();

      // Should have called exchangeRefreshToken with correct args
      expect(mockExchangeRefreshToken).toHaveBeenCalledWith(
        expect.anything(), // supabase client
        'pcp-rt-existing',
        'dashboard',
        'pcp_admin',
        3600
      );

      // Should set new access token cookie
      expect(res._cookies['pcp-admin-token']).toBeDefined();
      expect(res._cookies['pcp-admin-token'].value).toBe('new-access-jwt');
      expect(res._cookies['pcp-admin-token'].options).toMatchObject({
        httpOnly: true,
        path: '/api/admin',
        sameSite: 'lax',
      });

      // Should NOT call Supabase auth
      expect(mockGetUser).not.toHaveBeenCalled();

      // SHOULD issue a new refresh cookie: the grant rotated, so the value the
      // browser presented is already dead.
      expect(res._cookies['pcp-admin-refresh'].value).toBe('pcp-rt-rotated');
    });

    it('should set correct user context from refresh exchange', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        userId: 'user-refreshed',
        email: 'refreshed@test.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'pcp-rt-test' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      const authReq = req as any;
      expect(authReq.pcpUserId).toBe('user-refreshed');
      expect(authReq.user.email).toBe('refreshed@test.com');
    });

    it('should fall through to Tier 3 when refresh exchange fails', async () => {
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'pcp-rt-expired' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockExchangeRefreshToken).toHaveBeenCalled();
      expect(mockGetUser).toHaveBeenCalled(); // Fell through to Tier 3
      expect(res._status).toBe(401);
    });

    it('should fall through to Tier 3 when no refresh cookie exists', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq(); // No cookies
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
      expect(mockGetUser).toHaveBeenCalled(); // Fell through to Tier 3
    });

    // -----------------------------------------------------------------------
    // A failed refresh must not send OUR bearer to Supabase.
    //
    // Tier 3 verifies a Supabase access token — what a browser carries on its
    // first request after signing in. A PCP-issued JWT is not one, so handing
    // it over can only come back "Invalid token", which is the exact string the
    // dashboard interceptor turns into a logout. A session whose refresh had
    // just lost a race was therefore logged out by a verifier that never
    // applied to its credential.
    // -----------------------------------------------------------------------

    /** A PCP-shaped bearer: real base64url, our `type` claim, expired. */
    const pcpBearer = (type = 'pcp_admin') => {
      const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return [
        part({ alg: 'HS256', typ: 'JWT' }),
        part({ type, sub: 'user-1', email: 'a@example.invalid', exp: 1 }),
        'sig',
      ].join('.');
    };

    it('should refuse without consulting Supabase when the refresh fails for a PCP bearer', async () => {
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq({
        headers: { authorization: `Bearer ${pcpBearer()}` },
        cookies: { 'pcp-admin-refresh': 'pcp-rt-dead' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockExchangeRefreshToken).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should still reach Supabase for a bearer that is NOT one of ours', async () => {
      // The control. The guard keys on the bearer's shape, so a genuine
      // Supabase token whose stale refresh cookie failed must still be able to
      // sign in — otherwise first-login would break for anyone holding both.
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'tier3@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({ id: 'user-tier3', telegram_id: null, whatsapp_id: null });
      mockDefaultWorkspace();
      mockSignPcpAccessToken.mockReturnValue('signed-admin-jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'pcp-rt-new' });

      const req = createMockReq({
        headers: { authorization: 'Bearer supabase-opaque-token' },
        cookies: { 'pcp-admin-refresh': 'pcp-rt-dead' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockGetUser).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should still reach Supabase for a PCP bearer when no refresh was attempted', async () => {
      // The second control: the guard fires on a FAILED exchange, not on the
      // bearer's shape alone. With no cookie there was no exchange to fail.
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq({
        headers: { authorization: `Bearer ${pcpBearer('mcp_access')}` },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
      expect(mockGetUser).toHaveBeenCalled();
    });

    it('should not refuse when the refresh exchange succeeds, however stale the bearer', async () => {
      // The race this exists for: the retry overlap makes the loser's exchange
      // succeed, and the request must then proceed normally rather than being
      // caught by the guard on its way past.
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'pcp-rt-successor',
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        userId: 'user-raced',
        email: 'raced@test.com',
      });
      mockDefaultWorkspace();

      const req = createMockReq({
        headers: { authorization: `Bearer ${pcpBearer()}` },
        cookies: { 'pcp-admin-refresh': 'pcp-rt-previous' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockGetUser).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(res._cookies['pcp-admin-refresh'].value).toBe('pcp-rt-successor');
      expect((req as any).pcpUserId).toBe('user-raced');
    });
  });

  // =========================================================================
  // Tier 3: Supabase verification (fallback)
  // =========================================================================

  describe('Tier 3: Supabase verification', () => {
    beforeEach(() => {
      // Tiers 1 and 2 fail
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
    });

    it('should authenticate via Supabase and issue PCP cookies', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'tier3@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-tier3',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('signed-admin-jwt');
      mockCreateRefreshToken.mockResolvedValue({
        refreshToken: 'pcp-rt-new',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockGetUser).toHaveBeenCalledWith('test-token');

      // Should issue both cookies
      expect(res._cookies['pcp-admin-token']).toBeDefined();
      expect(res._cookies['pcp-admin-token'].value).toBe('signed-admin-jwt');
      expect(res._cookies['pcp-admin-token'].options).toMatchObject({
        httpOnly: true,
        path: '/api/admin',
        sameSite: 'lax',
      });

      expect(res._cookies['pcp-admin-refresh']).toBeDefined();
      expect(res._cookies['pcp-admin-refresh'].value).toBe('pcp-rt-new');
      expect(res._cookies['pcp-admin-refresh'].options).toMatchObject({
        httpOnly: true,
        path: '/api/admin',
        sameSite: 'lax',
      });

      // Should sign with correct payload
      expect(mockSignPcpAccessToken).toHaveBeenCalledWith(
        { type: 'pcp_admin', sub: 'user-tier3', email: 'tier3@example.com', scope: 'admin' },
        3600
      );

      // Should create refresh token with dashboard client
      expect(mockCreateRefreshToken).toHaveBeenCalledWith(
        expect.anything(),
        'user-tier3',
        'dashboard',
        ['admin'],
        // The grant is issued for its full fixed lifetime; rotation never moves it.
        90
      );
    });

    it('should return 401 when Supabase getUser fails', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Token expired' },
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should auto-provision PCP user on first login', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'new@example.com' } },
        error: null,
      });

      // First query: user not found. Second query (insert): returns new user.
      let callCount = 0;
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.insert = vi.fn(() => chain);
      chain.update = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ data: null, error: null }); // Not found
        }
        return Promise.resolve({
          data: { id: 'new-user', telegram_id: null, whatsapp_id: null },
          error: null,
        });
      });
      mockSupabaseFrom.mockReturnValue(chain);

      mockSignPcpAccessToken.mockReturnValue('admin-jwt');
      mockCreateRefreshToken.mockResolvedValue({
        refreshToken: 'pcp-rt-new',
        expiresAt: new Date(),
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(chain.insert).toHaveBeenCalled();
    });

    it('should still call next() even if cookie creation fails', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-123',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('signed-jwt');
      mockCreateRefreshToken.mockRejectedValue(new Error('DB error'));

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Auth succeeded — next() should be called despite cookie failure
      expect(next).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Workspace resolution
  // =========================================================================

  describe('workspace resolution', () => {
    beforeEach(() => {
      // Use Tier 1 for simplicity
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-ws',
        email: 'ws@example.com',
        scope: 'admin',
      });
    });

    it('should use personal workspace when no x-ink-workspace-id header', async () => {
      mockEnsurePersonalWorkspace.mockResolvedValue({ id: 'personal-ws' });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockEnsurePersonalWorkspace).toHaveBeenCalledWith('user-ws');
      expect((req as any).pcpWorkspaceId).toBe('personal-ws');
      expect((req as any).pcpWorkspaceRole).toBe('member');
    });

    it('should use requested workspace when user is a member', async () => {
      mockFindById.mockResolvedValue({ id: 'requested-ws' });

      const req = createMockReq({
        header: vi.fn((name: string) => {
          if (name === 'x-ink-workspace-id') return 'requested-ws';
          return undefined;
        }),
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect((req as any).pcpWorkspaceId).toBe('requested-ws');
      expect((req as any).pcpWorkspaceRole).toBe('member');
    });

    it('should set request context workspaceSource=header when x-ink-workspace-id is used', async () => {
      mockFindById.mockResolvedValue({ id: 'requested-ws' });

      const req = createMockReq({
        header: vi.fn((name: string) => {
          if (name === 'x-ink-workspace-id') return 'requested-ws';
          return undefined;
        }),
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(capturedRunContext).toMatchObject({
        userId: 'user-ws',
        workspaceId: 'requested-ws',
        workspaceSource: 'header',
      });
    });

    it('should return 404 when requested workspace does not exist', async () => {
      mockFindById.mockResolvedValue(null);
      mockFindRawById.mockResolvedValue(null);

      const req = createMockReq({
        header: vi.fn((name: string) => {
          if (name === 'x-ink-workspace-id') return 'nonexistent-ws';
          return undefined;
        }),
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._status).toBe(404);
      expect(res._json).toEqual({ error: 'Workspace not found' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cookie properties
  // =========================================================================

  describe('cookie security properties', () => {
    it('should set httpOnly on all admin cookies', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-cookie',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.httpOnly).toBe(true);
      expect(res._cookies['pcp-admin-refresh'].options.httpOnly).toBe(true);
    });

    it('should scope cookies to /api/admin path', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-path',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.path).toBe('/api/admin');
      expect(res._cookies['pcp-admin-refresh'].options.path).toBe('/api/admin');
    });

    it('should set sameSite=lax on all admin cookies', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-same',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.sameSite).toBe('lax');
      expect(res._cookies['pcp-admin-refresh'].options.sameSite).toBe('lax');
    });

    it('should set access token maxAge to 1 hour', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-maxage',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.maxAge).toBe(3600 * 1000); // 1 hour in ms
    });

    it('should set the refresh cookie to the full fixed grant lifetime on first issue', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'test@example.com' } },
        error: null,
      });
      mockSupabaseUserLookup({
        id: 'user-refresh-age',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignPcpAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // This is the FIRST issue of a grant, so the cookie carries its whole
      // lifetime. The rotation path is different and must not compute a window
      // this way — it echoes the grant's own deadline back (see the rotation
      // cookie test below), or the cookie would outlive the grant.
      expect(res._cookies['pcp-admin-refresh'].options.maxAge).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });

  // =========================================================================
  // Tier priority / isolation
  // =========================================================================

  describe('tier priority', () => {
    it('should not call Tier 2 or Tier 3 when Tier 1 succeeds', async () => {
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-fast',
        email: 'fast@example.com',
        scope: 'admin',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'some-refresh-token' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('should not call Tier 3 when Tier 2 succeeds', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-jwt',
        userId: 'user-mid',
        email: 'mid@example.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'valid-refresh' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('should not issue new cookies when Tier 1 succeeds', async () => {
      mockVerifyPcpAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-no-cookies',
        email: 'nc@example.com',
        scope: 'admin',
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(Object.keys(res._cookies)).toHaveLength(0);
      expect(mockSignPcpAccessToken).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('should rewrite the refresh cookie when Tier 2 succeeds, because the grant rotated', async () => {
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'refreshed-jwt',
        refreshToken: 'pcp-rt-rotated',
        refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        userId: 'user-t2',
        email: 't2@example.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'existing-refresh' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Both cookies. Leaving the old refresh cookie in place would hand the
      // browser a token the next exchange refuses — a silent hourly logout.
      expect(res._cookies['pcp-admin-token']).toBeDefined();
      expect(res._cookies['pcp-admin-refresh'].value).toBe('pcp-rt-rotated');
    });

    it('should expire the rotated refresh cookie at the GRANT deadline, not a fresh window', async () => {
      // The deadline the grant actually holds — deliberately not 90 days out,
      // and deliberately not a round number, so a cookie computed as
      // `now + ADMIN_REFRESH_TOKEN_LIFETIME_DAYS` cannot coincide with it.
      const grantDeadline = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000 + 12345);
      mockVerifyPcpAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'refreshed-jwt',
        refreshToken: 'pcp-rt-rotated',
        refreshTokenExpiresAt: grantDeadline,
        userId: 'user-t2',
        email: 't2@example.com',
      });

      const req = createMockReq({ cookies: { 'pcp-admin-refresh': 'existing-refresh' } });
      const res = createMockRes();
      await middleware(req, res, vi.fn());

      const opts = res._cookies['pcp-admin-refresh'].options;
      // Echoed, not recomputed. Rotating hourly against a recomputed window
      // would renew the cookie forever while the server-side grant expired.
      expect(opts.expires).toBe(grantDeadline);
      expect(opts.maxAge).toBeUndefined();
    });
  });
});

// =============================================================================
// Logout endpoint
// =============================================================================

describe('POST /auth/logout', () => {
  /** Extract the logout route handler from the router stack */
  function getLogoutHandler(): (req: Request, res: Response) => Promise<void> {
    const layer = (router as any).stack.find(
      (entry: any) => entry.route?.path === '/auth/logout' && entry.route?.methods?.post
    );
    if (!layer) {
      throw new Error('POST /auth/logout route not found in router stack');
    }
    // Express stores route handlers in route.stack[0].handle
    return layer.route.stack[0].handle;
  }

  let logoutHandler: ReturnType<typeof getLogoutHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    logoutHandler = getLogoutHandler();
  });

  it('should clear both admin cookies', async () => {
    const req = createMockReq({ body: {}, cookies: {} });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(res._json).toEqual({ success: true });
    expect(res._clearedCookies['pcp-admin-token']).toBeDefined();
    expect(res._clearedCookies['pcp-admin-token'].options.path).toBe('/api/admin');
    expect(res._clearedCookies['pcp-admin-refresh']).toBeDefined();
    expect(res._clearedCookies['pcp-admin-refresh'].options.path).toBe('/api/admin');
  });

  it('should revoke refresh token from DB when provided in body', async () => {
    const deleteChain: Record<string, any> = {};
    deleteChain.delete = vi.fn(() => deleteChain);
    deleteChain.eq = vi.fn(() => deleteChain);
    deleteChain.in = vi.fn(() => deleteChain);
    mockSupabaseFrom.mockReturnValue(deleteChain);

    const req = createMockReq({
      body: { refreshToken: 'pcp-rt-to-revoke' },
      cookies: {},
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(mockSupabaseFrom).toHaveBeenCalledWith('mcp_tokens');
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', 'pcp-rt-to-revoke');
    // Revocation spans BOTH client ids: a refresh token presented at logout
    // dies whether it was minted for the dashboard or the mobile app.
    expect(deleteChain.in).toHaveBeenCalledWith('client_id', ['dashboard', 'mobile']);
    expect(res._json).toEqual({ success: true });
  });

  it('should revoke refresh token from cookie when not in body', async () => {
    const deleteChain: Record<string, any> = {};
    deleteChain.delete = vi.fn(() => deleteChain);
    deleteChain.eq = vi.fn(() => deleteChain);
    deleteChain.in = vi.fn(() => deleteChain);
    mockSupabaseFrom.mockReturnValue(deleteChain);

    const req = createMockReq({
      body: {},
      cookies: { 'pcp-admin-refresh': 'pcp-rt-from-cookie' },
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', 'pcp-rt-from-cookie');
    expect(res._json).toEqual({ success: true });
  });

  it('should revoke a secret the grant has already rotated away from', async () => {
    // A browser can easily present the value a rotation just replaced — a
    // background tab refreshed, or this request was already in flight. Matching
    // only `refresh_token` deletes nothing: the cookies clear, the user sees a
    // logout, and the grant lives on. Since the retry overlap it is worse than
    // untidy, because for the length of that window the secret they just
    // "logged out" with is still redeemable.
    const deleteChain: Record<string, any> = {};
    deleteChain.delete = vi.fn(() => deleteChain);
    deleteChain.eq = vi.fn(() => deleteChain);
    deleteChain.in = vi.fn(() => deleteChain);
    mockSupabaseFrom.mockReturnValue(deleteChain);

    const req = createMockReq({
      body: {},
      cookies: { 'pcp-admin-refresh': 'pcp-rt-stale' },
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', 'pcp-rt-stale');
    expect(deleteChain.eq).toHaveBeenCalledWith('previous_refresh_token', 'pcp-rt-stale');
    // Both statements are scoped to the same two clients — the second must not
    // be a wider delete than the first.
    expect(deleteChain.in).toHaveBeenCalledTimes(2);
    expect(deleteChain.in).toHaveBeenNthCalledWith(1, 'client_id', ['dashboard', 'mobile']);
    expect(deleteChain.in).toHaveBeenNthCalledWith(2, 'client_id', ['dashboard', 'mobile']);
  });

  it('should send the token as a value, never as filter syntax', async () => {
    // The token arrives from a request body. PostgREST's `or` filter is a
    // parsed expression, so interpolating caller text into one is an injection
    // surface; `.eq()` sends a parameter. A hostile value must reach the
    // database intact and unparsed.
    const hostile = 'x,client_id.neq.nothing';
    const deleteChain: Record<string, any> = {};
    deleteChain.delete = vi.fn(() => deleteChain);
    deleteChain.eq = vi.fn(() => deleteChain);
    deleteChain.in = vi.fn(() => deleteChain);
    deleteChain.or = vi.fn(() => deleteChain);
    mockSupabaseFrom.mockReturnValue(deleteChain);

    const req = createMockReq({ body: { refreshToken: hostile }, cookies: {} });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(deleteChain.or).not.toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', hostile);
    expect(deleteChain.eq).toHaveBeenCalledWith('previous_refresh_token', hostile);
  });

  it('should succeed even with no refresh token (just clears cookies)', async () => {
    const req = createMockReq({ body: {}, cookies: {} });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(res._json).toEqual({ success: true });
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });

  it('should still clear cookies and return success when DB revocation fails', async () => {
    mockSupabaseFrom.mockImplementation(() => {
      throw new Error('DB connection error');
    });

    const req = createMockReq({
      body: { refreshToken: 'pcp-rt-fail' },
      cookies: {},
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(res._json).toEqual({ success: true });
    expect(res._clearedCookies['pcp-admin-token']).toBeDefined();
    expect(res._clearedCookies['pcp-admin-refresh']).toBeDefined();
  });

  it('should not require authentication', async () => {
    // Verify the logout route is registered BEFORE the auth middleware
    const stack = (router as any).stack;
    const logoutIndex = stack.findIndex((entry: any) => entry.route?.path === '/auth/logout');
    const middlewareIndex = stack.findIndex(
      (entry: any) =>
        entry.name === 'adminAuthMiddleware' || entry.handle?.name === 'adminAuthMiddleware'
    );

    expect(logoutIndex).toBeGreaterThanOrEqual(0);
    expect(middlewareIndex).toBeGreaterThan(logoutIndex);
  });
});
