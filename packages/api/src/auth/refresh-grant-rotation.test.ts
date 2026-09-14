import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A recording Supabase double.
//
// The existing pcp-tokens.test.ts chain terminates at `.single()`, which cannot
// express the rotation write — an `.update(...).eq(...).eq(...).select('id')`
// that must be *awaited* and whose returned row count decides whether the
// exchange is honoured. Rather than reshape that suite's mock and risk its 687
// lines, this file carries its own: every call is recorded, and each query's
// result is scripted.
// ---------------------------------------------------------------------------

interface RecordedUpdate {
  values: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

const recorded = {
  updates: [] as RecordedUpdate[],
  deletes: [] as Array<Array<[string, unknown]>>,
};

/** What the next `.select(...).single()` lookup resolves to. */
let lookupResult: { data: unknown; error: unknown } = { data: null, error: null };
/** What the rotation write resolves to — `data` is the updated-row array. */
let updateResult: { data: unknown; error: unknown } = { data: [{ id: 'row-1' }], error: null };

function makeSupabase() {
  return {
    from: (_table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pendingUpdate: Record<string, unknown> | null = null;
      let isDelete = false;

      const chain: Record<string, any> = {};
      chain.select = vi.fn((_cols?: string) => {
        if (pendingUpdate) {
          // Terminal for the rotation write.
          recorded.updates.push({ values: pendingUpdate, filters: [...filters] });
          return Promise.resolve(updateResult);
        }
        return chain;
      });
      chain.update = vi.fn((values: Record<string, unknown>) => {
        pendingUpdate = values;
        return chain;
      });
      chain.delete = vi.fn(() => {
        isDelete = true;
        return chain;
      });
      chain.eq = vi.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        if (isDelete) recorded.deletes.push([...filters]);
        return chain;
      });
      chain.single = vi.fn(() => Promise.resolve(lookupResult));
      return chain;
    },
  };
}

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-key',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  exchangeRefreshToken,
  slidingExpiry,
  assertRefreshWindowIsReachable,
  REFRESH_IDLE_DAYS,
  REFRESH_ABSOLUTE_DAYS,
} from './pcp-tokens';

const DAY = 24 * 60 * 60 * 1000;
const HOUR_SECONDS = 60 * 60;
const CLIENT = 'dashboard';

function grantRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'row-1',
    user_id: 'user-1',
    client_id: CLIENT,
    refresh_token: 'pcp-rt-presented',
    scopes: ['mcp:tools'],
    created_at: new Date(now - 2 * DAY).toISOString(),
    expires_at: new Date(now + 5 * DAY).toISOString(),
    last_used_at: null,
    agent_id: null,
    sb_id: null,
    users: { email: 'tester@example.invalid' },
    ...overrides,
  };
}

beforeEach(() => {
  recorded.updates = [];
  recorded.deletes = [];
  lookupResult = { data: grantRow(), error: null };
  updateResult = { data: [{ id: 'row-1' }], error: null };
});

// ---------------------------------------------------------------------------

describe('slidingExpiry', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('slides one idle window forward when far from the ceiling', () => {
    const { expiresAt, atAbsoluteCeiling } = slidingExpiry({
      now,
      createdAt: new Date(now.getTime() - 2 * DAY).toISOString(),
      currentExpiresAt: new Date(now.getTime() + DAY).toISOString(),
    });
    expect(expiresAt.getTime()).toBe(now.getTime() + REFRESH_IDLE_DAYS * DAY);
    expect(atAbsoluteCeiling).toBe(false);
  });

  it('clamps to created_at + the absolute window near the ceiling', () => {
    // Issued 88 days ago: 7 more days would overshoot the 90-day ceiling.
    const createdAt = new Date(now.getTime() - 88 * DAY);
    const { expiresAt, atAbsoluteCeiling } = slidingExpiry({
      now,
      createdAt: createdAt.toISOString(),
      currentExpiresAt: new Date(now.getTime() + DAY).toISOString(),
    });
    expect(expiresAt.getTime()).toBe(createdAt.getTime() + REFRESH_ABSOLUTE_DAYS * DAY);
    expect(expiresAt.getTime()).toBeLessThan(now.getTime() + REFRESH_IDLE_DAYS * DAY);
    expect(atAbsoluteCeiling).toBe(true);
  });

  it('never extends a legacy row that has no created_at', () => {
    const currentExpiresAt = new Date(now.getTime() + 2 * DAY).toISOString();
    const { expiresAt, atAbsoluteCeiling } = slidingExpiry({
      now,
      createdAt: null,
      currentExpiresAt,
    });
    expect(expiresAt.toISOString()).toBe(currentExpiresAt);
    expect(atAbsoluteCeiling).toBe(true);
  });

  it('still shortens a legacy row whose stored expiry is far out', () => {
    // A 90-day grant with no anchor: sliding must pull it in to one week.
    const { expiresAt } = slidingExpiry({
      now,
      createdAt: null,
      currentExpiresAt: new Date(now.getTime() + 80 * DAY).toISOString(),
    });
    expect(expiresAt.getTime()).toBe(now.getTime() + REFRESH_IDLE_DAYS * DAY);
  });
});

