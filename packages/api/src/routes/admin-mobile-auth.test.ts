/**
 * Mobile auth routes: POST /auth/mobile-login and /auth/mobile-refresh.
 *
 * These mint the same pcp_admin JWT the middleware's Tier 1 verifies, but
 * return it in the response body instead of cookies — React Native's fetch
 * does not manage httpOnly cookies reliably. What's pinned here:
 *
 *  - credentials are verified against Supabase, and a failure is a 401 with
 *    the same body for wrong-password and unknown-account (no oracle);
 *  - the tokens issued carry type 'pcp_admin' and the 'mobile' client_id —
 *    the two facts that make the rest of the admin surface accept them;
 *  - repeated failures rate-limit to 429 before Supabase is consulted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockSignPcpAccessToken = vi.fn();
const mockCreateRefreshToken = vi.fn();
const mockExchangeRefreshToken = vi.fn();
const mockVerifyPcpAccessToken = vi.fn();

vi.mock('../auth/pcp-tokens', () => ({
  signPcpAccessToken: (...args: unknown[]) => mockSignPcpAccessToken(...args),
  createRefreshToken: (...args: unknown[]) => mockCreateRefreshToken(...args),
  exchangeRefreshToken: (...args: unknown[]) => mockExchangeRefreshToken(...args),
  verifyPcpAccessToken: (...args: unknown[]) => mockVerifyPcpAccessToken(...args),
}));

const mockSignInWithPassword = vi.fn();
const mockSupabaseFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithPassword: mockSignInWithPassword, getUser: vi.fn() },
    from: mockSupabaseFrom,
  })),
}));

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ repositories: {}, getClient: vi.fn() })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => Promise<void>;

function getRouteHandler(method: 'post' | 'get', path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createReq(body: Record<string, unknown>, ip = '1.2.3.4'): Request {
  return { body, ip, headers: {}, cookies: {}, params: {} } as unknown as Request;
}

interface MockResponse extends Response {
  _status: number;
  _json: unknown;
}

function createRes(): MockResponse {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: unknown) {
      res._json = payload;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

/** users-table chain where select().eq().single() resolves to `user`. */
function mockUsersTable(user: Record<string, unknown> | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn(() => Promise.resolve({ data: user, error: null }));
  mockSupabaseFrom.mockImplementation(() => chain);
  return chain;
}

const login = getRouteHandler('post', '/auth/mobile-login');
const refresh = getRouteHandler('post', '/auth/mobile-refresh');

beforeEach(() => {
  vi.clearAllMocks();
  mockSignPcpAccessToken.mockReturnValue('signed-access-jwt');
  mockCreateRefreshToken.mockResolvedValue({
    refreshToken: 'pcp-rt-fresh',
    expiresAt: new Date('2027-01-01'),
  });
});

// ---------------------------------------------------------------------------
// /auth/mobile-login
// ---------------------------------------------------------------------------

describe('POST /auth/mobile-login', () => {
  it('rejects a request without credentials', async () => {
    const res = createRes();
    await login(createReq({ email: 'a@b.co' }), res);
    expect(res._status).toBe(400);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('returns 401 with an oracle-free body on bad credentials', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = createRes();
    await login(createReq({ email: 'a@b.co', password: 'wrong' }), res);

    expect(res._status).toBe(401);
    // The Supabase error text (which distinguishes cases) must not leak.
    expect(res._json).toEqual({ error: 'Invalid email or password' });
  });

  it('issues a pcp_admin token pair with the mobile client_id on success', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'sb-user', email: 'a@b.co' } },
      error: null,
    });
    mockUsersTable({ id: 'pcp-user-1' });

    const res = createRes();
    await login(createReq({ email: 'A@B.co', password: 'right' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      accessToken: 'signed-access-jwt',
      refreshToken: 'pcp-rt-fresh',
      userId: 'pcp-user-1',
      email: 'a@b.co', // normalized
    });
    // Type pcp_admin is what lets the token pass the middleware's Tier 1.
    expect(mockSignPcpAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pcp_admin', sub: 'pcp-user-1', email: 'a@b.co' }),
      expect.any(Number)
    );
    // client_id 'mobile' — separately revocable from dashboard tokens.
    expect(mockCreateRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      'pcp-user-1',
      'mobile',
      ['admin'],
      expect.any(Number)
    );
  });

  it('provisions a PCP user when the email has no row yet', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'sb-user', email: 'new@b.co' } },
      error: null,
    });
    // First single() (lookup) → null; insert path's single() → created row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {};
    chain.select = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.single = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { id: 'pcp-new' }, error: null });
    mockSupabaseFrom.mockImplementation(() => chain);

    const res = createRes();
    await login(createReq({ email: 'new@b.co', password: 'right' }), res);

    expect(res._status).toBe(200);
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@b.co' }));
    expect((res._json as { userId: string }).userId).toBe('pcp-new');
  });

  it('rate-limits repeated attempts before consulting Supabase', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'nope' },
    });

    // Distinct ip+email bucket so other tests' attempts don't bleed in.
    const req = () => createReq({ email: 'burst@b.co', password: 'x' }, '9.9.9.9');
    for (let i = 0; i < 10; i += 1) {
      await login(req(), createRes());
    }
    mockSignInWithPassword.mockClear();

    const res = createRes();
    await login(req(), res);

    expect(res._status).toBe(429);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /auth/mobile-refresh
// ---------------------------------------------------------------------------

describe('POST /auth/mobile-refresh', () => {
  it('rejects a request without a refresh token', async () => {
    const res = createRes();
    await refresh(createReq({}), res);
    expect(res._status).toBe(400);
  });

  it('returns 401 when the exchange fails', async () => {
    mockExchangeRefreshToken.mockResolvedValue(null);
    const res = createRes();
    await refresh(createReq({ refreshToken: 'pcp-rt-dead' }), res);
    expect(res._status).toBe(401);
  });

  it('exchanges against the mobile client_id and returns the token in-body', async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      accessToken: 'renewed-jwt',
      userId: 'pcp-user-1',
      email: 'a@b.co',
    });

    const res = createRes();
    await refresh(createReq({ refreshToken: 'pcp-rt-live' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ accessToken: 'renewed-jwt', userId: 'pcp-user-1' });
    expect(mockExchangeRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      'pcp-rt-live',
      'mobile',
      'pcp_admin',
      expect.any(Number)
    );
  });
});

// ---------------------------------------------------------------------------
// /auth/logout revokes mobile tokens too
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('deletes refresh tokens for BOTH dashboard and mobile client ids', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {};
    chain.delete = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => Promise.resolve({ data: null, error: null }));
    mockSupabaseFrom.mockImplementation(() => chain);

    const logout = getRouteHandler('post', '/auth/logout');
    const res = createRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).clearCookie = vi.fn();
    await logout(createReq({ refreshToken: 'pcp-rt-mobile' }), res);

    // The route must not filter to the dashboard client alone — a mobile
    // logout would then silently leave its 90-day token alive.
    expect(chain.in).toHaveBeenCalledWith('client_id', ['dashboard', 'mobile']);
  });
});
