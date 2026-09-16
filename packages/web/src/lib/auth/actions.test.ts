import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_PORT = Number(process.env.INK_PORT_BASE || 3001);
const MCP_PORT = BASE_PORT;
const MCP_CALLBACK = `http://localhost:${MCP_PORT}/mcp/auth/callback`;

// Mock next/navigation
const mockRedirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    mockRedirect(...args);
    throw new Error('NEXT_REDIRECT');
  },
}));

// Mock next/headers cookies
const mockCookieGet = vi.fn();
const mockCookieDelete = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (...args: unknown[]) => mockCookieGet(...args),
    delete: (...args: unknown[]) => mockCookieDelete(...args),
  }),
}));

// Mock Supabase server client
const mockSignInWithPassword = vi.fn();
const mockSignInWithOtp = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
  }),
}));

// Import after mocks are set up
import { signInWithPassword, signInWithOtp, signOut } from './actions';

describe('auth server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Actions construct callback URL from API_URL
    process.env.API_URL = `http://localhost:${MCP_PORT}`;
  });

  describe('signInWithPassword', () => {
    it('returns success on valid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: { access_token: 'at', refresh_token: 'rt' } },
        error: null,
      });

      const result = await signInWithPassword('user@test.com', 'password123');
      expect(result).toEqual({ success: true });
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'password123',
      });
    });

    it('returns error on invalid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { message: 'Invalid login credentials' },
      });

      const result = await signInWithPassword('user@test.com', 'wrong');
      expect(result).toEqual({ error: 'Invalid login credentials' });
    });

    it('returns mcpRedirectUrl for MCP OAuth flow', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
          },
        },
        error: null,
      });

      const result = await signInWithPassword('user@test.com', 'password123', 'pending-123');

      expect(result).toHaveProperty('mcpRedirectUrl');
      const url = new URL((result as { mcpRedirectUrl: string }).mcpRedirectUrl);
      expect(url.origin + url.pathname).toBe(MCP_CALLBACK);
      expect(url.searchParams.get('pending_id')).toBe('pending-123');
      expect(url.searchParams.get('access_token')).toBe('test-access-token');
      // refresh_token should NOT be in the callback URL
      expect(url.searchParams.has('refresh_token')).toBe(false);
    });

    it('returns success (not MCP redirect) when MCP params are null', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: { access_token: 'at', refresh_token: 'rt' } },
        error: null,
      });

      const result = await signInWithPassword('user@test.com', 'pass', null);
      expect(result).toEqual({ success: true });
    });
  });

  describe('signInWithOtp', () => {
    it('returns success when OTP email is sent', async () => {
      mockSignInWithOtp.mockResolvedValue({ error: null });

      const result = await signInWithOtp('user@test.com', 'https://app.com/auth/callback');
      expect(result).toEqual({ success: true });
      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: 'user@test.com',
        options: {
          emailRedirectTo: 'https://app.com/auth/callback',
        },
      });
    });

    it('returns error on failure', async () => {
      mockSignInWithOtp.mockResolvedValue({
        error: { message: 'Rate limit exceeded' },
      });

      const result = await signInWithOtp('user@test.com', 'https://app.com/auth/callback');
      expect(result).toEqual({ error: 'Rate limit exceeded' });
    });
  });

  describe('signOut', () => {
    beforeEach(() => {
      mockCookieGet.mockReturnValue(undefined);
      mockCookieDelete.mockReturnValue(undefined);
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('calls supabase signOut and redirects to /login', async () => {
      mockSignOut.mockResolvedValue({ error: null });

      await expect(signOut()).rejects.toThrow('NEXT_REDIRECT');
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockRedirect).toHaveBeenCalledWith('/login');
    });

    it('clears PCP admin cookies on signOut', async () => {
      mockSignOut.mockResolvedValue({ error: null });

      await expect(signOut()).rejects.toThrow('NEXT_REDIRECT');

      expect(mockCookieDelete).toHaveBeenCalledWith({
        name: 'pcp-admin-token',
        path: '/api/admin',
      });
      expect(mockCookieDelete).toHaveBeenCalledWith({
        name: 'pcp-admin-refresh',
        path: '/api/admin',
      });
    });

    it('calls logout API to revoke refresh token when cookie exists', async () => {
      mockSignOut.mockResolvedValue({ error: null });
      mockCookieGet.mockImplementation((name: string) => {
        if (name === 'pcp-admin-refresh') return { value: 'pcp-rt-test-token' };
        return undefined;
      });

      await expect(signOut()).rejects.toThrow('NEXT_REDIRECT');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/auth/logout'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refreshToken: 'pcp-rt-test-token' }),
        })
      );
    });

    it('does not call logout API when no refresh cookie exists', async () => {
      mockSignOut.mockResolvedValue({ error: null });
      mockCookieGet.mockReturnValue(undefined);

      await expect(signOut()).rejects.toThrow('NEXT_REDIRECT');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still signs out even if logout API call fails', async () => {
      mockSignOut.mockResolvedValue({ error: null });
      mockCookieGet.mockImplementation((name: string) => {
        if (name === 'pcp-admin-refresh') return { value: 'pcp-rt-fail' };
        return undefined;
      });
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      await expect(signOut()).rejects.toThrow('NEXT_REDIRECT');

      // Supabase signOut should still be called
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockRedirect).toHaveBeenCalledWith('/login');
    });
  });
});