describe('assertRefreshWindowIsReachable', () => {
  it('refuses a 30-day access token against a 7-day idle window', () => {
    // The pairing this PR removes: a client holding a 30-day access token never
    // comes back inside the idle window, so every grant would die unused.
    expect(() => assertRefreshWindowIsReachable(30 * 24 * 60 * 60, 'test')).toThrow(
      /not comfortably inside/
    );
  });

  it('refuses a lifetime that merely equals half the window', () => {
    expect(() =>
      assertRefreshWindowIsReachable((REFRESH_IDLE_DAYS / 2) * 24 * 60 * 60, 'test')
    ).toThrow();
  });

  it('accepts an hour', () => {
    expect(() => assertRefreshWindowIsReachable(HOUR_SECONDS, 'test')).not.toThrow();
  });
});

describe('exchangeRefreshToken — rotation', () => {
  it('issues a new secret and never returns the one presented', async () => {
    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result).not.toBeNull();
    expect(result!.refreshToken).toMatch(/^pcp-rt-[0-9a-f]{64}$/);
    expect(result!.refreshToken).not.toBe('pcp-rt-presented');
    expect(result!.accessToken).toBeTruthy();
  });

  it('writes the new secret, conditional on the one presented', async () => {
    await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(recorded.updates).toHaveLength(1);
    const [write] = recorded.updates;
    expect(write.values.refresh_token).toMatch(/^pcp-rt-[0-9a-f]{64}$/);
    expect(write.values.refresh_token).not.toBe('pcp-rt-presented');
    expect(write.values.last_used_at).toBeTruthy();

    // Both filters matter: the id alone would let a concurrent exchange win too.
    expect(write.filters).toContainEqual(['id', 'row-1']);
    expect(write.filters).toContainEqual(['refresh_token', 'pcp-rt-presented']);
  });

  it('slides the stored expiry one idle window forward', async () => {
    const before = Date.now();
    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    const written = new Date(recorded.updates[0].values.expires_at as string).getTime();
    expect(written).toBeGreaterThanOrEqual(before + REFRESH_IDLE_DAYS * DAY - 5000);
    expect(written).toBeLessThanOrEqual(Date.now() + REFRESH_IDLE_DAYS * DAY + 5000);
    expect(result!.refreshTokenExpiresAt.toISOString()).toBe(recorded.updates[0].values.expires_at);
  });

  it('does not slide past the absolute ceiling', async () => {
    const createdAt = new Date(Date.now() - 89 * DAY);
    lookupResult = { data: grantRow({ created_at: createdAt.toISOString() }), error: null };

    await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    const written = new Date(recorded.updates[0].values.expires_at as string).getTime();
    expect(written).toBe(createdAt.getTime() + REFRESH_ABSOLUTE_DAYS * DAY);
    expect(written).toBeLessThan(Date.now() + REFRESH_IDLE_DAYS * DAY);
  });

  it('refuses and deletes a grant past its absolute lifetime, however fresh its expires_at looks', async () => {
    // The shape sliding could otherwise hide: used every week for three months,
    // so expires_at is always a week out, but the grant is finished.
    lookupResult = {
      data: grantRow({
        created_at: new Date(Date.now() - (REFRESH_ABSOLUTE_DAYS + 1) * DAY).toISOString(),
        expires_at: new Date(Date.now() + 6 * DAY).toISOString(),
      }),
      error: null,
    };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result).toBeNull();
    expect(recorded.updates).toHaveLength(0);
    expect(recorded.deletes.length).toBeGreaterThan(0);
  });

  it('refuses when a concurrent exchange already rotated the grant', async () => {
    updateResult = { data: [], error: null };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result).toBeNull();
  });

  it('refuses when the rotation write itself errors, rather than handing out an un-rotated grant', async () => {
    updateResult = { data: null, error: { message: 'write failed' } };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result).toBeNull();
  });

  it('still refuses a client_id mismatch, and writes nothing', async () => {
    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      'some-other-client',
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result).toBeNull();
    expect(recorded.updates).toHaveLength(0);
  });

  it('refuses an access-token lifetime that would make the idle window unreachable', async () => {
    await expect(
      exchangeRefreshToken(
        makeSupabase() as never,
        'pcp-rt-presented',
        CLIENT,
        'pcp_admin',
        30 * 24 * 60 * 60
      )
    ).rejects.toThrow(/not comfortably inside/);
  });
});
