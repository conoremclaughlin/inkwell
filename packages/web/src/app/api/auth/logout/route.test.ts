import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSignOut = vi.fn();

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
});
