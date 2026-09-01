/**
 * Mobile auth routes: POST /auth/mobile-login, /auth/mobile-refresh,
 * /auth/mobile-signup, and the pairing pair /auth/mobile-pair (+ /claim).
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
const mockSignUp = vi.fn();
const mockSupabaseFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { signInWithPassword: mockSignInWithPassword, signUp: mockSignUp, getUser: vi.fn() },
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

// Mutable so individual tests can run the routes "in production".
const envState = vi.hoisted(() => ({ dev: true, mcpBaseUrl: undefined as string | undefined }));

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
    get MCP_BASE_URL() {
      return envState.mcpBaseUrl;
    },
  },
  isDevelopment: () => envState.dev,
}));

/** Run `fn` with the routes believing they are in production. */
async function inProduction(fn: () => Promise<void>, mcpBaseUrl?: string) {
  envState.dev = false;
  envState.mcpBaseUrl = mcpBaseUrl;
  try {
    await fn();
  } finally {
    envState.dev = true;
    envState.mcpBaseUrl = undefined;
  }
}

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import QRCode from 'qrcode';
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

function createReq(
  body: Record<string, unknown>,
  ip = '1.2.3.4',
  extra: Record<string, unknown> = {}
): Request {
  return {
    body,
    ip,
    headers: {},
    cookies: {},
    params: {},
    protocol: 'http',
    get: () => undefined,
    ...extra,
  } as unknown as Request;
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
const signup = getRouteHandler('post', '/auth/mobile-signup');
const pairStart = getRouteHandler('post', '/auth/mobile-pair');
const pairClaim = getRouteHandler('post', '/auth/mobile-pair/claim');

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

describe('credential-route limiter', () => {
  it('caps one IP across DISTINCT emails, not just per account', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: 'nope' },
    });
    // 30 attempts from one address, every one a different email: each
    // per-account bucket sees a single hit, so only the per-IP ceiling can stop it.
    for (let i = 0; i < 30; i += 1) {
      const res = createRes();
      await login(createReq({ email: `spray-${i}@b.co`, password: 'x' }, '7.7.7.7'), res);
      expect(res._status, `attempt ${i}`).toBe(401);
    }
    mockSignInWithPassword.mockClear();

    const res = createRes();
    await login(createReq({ email: 'spray-final@b.co', password: 'x' }, '7.7.7.7'), res);

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

// ---------------------------------------------------------------------------
// /auth/mobile-signup
// ---------------------------------------------------------------------------

describe('POST /auth/mobile-signup', () => {
  it('enforces the password policy before touching Supabase', async () => {
    let res = createRes();
    await signup(createReq({ email: 'new@b.co', password: 'short1' }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/8 characters/);

    res = createRes();
    await signup(createReq({ email: 'new@b.co', password: 'nonumbershere' }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/number/);

    res = createRes();
    await signup(createReq({ email: 'not-an-email', password: 'valid1234' }), res);
    expect(res._status).toBe(400);

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('asks for email confirmation when Supabase returns no session', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'sb-new', email: 'new@b.co' }, session: null },
      error: null,
    });

    const res = createRes();
    await signup(createReq({ email: 'New@B.co', password: 'valid1234' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ confirmationRequired: true, email: 'new@b.co' });
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('does not reveal that an account already exists', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'User already registered' },
    });

    const res = createRes();
    await signup(createReq({ email: 'old@b.co', password: 'valid1234' }), res);

    // Same shape and status as a brand-new signup.
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ confirmationRequired: true, email: 'old@b.co' });
  });

  it('signs the phone straight in when the project skips confirmation', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'sb-new', email: 'new@b.co' }, session: { access_token: 'sb' } },
      error: null,
    });
    mockUsersTable({ id: 'pcp-user-9' });

    const res = createRes();
    await signup(createReq({ email: 'new@b.co', password: 'valid1234' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      confirmationRequired: false,
      accessToken: 'signed-access-jwt',
      refreshToken: 'pcp-rt-fresh',
      userId: 'pcp-user-9',
      email: 'new@b.co',
    });
    expect(mockCreateRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      'pcp-user-9',
      'mobile',
      ['admin'],
      expect.any(Number)
    );
  });
});

// ---------------------------------------------------------------------------
// /auth/mobile-pair — issuing a code (authenticated)
// ---------------------------------------------------------------------------

