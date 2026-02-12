import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase server client
const mockGetUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: () => mockGetUser(),
    },
  }),
}));

import { GET } from './route';

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns authenticated user when session exists', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-uuid-123',
          email: 'user@test.com',
        },
      },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      authenticated: true,
      user: { id: 'user-uuid-123', email: 'user@test.com' },
    });
  });

  it('returns 401 when no user session exists', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ authenticated: false });
  });

  it('does not leak extra user fields', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-uuid-123',
          email: 'user@test.com',
          role: 'admin',
          app_metadata: { provider: 'email' },
          user_metadata: { full_name: 'Test User' },
        },
      },
    });

    const response = await GET();
    const body = await response.json();

    expect(body.user).toEqual({ id: 'user-uuid-123', email: 'user@test.com' });
    expect(body.user).not.toHaveProperty('role');
    expect(body.user).not.toHaveProperty('app_metadata');
    expect(body.user).not.toHaveProperty('user_metadata');
  });
});
