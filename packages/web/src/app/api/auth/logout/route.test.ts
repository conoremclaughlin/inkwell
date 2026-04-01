import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSignOut = vi.fn();
const mockCookieGet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (...args: unknown[]) => mockCookieGet(...args),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      signOut: () => mockSignOut(),
    },
  }),
}));

import { POST } from './route';

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs out supabase and clears PCP auth cookies', async () => {
    mockSignOut.mockResolvedValue({});

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(mockSignOut).toHaveBeenCalledTimes(1);

    const cookies = response.cookies.getAll();
    const pcpAccessCookie = cookies.find((cookie) => cookie.name === 'pcp-admin-token');
    const pcpRefreshCookie = cookies.find((cookie) => cookie.name === 'pcp-admin-refresh');

    expect(pcpAccessCookie?.value).toBe('');
    expect(pcpRefreshCookie?.value).toBe('');
  });

  it('best-effort revokes PCP refresh token when present', async () => {
    mockSignOut.mockResolvedValue({});
    mockCookieGet.mockImplementation((name: string) =>
      name === 'pcp-admin-refresh' ? { value: 'pcp-rt-test-token' } : undefined
    );

    const response = await POST();
    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/auth/logout'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'pcp-rt-test-token' }),
      })
    );
  });
});
