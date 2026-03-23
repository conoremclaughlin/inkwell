import { beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_PORT = Number(process.env.PCP_PORT_BASE || 3001);
const MCP_PORT = BASE_PORT;
const MCP_CALLBACK = `http://localhost:${MCP_PORT}/mcp/auth/callback`;

const mockSignInWithPassword = vi.fn();
const mockSignInWithOtp = vi.fn();
const mockSignInWithOAuth = vi.fn();
const mockSignUp = vi.fn();
const mockProvision = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
      signInWithOAuth: (...args: unknown[]) => mockSignInWithOAuth(...args),
      signUp: (...args: unknown[]) => mockSignUp(...args),
    },
  }),
}));

vi.mock('@/lib/auth/provision', () => ({
  provisionPcpUserAndWorkspace: (...args: unknown[]) => mockProvision(...args),
}));

import {
  signInWithOAuthOnServer,
  signInWithOtpOnServer,
  signInWithPasswordOnServer,
  signUpWithPasswordOnServer,
} from './server-auth';

describe('server auth helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_URL = `http://localhost:${MCP_PORT}`;
  });

  describe('signInWithPasswordOnServer', () => {
    it('returns success on valid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: { access_token: 'at', refresh_token: 'rt' } },
        error: null,
      });

      const result = await signInWithPasswordOnServer('user@test.com', 'password123');
      expect(result).toEqual({ success: true });
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'password123',
      });
      expect(mockProvision).toHaveBeenCalledWith('at');
    });

    it('returns error on invalid credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { message: 'Invalid login credentials' },
      });

      const result = await signInWithPasswordOnServer('user@test.com', 'wrong');
      expect(result).toEqual({ error: 'Invalid login credentials' });
      expect(mockProvision).not.toHaveBeenCalled();
    });

    it('returns a friendly Supabase connection error when auth fetch fails', async () => {
      mockSignInWithPassword.mockRejectedValue(
        Object.assign(new Error('AuthRetryableFetchError: {}'), { status: 502 })
      );

      const result = await signInWithPasswordOnServer('user@test.com', 'wrong');
      expect(result).toEqual({
        error:
          'Supabase auth connection failed. Please verify your Supabase instance is running and try again.',
      });
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

      const result = await signInWithPasswordOnServer(
        'user@test.com',
        'password123',
        'pending-123'
      );

      expect(result).toHaveProperty('mcpRedirectUrl');
      const url = new URL((result as { mcpRedirectUrl: string }).mcpRedirectUrl);
      expect(url.origin + url.pathname).toBe(MCP_CALLBACK);
      expect(url.searchParams.get('pending_id')).toBe('pending-123');
      expect(url.searchParams.get('access_token')).toBe('test-access-token');
      expect(url.searchParams.has('refresh_token')).toBe(false);
    });
  });

  describe('signInWithOtpOnServer', () => {
    it('returns success when OTP email is sent', async () => {
      mockSignInWithOtp.mockResolvedValue({ error: null });

      const result = await signInWithOtpOnServer('user@test.com', 'https://app.com/auth/callback');
      expect(result).toEqual({ success: true });
      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: 'user@test.com',
        options: { emailRedirectTo: 'https://app.com/auth/callback' },
      });
    });
  });

  describe('signInWithOAuthOnServer', () => {
    it('returns provider redirect url', async () => {
      mockSignInWithOAuth.mockResolvedValue({
        data: { url: 'https://github.com/login/oauth/authorize?foo=bar' },
        error: null,
      });

      const result = await signInWithOAuthOnServer('github', 'https://app.com/auth/callback');
      expect(result).toEqual({ url: 'https://github.com/login/oauth/authorize?foo=bar' });
      expect(mockSignInWithOAuth).toHaveBeenCalledWith({
        provider: 'github',
        options: { redirectTo: 'https://app.com/auth/callback' },
      });
    });
  });

  describe('signUpWithPasswordOnServer', () => {
    it('returns success on valid signup', async () => {
      mockSignUp.mockResolvedValue({ error: null });

      const result = await signUpWithPasswordOnServer(
        'user@test.com',
        'password123',
        'https://app.com/auth/callback'
      );

      expect(result).toEqual({ success: true });
      expect(mockSignUp).toHaveBeenCalledWith({
        email: 'user@test.com',
        password: 'password123',
        options: { emailRedirectTo: 'https://app.com/auth/callback' },
      });
    });
  });
});
