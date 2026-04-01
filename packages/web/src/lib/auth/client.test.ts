import { afterEach, describe, expect, it, vi } from 'vitest';

import { signInWithPassword } from './client';

describe('auth client helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns structured error payload on non-2xx auth responses', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid login credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(signInWithPassword('user@test.com', 'wrong')).resolves.toEqual({
      error: 'Invalid login credentials',
    });
  });
});
