/**
 * Admin Auth Middleware Tests
 *
 * Tests the three-tier authentication flow:
 * - Tier 1: Inkwell admin access JWT (local verify, ~0ms)
 * - Tier 2: Refresh token exchange via cookie (1 DB call)
 * - Tier 3: Supabase verification (network call, first login only)
 *
 * Also tests cookie issuance, workspace resolution, and edge cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Mocks for ink-tokens (the shared auth module)
// ---------------------------------------------------------------------------

const mockVerifyInkAccessToken = vi.fn();
const mockExchangeRefreshToken = vi.fn();
const mockSignInkAccessToken = vi.fn();
const mockCreateRefreshToken = vi.fn();

vi.mock('../auth/ink-tokens', () => ({
  verifyInkAccessToken: (...args: unknown[]) => mockVerifyInkAccessToken(...args),
  exchangeRefreshToken: (...args: unknown[]) => mockExchangeRefreshToken(...args),
  signInkAccessToken: (...args: unknown[]) => mockSignInkAccessToken(...args),
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

// The account is resolved by its sign-in (services/account-deletion/
// principal.ts, tested against a real database); here it answers with the
// row each test's lookup names.
const mockResolvePrincipal = vi.fn();
vi.mock('../services/account-deletion/principal', () => ({
  resolveAccountForPrincipal: (...args: unknown[]) => mockResolvePrincipal(...args),
}));

const mockFindById = vi.fn();
const mockFindByIdWithRole = vi.fn();
const mockGetMemberRole = vi.fn();
const mockFindRawById = vi.fn();
const mockEnsurePersonalWorkspace = vi.fn();
const mockListTrustedUsers = vi.fn();

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: {
      workspaces: {
        findById: mockFindById,
        findByIdWithRole: mockFindByIdWithRole,
        getMemberRole: mockGetMemberRole,
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
import { accountGate } from '../services/account-deletion/gate';

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
    // A real response is an event emitter; the account lease listens for 'close'.
    once() {
      return this;
    },
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
function mockSupabaseUserLookup(inkUser: Record<string, unknown>) {
  const userChain: Record<string, any> = {};
  userChain.select = vi.fn(() => userChain);
  userChain.insert = vi.fn(() => userChain);
  userChain.update = vi.fn(() => userChain);
  userChain.eq = vi.fn(() => userChain);
  userChain.single = vi.fn(() => Promise.resolve({ data: inkUser, error: null }));
  userChain.maybeSingle = vi.fn(() => Promise.resolve({ data: inkUser, error: null }));

  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'users') return userChain;
    return userChain; // fallback
  });
  mockResolvePrincipal.mockResolvedValue({ ok: true, userId: inkUser.id, created: false });

  return userChain;
}

/**
 * Every account a token names exists unless a test says otherwise: the users
 * read tiers 1 and 2 make answers with the row for the id it is asked about.
 */
function mockAccountsExist() {
  mockSupabaseFrom.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    let id = '';
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((_column: string, value: string) => {
      id = value;
      return chain;
    });
    const row = () => ({
      data: table === 'users' ? { id, telegram_id: null, whatsapp_id: null } : null,
      error: null,
    });
    chain.maybeSingle = vi.fn(() => Promise.resolve(row()));
    chain.single = vi.fn(() => Promise.resolve(row()));
    return chain;
  });
}