describe('POST /auth/mobile-pair', () => {
  it('stores a single-use code under the mobile-pair client and renders the QR', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {};
    chain.delete = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.lt = vi.fn(() => Promise.resolve({ error: null }));
    chain.insert = vi.fn(() => Promise.resolve({ error: null }));
    mockSupabaseFrom.mockImplementation(() => chain);
    const qrSpy = vi.spyOn(QRCode, 'toDataURL');

    const res = createRes();
    await pairStart(
      createReq({}, '1.2.3.4', {
        pcpUserId: 'pcp-user-1',
        get: (name: string) => (name.toLowerCase() === 'host' ? '192.168.1.20:3001' : undefined),
      }),
      res
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      code: string;
      expiresInSeconds: number;
      urls: string[];
      qrDataUrl: string;
    };
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.expiresInSeconds).toBe(600);
    // Development: plain-HTTP LAN addresses are offered, and flagged as such.
    expect((res._json as { insecureTransport: boolean }).insecureTransport).toBe(true);
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // The dashboard's own host is offered; loopback never is.
    expect(body.urls).toContain('http://192.168.1.20:3001');
    expect(body.urls.some((u) => /localhost|127\.0\.0\.1/.test(u))).toBe(false);

    // Stored form: the bare code under its own client_id, ~10 minutes of life.
    const inserted = chain.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      user_id: 'pcp-user-1',
      client_id: 'mobile-pair',
      scopes: ['admin'],
      refresh_token: `pcp-pair-${body.code.replace(/-/g, '')}`,
    });
    const ttlMs = new Date(inserted.expires_at as string).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);

    // The QR carries the bare code and the same URL list.
    const payload = JSON.parse(String(qrSpy.mock.calls[0][0])) as {
      ink: number;
      c: string;
      u: string[];
    };
    expect(payload).toEqual({ ink: 1, c: body.code.replace(/-/g, ''), u: body.urls });
    qrSpy.mockRestore();
  });
});

describe('POST /auth/mobile-pair in production', () => {
  function pairChain() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {};
    chain.delete = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.lt = vi.fn(() => Promise.resolve({ error: null }));
    chain.insert = vi.fn(() => Promise.resolve({ error: null }));
    mockSupabaseFrom.mockImplementation(() => chain);
    return chain;
  }

  it('advertises HTTPS only — the LAN and a plain-http dashboard host are dropped', async () => {
    pairChain();
    await inProduction(async () => {
      const res = createRes();
      await pairStart(
        createReq({}, '1.2.3.4', {
          pcpUserId: 'pcp-user-1',
          get: (name: string) => (name.toLowerCase() === 'host' ? '192.168.1.20:3001' : undefined),
        }),
        res
      );
      expect(res._status).toBe(200);
      const body = res._json as { urls: string[]; insecureTransport: boolean };
      // A public https base URL is the only thing worth advertising.
      expect(body.urls).toEqual(['https://ink.example.com']);
      expect(body.insecureTransport).toBe(false);
    }, 'https://ink.example.com/');
  });

  it('advertises nothing rather than cleartext when no https address exists', async () => {
    pairChain();
    await inProduction(async () => {
      const res = createRes();
      await pairStart(
        createReq({}, '1.2.3.4', {
          pcpUserId: 'pcp-user-1',
          get: (name: string) => (name.toLowerCase() === 'host' ? '192.168.1.20:3001' : undefined),
        }),
        res
      );
      expect(res._status).toBe(200);
      expect((res._json as { urls: string[] }).urls).toEqual([]);
    });
  });

  it('puts the TLS candidate first even in development', async () => {
    pairChain();
    const res = createRes();
    await pairStart(
      createReq({}, '1.2.3.4', {
        pcpUserId: 'pcp-user-1',
        get: (name: string) => {
          if (name.toLowerCase() === 'host') return 'ink.example.com';
          if (name.toLowerCase() === 'x-forwarded-proto') return 'https';
          return undefined;
        },
      }),
      res
    );
    const body = res._json as { urls: string[] };
    expect(body.urls[0]).toBe('https://ink.example.com');
  });
});

// ---------------------------------------------------------------------------
// /auth/mobile-pair/claim — redeeming a code (unauthenticated)
// ---------------------------------------------------------------------------

