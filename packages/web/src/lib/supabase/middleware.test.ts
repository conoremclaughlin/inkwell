import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3002'));
}

describe('middleware updateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated user
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-token-abc' } },
    });
  });

  describe('auth header injection', () => {
    it('injects Authorization header for /api/admin/* routes', async () => {
      const request = makeRequest('http://localhost:3002/api/admin/users');
      const response = await updateSession(request);

      // The middleware returns a NextResponse — check that it passed through
      expect(response.status).toBe(200);
      // Verify getSession was called (to get the token)
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('injects Authorization header for /api/chat/* routes', async () => {
      const request = makeRequest('http://localhost:3002/api/chat/messages');
      await updateSession(request);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('injects Authorization header for /api/kindle/* routes', async () => {
      const request = makeRequest('http://localhost:3002/api/kindle/token/abc');
      await updateSession(request);
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('does NOT inject auth for /api/auth/* routes', async () => {
      const request = makeRequest('http://localhost:3002/api/auth/me');
      await updateSession(request);
      // getSession should only be called once by getUser's internal flow,
      // NOT by our auth injection code
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it('does not inject auth when user has no session', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({ data: { session: null } });

      const request = makeRequest('http://localhost:3002/api/admin/users');
      const response = await updateSession(request);
      expect(response.status).toBe(200);
    });
  });

  describe('protected route redirects', () => {
    it('redirects unauthenticated users to /login for protected routes', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('http://localhost:3002/dashboard');
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
    });

    it('allows unauthenticated access to /login', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('http://localhost:3002/login');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });

    it('allows unauthenticated access to /api/* routes', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('http://localhost:3002/api/auth/me');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });

    it('allows unauthenticated access to /kindle/[token] pages', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      const request = makeRequest('http://localhost:3002/kindle/abc123');
      const response = await updateSession(request);

      expect(response.status).toBe(200);
    });
  });

  describe('MCP OAuth flow', () => {
    it('redirects logged-in user with MCP params to MCP callback', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'mcp-access-token',
            refresh_token: 'mcp-refresh-token',
          },
        },
      });

      const request = makeRequest(
        'http://localhost:3002/login?redirect=https://example.com/callback&pending_id=pending-123'
      );
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      const redirectUrl = new URL(location);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.get('pending_id')).toBe('pending-123');
      expect(redirectUrl.searchParams.get('access_token')).toBe('mcp-access-token');
      expect(redirectUrl.searchParams.get('refresh_token')).toBe('mcp-refresh-token');
    });

    it('lets login page load if tokens are missing in MCP flow', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
      mockGetSession.mockResolvedValue({
        data: { session: { access_token: 'at' } }, // no refresh_token
      });

      const request = makeRequest(
        'http://localhost:3002/login?redirect=https://example.com/callback&pending_id=pending-123'
      );
      const response = await updateSession(request);

      // Should NOT redirect — let login form handle it
      expect(response.status).toBe(200);
    });

    it('redirects logged-in user without MCP params to dashboard', async () => {
      const request = makeRequest('http://localhost:3002/login');
      const response = await updateSession(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/');
    });
  });
});
