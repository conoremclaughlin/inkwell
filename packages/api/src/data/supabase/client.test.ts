import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerSupabaseClient } from './client';

/**
 * A Supabase client made with the library's defaults starts a token-refresh
 * interval that keeps it alive for the life of the process, so a client made
 * per request is never collected (thread inkwell:debug:api-memory-growth).
 * These tests count the intervals auth-js starts, with the network refused.
 */
describe('createServerSupabaseClient', () => {
  const realSetInterval = globalThis.setInterval;
  let refreshIntervals = 0;
  let fetches = 0;

  function watchRefreshIntervals() {
    vi.stubGlobal('fetch', async () => {
      fetches += 1;
      throw new Error('This test makes no network request');
    });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (/@supabase[\\/]auth-js/.test(new Error().stack ?? '')) refreshIntervals += 1;
      return realSetInterval(handler, ms, ...args);
    }) as typeof setInterval);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    refreshIntervals = 0;
    fetches = 0;
  });

  it('can see the refresh interval a default client starts (control)', async () => {
    watchRefreshIntervals();
    const client = createClient('https://database.example.test', 'synthetic-key');
    try {
      await client.auth.initialize();
      expect(refreshIntervals).toBe(1);
    } finally {
      await client.auth.stopAutoRefresh();
    }
    expect(fetches).toBe(0);
  });

  it.each(['secret', 'publishable'] as const)(
    'starts no refresh interval for a %s-key client',
    async (key) => {
      watchRefreshIntervals();
      const client = createServerSupabaseClient(key);
      await client.auth.initialize();
      expect(refreshIntervals).toBe(0);
      expect(fetches).toBe(0);
    }
  );

  it('returns a separate client on every call', () => {
    expect(createServerSupabaseClient()).not.toBe(createServerSupabaseClient());
  });
});