function mockPairClaim(
  consumed: { user_id: string; expires_at: string } | null,
  user: { id: string; email: string } | null = null
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {};
  chain.delete = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: consumed, error: null }));
  chain.single = vi.fn(() => Promise.resolve({ data: user, error: null }));
  mockSupabaseFrom.mockImplementation(() => chain);
  return chain;
}

describe('POST /auth/mobile-pair/claim', () => {
  it('rejects a malformed code without touching the database', async () => {
    const res = createRes();
    await pairClaim(createReq({ code: 'abc' }), res);
    expect(res._status).toBe(400);
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });

  it('401s when no live code was consumed', async () => {
    mockPairClaim(null);
    const res = createRes();
    await pairClaim(createReq({ code: 'ABCD-EFGH-JKLM' }), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid or expired pairing code' });
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('401s on an expired code — and it is gone, not retryable', async () => {
    const chain = mockPairClaim({ user_id: 'pcp-user-1', expires_at: '2020-01-01T00:00:00Z' });
    const res = createRes();
    await pairClaim(createReq({ code: 'ABCD-EFGH-JKLM' }), res);
    expect(res._status).toBe(401);
    expect(chain.delete).toHaveBeenCalled();
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('consumes the code atomically and issues mobile tokens to its owner', async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const chain = mockPairClaim(
      { user_id: 'pcp-user-1', expires_at: future },
      { id: 'pcp-user-1', email: 'a@b.co' }
    );

    const res = createRes();
    // Typed by hand: lowercase, dashes — must normalise to the stored key.
    await pairClaim(createReq({ code: 'abcd-efgh jklm' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      accessToken: 'signed-access-jwt',
      refreshToken: 'pcp-rt-fresh',
      userId: 'pcp-user-1',
      email: 'a@b.co',
    });
    // The claim is a filtered delete that returns the row: no lookup-then-
    // delete window for two phones to both win.
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('refresh_token', 'pcp-pair-ABCDEFGHJKLM');
    expect(chain.eq).toHaveBeenCalledWith('client_id', 'mobile-pair');
    expect(mockCreateRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      'pcp-user-1',
      'mobile',
      ['admin'],
      expect.any(Number)
    );
  });

  it('in production refuses a cleartext claim from another machine, but not TLS or loopback', async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await inProduction(async () => {
      // Plain http from the LAN: the token would cross the network in the clear.
      mockPairClaim(
        { user_id: 'pcp-user-1', expires_at: future },
        { id: 'pcp-user-1', email: 'a@b.co' }
      );
      let res = createRes();
      await pairClaim(
        createReq({ code: 'ABCD-EFGH-JKLM' }, '5.5.5.5', {
          get: (name: string) => (name.toLowerCase() === 'host' ? '192.168.1.20:3001' : undefined),
        }),
        res
      );
      expect(res._status).toBe(403);
      expect(mockSupabaseFrom).not.toHaveBeenCalled();

      // TLS-terminated upstream.
      mockPairClaim(
        { user_id: 'pcp-user-1', expires_at: future },
        { id: 'pcp-user-1', email: 'a@b.co' }
      );
      res = createRes();
      await pairClaim(
        createReq({ code: 'ABCD-EFGH-JKLM' }, '5.5.5.5', {
          get: (name: string) => {
            if (name.toLowerCase() === 'host') return 'ink.example.com';
            if (name.toLowerCase() === 'x-forwarded-proto') return 'https';
            return undefined;
          },
        }),
        res
      );
      expect(res._status).toBe(200);

      // Same machine.
      mockPairClaim(
        { user_id: 'pcp-user-1', expires_at: future },
        { id: 'pcp-user-1', email: 'a@b.co' }
      );
      res = createRes();
      await pairClaim(
        createReq({ code: 'ABCD-EFGH-JKLM' }, '5.5.5.5', {
          get: (name: string) => (name.toLowerCase() === 'host' ? 'localhost:3001' : undefined),
        }),
        res
      );
      expect(res._status).toBe(200);
    });
  });

  it('rate-limits claims per IP before consulting the database', async () => {
    mockPairClaim(null);
    const req = () => createReq({ code: 'ABCD-EFGH-JKLM' }, '8.8.8.8');
    for (let i = 0; i < 10; i += 1) {
      await pairClaim(req(), createRes());
    }
    mockSupabaseFrom.mockClear();

    const res = createRes();
    await pairClaim(req(), res);

    expect(res._status).toBe(429);
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });
});
