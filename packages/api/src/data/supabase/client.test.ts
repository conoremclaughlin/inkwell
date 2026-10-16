import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// Observe options while still exercising the installed SDK implementation.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@supabase/supabase-js')>();
  return { ...sdk, createClient: vi.fn(sdk.createClient) };
});

vi.mock('../../config/env', async () => ({
  env: (await import('../../test/fake-env')).fakeEnv,
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { createServerSupabaseClient, getSupabaseClient } from './client';
import { fakeEnv } from '../../test/fake-env';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('server database client lifetime', () => {
  it.each(['secret', 'publishable'] as const)(
    'creates distinct %s clients without auth refresh timers',
    async (keyType) => {
      vi.useFakeTimers();
      const fetch = vi.fn(() => Promise.reject(new Error('Network forbidden in this test')));
      vi.stubGlobal('fetch', fetch);
      const clients = new Set();
      for (let i = 0; i < 100; i++) {
        const client = createServerSupabaseClient(keyType);
        clients.add(client);
        await client.auth.initialize();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(clients.size).toBe(100);
      expect(vi.getTimerCount()).toBe(0);
      expect(createClient).toHaveBeenLastCalledWith(
        fakeEnv.SUPABASE_URL,
        keyType === 'publishable' ? fakeEnv.SUPABASE_PUBLISHABLE_KEY : fakeEnv.SUPABASE_SECRET_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('keeps a sign-in session out of fresh service clients and the existing singleton', async () => {
    vi.useFakeTimers();
    const calls: Array<{ pathname: string; apiKey: string | null; authorization: string | null }> =
      [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const pathname = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        ).pathname;
        const headers = new Headers(init?.headers);
        calls.push({
          pathname,
          apiKey: headers.get('apikey'),
          authorization: headers.get('authorization'),
        });
        if (pathname === '/auth/v1/token')
          return new Response(
            JSON.stringify({
              access_token: 'synthetic-access',
              refresh_token: 'synthetic-refresh',
              expires_in: 3600,
              token_type: 'bearer',
              user: { id: 'synthetic-user' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        if (pathname === '/rest/v1/synthetic_table') return new Response('[]', { status: 200 });
        throw new Error('Unexpected request in isolated test');
      })
    );
    const authClient = createServerSupabaseClient('publishable');
    const signedIn = await authClient.auth.signInWithPassword({
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    expect(signedIn.error).toBeNull();
    expect((await authClient.auth.getSession()).data.session?.user.id).toBe('synthetic-user');
    for (const client of [
      createServerSupabaseClient(),
      createServerSupabaseClient('publishable'),
      getSupabaseClient(),
    ]) {
      expect(client).not.toBe(authClient);
      expect((await client.auth.getSession()).data.session).toBeNull();
    }
    const serviceClient = createServerSupabaseClient();
    await serviceClient.from('synthetic_table').select('*');
    expect(calls).toEqual([
      {
        pathname: '/auth/v1/token',
        apiKey: fakeEnv.SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${fakeEnv.SUPABASE_PUBLISHABLE_KEY}`,
      },
      {
        pathname: '/rest/v1/synthetic_table',
        apiKey: fakeEnv.SUPABASE_SECRET_KEY,
        authorization: `Bearer ${fakeEnv.SUPABASE_SECRET_KEY}`,
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses one service client without starting auth refresh timers', async () => {
    vi.useFakeTimers();
    // Construct this singleton under this test's clock, not a previous test's.
    vi.resetModules();
    const { createSupabaseClient, getSupabaseClient } = await import('./client');
    const fetch = vi.fn(() => Promise.reject(new Error('Network forbidden in this test')));
    vi.stubGlobal('fetch', fetch);

    const client = getSupabaseClient();
    await client.auth.initialize();
    for (let i = 0; i < 100; i++) {
      expect(getSupabaseClient()).toBe(client);
      expect(createSupabaseClient()).toBe(client);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, { auth: { persistSession: false } }])(
    'detects the retention mechanism with unsafe options %j',
    async (options) => {
      vi.useFakeTimers();
      const fetch = vi.fn(() => Promise.reject(new Error('Network forbidden in this test')));
      vi.stubGlobal('fetch', fetch);
      const clients = [];
      try {
        for (let i = 0; i < 10; i++) {
          const client = createClient(
            'https://synthetic-project.invalid',
            'synthetic-service-key',
            options
          );
          clients.push(client);
          await client.auth.initialize();
        }
        // Drain the SDK's initial zero-delay tick, leaving only the repeating
        // timers. unref() lets Node exit; it does not release clients on a
        // server that stays alive. No login is needed to start these timers.
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(10);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await Promise.all(clients.map((client) => client.auth.stopAutoRefresh()));
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