/** Standard workspace mock that returns a personal workspace */
function mockDefaultWorkspace() {
  mockEnsurePersonalWorkspace.mockResolvedValue({ id: 'workspace-1' });
  // The personal workspace's one membership row: its owner.
  mockGetMemberRole.mockResolvedValue('owner');
  mockFindById.mockResolvedValue(null);
  mockFindByIdWithRole.mockResolvedValue(null);
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
    mockAccountsExist();
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
  // Tier 1: Inkwell admin JWT
  // =========================================================================

  describe('Tier 1: Inkwell admin access JWT', () => {
    it('should authenticate via valid Inkwell admin JWT and call next()', async () => {
      mockVerifyInkAccessToken.mockReturnValue({
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
      expect(mockVerifyInkAccessToken).toHaveBeenCalledWith('test-token', 'pcp_admin');
      // Should NOT call Supabase
      expect(mockGetUser).not.toHaveBeenCalled();
      // Should NOT issue new cookies
      expect(Object.keys(res._cookies)).toHaveLength(0);
    });

    it('refuses an account that is being deleted, at every tier, and holds its gate while a request runs', async () => {
      mockVerifyInkAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub: 'user-closing',
        email: 'closing@example.com',
        scope: 'admin',
      });

      // Open: the request holds the account's gate until its response closes.
      const listeners: Array<() => void> = [];
      const open = createMockRes();
      (open as unknown as { once: (event: string, fn: () => void) => void }).once = (
        event: string,
        fn: () => void
      ) => {
        if (event === 'close') listeners.push(fn);
      };
      const next = vi.fn();
      await middleware(createMockReq(), open, next);
      expect(next).toHaveBeenCalled();
      expect(accountGate.inFlightCount('user-closing')).toBe(1);
      for (const fn of listeners) fn();
      expect(accountGate.inFlightCount('user-closing')).toBe(0);

      // Closed: answered 403, and nothing behind the middleware runs.
      accountGate.close('user-closing');
      try {
        const res = createMockRes();
        const refusedNext = vi.fn();
        await middleware(createMockReq(), res, refusedNext);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'This account is being deleted' });
        expect(refusedNext).not.toHaveBeenCalled();
        expect(accountGate.inFlightCount('user-closing')).toBe(0);
      } finally {
        accountGate.forget('user-closing');
      }
    });

    it('should set inkUserId and email from JWT claims', async () => {
      mockVerifyInkAccessToken.mockReturnValue({
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
      expect(authReq.inkUserId).toBe('user-abc');
      expect(authReq.user.email).toBe('admin@test.com');
    });

    it('should set request context with correct userId and email', async () => {
      mockVerifyInkAccessToken.mockReturnValue({
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
      // verifyInkAccessToken returns null when type doesn't match
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockVerifyInkAccessToken
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
      expect((req as any).inkUserId).toBe('user-mcp');
    });

    it('never accepts an agent’s mcp_access token for saved logins', async () => {
      // A token that verifies as mcp_access, whichever audience is asked.
      mockVerifyInkAccessToken.mockImplementation((_token: string, type: string) =>
        type === 'mcp_access'
          ? { type: 'mcp_access', sub: 'user-mcp', email: 'mcp@example.com', scope: 'mcp:tools' }
          : null
      );
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
      for (const [method, path] of [
        ['GET', '/vault/logins'],
        ['POST', '/vault/logins'],
        ['GET', '/vault/logins/login-1'],
        ['POST', '/vault/logins/login-1/reveal'],
        ['POST', '/vault/logins/login-1/code'],
      ]) {
        const req = createMockReq({ method, path });
        const res = createMockRes();
        const next = vi.fn();
        await middleware(req, res, next);
        expect(res._status).toBe(401);
        expect(next).not.toHaveBeenCalled();
        expect((req as any).inkUserId).toBeUndefined();
      }
      // The control: the same token passes on a route that admits it.
      const req = createMockReq({ method: 'GET', path: '/sessions/synced' });
      const next = vi.fn();
      await middleware(req, createMockRes(), next);
      expect(next).toHaveBeenCalled();
      // clearAllMocks keeps an implementation; don't hand this one to the next test.
      mockVerifyInkAccessToken.mockReset();
    });

    it("keeps a runner token's signed identity for an approval request (Approvals step A)", async () => {
      const sbId = '77777777-7777-4777-8777-777777777777';
      mockVerifyInkAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
        type: 'mcp_access',
        sub: 'user-mcp',
        email: 'mcp@example.com',
        scope: 'mcp:tools',
        sbSlug: 'kindle-abc',
        sbId,
      });

      const req = createMockReq({ method: 'POST', path: '/approval-requests' });
      const next = vi.fn();
      await middleware(req, createMockRes(), next);

      expect(next).toHaveBeenCalled();
      expect((req as any).inkUserId).toBe('user-mcp');
      expect((req as any).inkTokenSbId).toBe(sbId);
    });

    it("reads an older runner token's identityId the same way", async () => {
      const identityId = '66666666-6666-4666-8666-666666666666';
      mockVerifyInkAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
        type: 'mcp_access',
        sub: 'user-mcp',
        email: 'mcp@example.com',
        scope: 'mcp:tools',
        identityId,
      });

      const req = createMockReq({ method: 'POST', path: '/approval-requests' });
      await middleware(req, createMockRes(), vi.fn());

      expect((req as any).inkTokenSbId).toBe(identityId);
    });

    it("gives a person's admin token no signed identity", async () => {
      mockVerifyInkAccessToken.mockReturnValueOnce({
        type: 'pcp_admin',
        sub: 'user-admin',
        email: 'admin@example.com',
        scope: 'admin',
      });

      const req = createMockReq({ method: 'POST', path: '/approval-requests' });
      (req as any).inkTokenSbId = 'left-over-from-a-reused-request';
      await middleware(req, createMockRes(), vi.fn());

      expect((req as any).inkTokenSbId).toBeUndefined();
    });

    it('should accept mcp_access tokens for transcript list/export routes', async () => {
      mockVerifyInkAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
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

      mockVerifyInkAccessToken.mockReset();
      mockVerifyInkAccessToken.mockReturnValueOnce(null).mockReturnValueOnce({
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
      expect((exportReq as any).inkUserId).toBe('user-mcp');
    });
  });

  // =========================================================================
  // An account deleted after its token was signed (task 7ee3c7be)
  // =========================================================================

  describe('an account that is gone', () => {
    /** The users read answers with no row, or fails, for whichever id it is asked about. */
    function accountsRead(answer: { data: null; error: { message: string } | null }) {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(() => Promise.resolve(answer));
      chain.single = vi.fn(() => Promise.resolve(answer));
      mockSupabaseFrom.mockImplementation(() => chain);
      return chain;
    }
    const nothingProvisioned = () => {
      expect(mockEnsurePersonalWorkspace).not.toHaveBeenCalled();
      expect(mockFindByIdWithRole).not.toHaveBeenCalled();
      expect(mockFindRawById).not.toHaveBeenCalled();
    };
    const adminToken = (sub: string) =>
      mockVerifyInkAccessToken.mockReturnValue({
        type: 'pcp_admin',
        sub,
        email: 'gone@example.com',
        scope: 'admin',
      });

    it('refuses a signed token whose account is gone with 401, before any workspace is looked up or made, with or without a space named', async () => {
      accountsRead({ data: null, error: null });
      adminToken('user-gone');
      for (const headers of [
        { authorization: 'Bearer test-token' },
        { authorization: 'Bearer test-token', 'x-ink-workspace-id': 'workspace-1' },
      ]) {
        const res = createMockRes();
        const next = vi.fn();
        await middleware(createMockReq({ headers }), res, next);
        expect(res._status).toBe(401);
        expect(res._json).toEqual({ error: 'Account not found' });
        expect(next).not.toHaveBeenCalled();
      }
      nothingProvisioned();
      // The gate was never closed for it, as after a restart: the read decides.
      expect(accountGate.isClosed('user-gone')).toBe(false);
    });

    it('refuses a refresh cookie whose account is gone the same way', async () => {
      accountsRead({ data: null, error: null });
      mockVerifyInkAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        userId: 'user-gone',
        email: 'gone@example.com',
      });
      const res = createMockRes();
      const next = vi.fn();
      await middleware(
        createMockReq({ cookies: { 'pcp-admin-refresh': 'ink-rt-left' } }),
        res,
        next
      );
      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
      nothingProvisioned();
    });

    it('refuses with 503 when the account cannot be read, never letting the request through', async () => {
      accountsRead({ data: null, error: { message: 'connection reset' } });
      adminToken('user-unread');
      const res = createMockRes();
      const next = vi.fn();
      await middleware(createMockReq(), res, next);
      expect(res._status).toBe(503);
      expect(next).not.toHaveBeenCalled();
      nothingProvisioned();
    });

    it('reads the account once for a signed token and reuses the row for trusted access', async () => {
      adminToken('user-123');
      await middleware(createMockReq(), createMockRes(), vi.fn());
      const usersReads = mockSupabaseFrom.mock.calls.filter(([table]) => table === 'users');
      expect(usersReads).toHaveLength(1);
    });
  });

  // =========================================================================
  // Tier 2: Refresh token exchange
  // =========================================================================

  describe('Tier 2: Refresh token exchange', () => {
    beforeEach(() => {
      // Tier 1 fails
      mockVerifyInkAccessToken.mockReturnValue(null);
    });

    it('should authenticate via refresh cookie and issue new access token cookie', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        userId: 'user-456',
        email: 'refreshed@example.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'ink-rt-existing' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();

      // Should have called exchangeRefreshToken with correct args
      expect(mockExchangeRefreshToken).toHaveBeenCalledWith(
        expect.anything(), // supabase client
        'ink-rt-existing',
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

      // Should NOT issue a new refresh cookie (stays the same)
      expect(res._cookies['pcp-admin-refresh']).toBeUndefined();
    });

    it('should set correct user context from refresh exchange', async () => {
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'new-access-jwt',
        userId: 'user-refreshed',
        email: 'refreshed@test.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'ink-rt-test' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      const authReq = req as any;
      expect(authReq.inkUserId).toBe('user-refreshed');
      expect(authReq.user.email).toBe('refreshed@test.com');
    });

    it('should fall through to Tier 3 when refresh exchange fails', async () => {
      mockExchangeRefreshToken.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'ink-rt-expired' },
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
  });

  // =========================================================================
  // Tier 3: Supabase verification (fallback)
  // =========================================================================

  describe('Tier 3: Supabase verification', () => {
    beforeEach(() => {
      // Tiers 1 and 2 fail
      mockVerifyInkAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue(null);
    });

    it('should authenticate via Supabase and issue Inkwell cookies', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { email: 'tier3@example.com' } },
        error: null,
      });
      const usersChain = mockSupabaseUserLookup({
        id: 'user-tier3',
        telegram_id: null,
        whatsapp_id: null,
      });
      mockSignInkAccessToken.mockReturnValue('signed-admin-jwt');
      mockCreateRefreshToken.mockResolvedValue({
        refreshToken: 'ink-rt-new',
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
      expect(res._cookies['pcp-admin-refresh'].value).toBe('ink-rt-new');
      expect(res._cookies['pcp-admin-refresh'].options).toMatchObject({
        httpOnly: true,
        path: '/api/admin',
        sameSite: 'lax',
      });

      // Should sign with correct payload
      expect(mockSignInkAccessToken).toHaveBeenCalledWith(
        { type: 'pcp_admin', sub: 'user-tier3', email: 'tier3@example.com', scope: 'admin' },
        3600
      );
      // Its account was resolved from the database already: no second read.
      expect(usersChain.maybeSingle).not.toHaveBeenCalled();

      // Should create refresh token with dashboard client
      expect(mockCreateRefreshToken).toHaveBeenCalledWith(
        expect.anything(),
        'user-tier3',
        'dashboard',
        ['admin'],
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

    it('should auto-provision Inkwell user on first login', async () => {
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

      mockSignInkAccessToken.mockReturnValue('admin-jwt');
      mockCreateRefreshToken.mockResolvedValue({
        refreshToken: 'ink-rt-new',
        expiresAt: new Date(),
      });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      mockResolvePrincipal.mockResolvedValue({ ok: true, userId: 'new-user', created: true });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockResolvePrincipal).toHaveBeenCalledWith(expect.anything(), {
        authUid: undefined,
        email: 'new@example.com',
        create: true,
      });
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
      mockSignInkAccessToken.mockReturnValue('signed-jwt');
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
      mockVerifyInkAccessToken.mockReturnValue({
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
      expect((req as any).inkWorkspaceId).toBe('personal-ws');
      // The role is the membership row's — the personal workspace's owner.
      expect(mockGetMemberRole).toHaveBeenCalledWith('personal-ws', 'user-ws');
      expect((req as any).inkWorkspaceRole).toBe('owner');
    });

    it('refuses a personal workspace with no membership row rather than assuming a role', async () => {
      mockEnsurePersonalWorkspace.mockResolvedValue({ id: 'personal-ws' });
      mockGetMemberRole.mockResolvedValue(null);

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    it('should use requested workspace when user is a member, with the role the membership row carries', async () => {
      mockFindByIdWithRole.mockResolvedValue({ workspace: { id: 'requested-ws' }, role: 'viewer' });

      const req = createMockReq({
        header: vi.fn((name: string) => {
          if (name === 'x-ink-workspace-id') return 'requested-ws';
          return undefined;
        }),
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect((req as any).inkWorkspaceId).toBe('requested-ws');
      expect((req as any).inkWorkspaceRole).toBe('viewer');
    });

    it('should set request context workspaceSource=header when x-ink-workspace-id is used', async () => {
      mockFindByIdWithRole.mockResolvedValue({ workspace: { id: 'requested-ws' }, role: 'member' });

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
      mockFindByIdWithRole.mockResolvedValue(null);
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
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockSignInkAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.httpOnly).toBe(true);
      expect(res._cookies['pcp-admin-refresh'].options.httpOnly).toBe(true);
    });

    it('should scope cookies to /api/admin path', async () => {
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockSignInkAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.path).toBe('/api/admin');
      expect(res._cookies['pcp-admin-refresh'].options.path).toBe('/api/admin');
    });

    it('should set sameSite=lax on all admin cookies', async () => {
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockSignInkAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.sameSite).toBe('lax');
      expect(res._cookies['pcp-admin-refresh'].options.sameSite).toBe('lax');
    });

    it('should set access token maxAge to 1 hour', async () => {
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockSignInkAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-token'].options.maxAge).toBe(3600 * 1000); // 1 hour in ms
    });

    it('should set refresh token maxAge to 90 days', async () => {
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockSignInkAccessToken.mockReturnValue('jwt');
      mockCreateRefreshToken.mockResolvedValue({ refreshToken: 'rt', expiresAt: new Date() });

      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res._cookies['pcp-admin-refresh'].options.maxAge).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });

  // =========================================================================
  // Tier priority / isolation
  // =========================================================================

  describe('tier priority', () => {
    it('should not call Tier 2 or Tier 3 when Tier 1 succeeds', async () => {
      mockVerifyInkAccessToken.mockReturnValue({
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
      mockVerifyInkAccessToken.mockReturnValue(null);
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
      mockVerifyInkAccessToken.mockReturnValue({
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
      expect(mockSignInkAccessToken).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('should not issue refresh cookie when Tier 2 succeeds (only access cookie)', async () => {
      mockVerifyInkAccessToken.mockReturnValue(null);
      mockExchangeRefreshToken.mockResolvedValue({
        accessToken: 'refreshed-jwt',
        userId: 'user-t2',
        email: 't2@example.com',
      });

      const req = createMockReq({
        cookies: { 'pcp-admin-refresh': 'existing-refresh' },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Only access token cookie, not refresh
      expect(res._cookies['pcp-admin-token']).toBeDefined();
      expect(res._cookies['pcp-admin-refresh']).toBeUndefined();
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
      body: { refreshToken: 'ink-rt-to-revoke' },
      cookies: {},
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(mockSupabaseFrom).toHaveBeenCalledWith('mcp_tokens');
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', 'ink-rt-to-revoke');
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
      cookies: { 'pcp-admin-refresh': 'ink-rt-from-cookie' },
    });
    const res = createMockRes();

    await logoutHandler(req, res);

    expect(deleteChain.eq).toHaveBeenCalledWith('refresh_token', 'ink-rt-from-cookie');
    expect(res._json).toEqual({ success: true });
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
      body: { refreshToken: 'ink-rt-fail' },
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
