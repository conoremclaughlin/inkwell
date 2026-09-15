import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const BASE_PORT = Number(process.env.INK_PORT_BASE || 3001);
const WEB_PORT = BASE_PORT + 1;
const MCP_PORT = BASE_PORT;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const MCP_CALLBACK = `http://localhost:${MCP_PORT}/mcp/auth/callback`;

// Track the supabaseResponse and its cookie setter for assertions
let mockCookiesSetAll: ReturnType<typeof vi.fn>;
const mockGetUser = vi.fn();
const mockGetSession = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(
    (
      _url: string,
      _key: string,
      options: { cookies: { setAll: (...args: unknown[]) => void } }
    ) => {
      // Capture the setAll so we can simulate cookie refreshes
      mockCookiesSetAll = vi.fn(options.cookies.setAll);
      return {
        auth: {
          getUser: () => mockGetUser(),
          getSession: () => mockGetSession(),
        },
      };
    }
  ),
}));

import { updateSession } from './middleware';

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, WEB_ORIGIN));
}

describe('middleware updateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated user
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-token-abc' } },
    });
    // Middleware constructs callback URL from API_URL
    process.env.API_URL = `http://localhost:${MCP_PORT}`;
  });

  describe('auth header injection', () => {
    it('injects Authorization header for /api/admin/* routes', async () => {
      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('injects Authorization header for /api/chat/* routes', async () => {
      const request = makeRequest('/api/chat/messages');
      await updateSession(request);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('injects Authorization header for /api/kindle/* routes', async () => {
      const request = makeRequest('/api/kindle/token/abc');
      await updateSession(request);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('does NOT inject auth for /api/auth/* routes', async () => {
      const request = makeRequest('/api/auth/me');
      await updateSession(request);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it('does not inject auth when user has no session', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({ data: { session: null } });

      const request = makeRequest('/api/admin/users');
      const response = await updateSession(request);
      expect(response.status).toBe(200);
    });
  });

  describe('protected route redirects', () => {
    it('redirects unauthenticated users to /login for protected routes', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('/dashboard');
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
    });

    it('allows unauthenticated access to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('/login');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });

    it('allows unauthenticated access to /api/* routes', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('/api/auth/me');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });

    it('allows unauthenticated access to /kindle/[token] pages', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('/kindle/abc123');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });
  });

  describe('MCP OAuth flow', () => {
    it('redirects logged-in user with pending_id to MCP callback', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'mcp-access-token',
          },
        },
      });

      const request = makeRequest('/login?pending_id=pending-123');
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      const redirectUrl = new URL(location);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(MCP_CALLBACK);
      expect(redirectUrl.searchParams.get('pending_id')).toBe('pending-123');
      expect(redirectUrl.searchParams.get('access_token')).toBe('mcp-access-token');
      // refresh_token should NOT be in the callback URL
      expect(redirectUrl.searchParams.has('refresh_token')).toBe(false);
    });

    it('lets login page load if access token is missing in MCP flow', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({
        data: { session: null },
      });

      const request = makeRequest('/login?pending_id=pending-123');
      const response = await updateSession(request);

      // Should NOT redirect — let login form handle it
      expect(response.status).toBe(200);
    });

    it('redirects logged-in user without MCP params to dashboard', async () => {
      const request = makeRequest('/login');
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/');
    });
  });
});

describe('cookie-to-bearer mutation protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'synthetic-supabase-token' } },
    });
  });

  it.each(['pcp-admin-token=synthetic-token', 'sb-synthetic-auth=synthetic-session'])(
    'rejects cross-origin before reading either credential source',
    async (cookie) => {
      const response = await updateSession(
        new NextRequest(`${WEB_ORIGIN}/api/admin/tasks`, {
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://attacker.example',
            'X-Inkwell-CSRF': '1',
            authorization: 'Bearer synthetic',
          },
        })
      );
      expect(response.status).toBe(403);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    }
  );

  it.each(['pcp-admin-token=synthetic-token', 'sb-synthetic-auth=synthetic-session'])(
    'adds the non-simple header only after same-origin validation',
    async (cookie) => {
      const response = await updateSession(
        new NextRequest(`${WEB_ORIGIN}/api/admin/tasks`, {
          method: 'POST',
          headers: { cookie, origin: WEB_ORIGIN },
        })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-request-x-inkwell-csrf')).toBe('1');
      expect(response.headers.get('x-middleware-request-authorization')).toMatch(
        /^Bearer synthetic/
      );
    }
  );

  it('rejects ambient cookies without provenance but preserves cookie-free native calls', async () => {
    const rejected = await updateSession(
      new NextRequest(`${WEB_ORIGIN}/api/admin/tasks`, {
        method: 'POST',
        headers: { cookie: 'pcp-admin-token=synthetic-token' },
      })
    );
    expect(rejected.status).toBe(403);
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const native = await updateSession(
      new NextRequest(`${WEB_ORIGIN}/api/admin/tasks`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-native', 'X-Inkwell-CSRF': 'forged' },
      })
    );
    expect(native.status).toBe(200);
    expect(native.headers.get('x-middleware-request-authorization')).toBe(
      'Bearer synthetic-native'
    );
    expect(native.headers.get('x-middleware-request-x-inkwell-csrf')).toBeNull();
  });
});
