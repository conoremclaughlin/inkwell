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

import { exchangeRefreshToken, effectiveGrantDeadline, REFRESH_ABSOLUTE_DAYS } from './pcp-tokens';

const DAY = 24 * 60 * 60 * 1000;
const HOUR_SECONDS = 60 * 60;
/** The access-token lifetime option C restores. Formerly refused outright. */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
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

describe('effectiveGrantDeadline', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('keeps the stored expiry when it sits inside the ceiling', () => {
    const currentExpiresAt = new Date(now.getTime() + 10 * DAY).toISOString();
    const { expiresAt, atAbsoluteCeiling } = effectiveGrantDeadline({
      createdAt: new Date(now.getTime() - 2 * DAY).toISOString(),
      currentExpiresAt,
    });
    expect(expiresAt.toISOString()).toBe(currentExpiresAt);
    expect(atAbsoluteCeiling).toBe(false);
  });

  it('cuts back to created_at + the absolute window when the stored expiry overshoots', () => {
    // Issued 88 days ago with a stored expiry 10 days out: that reaches day 98,
    // past the 90-day ceiling, so the ceiling is the deadline in force.
    const createdAt = new Date(now.getTime() - 88 * DAY);
    const { expiresAt, atAbsoluteCeiling } = effectiveGrantDeadline({
      createdAt: createdAt.toISOString(),
      currentExpiresAt: new Date(now.getTime() + 10 * DAY).toISOString(),
    });
    expect(expiresAt.getTime()).toBe(createdAt.getTime() + REFRESH_ABSOLUTE_DAYS * DAY);
    expect(atAbsoluteCeiling).toBe(true);
  });

  it('never extends a grant whose stored expiry is SHORTER than the ceiling', () => {
    // The ceiling is a cap, not a floor. A deliberately-short grant keeps its
    // own deadline; reading the ceiling as an entitlement would hand it 90 days.
    const currentExpiresAt = new Date(now.getTime() + DAY).toISOString();
    const { expiresAt, atAbsoluteCeiling } = effectiveGrantDeadline({
      createdAt: now.toISOString(),
      currentExpiresAt,
    });
    expect(expiresAt.toISOString()).toBe(currentExpiresAt);
    expect(expiresAt.getTime()).toBeLessThan(now.getTime() + REFRESH_ABSOLUTE_DAYS * DAY);
    expect(atAbsoluteCeiling).toBe(false);
  });

  it('leaves a legacy row without created_at on its stored expiry', () => {
    const currentExpiresAt = new Date(now.getTime() + 2 * DAY).toISOString();
    const { expiresAt, atAbsoluteCeiling } = effectiveGrantDeadline({
      createdAt: null,
      currentExpiresAt,
    });
    expect(expiresAt.toISOString()).toBe(currentExpiresAt);
    expect(atAbsoluteCeiling).toBe(false);
  });

  it('does not extend a legacy row whose stored expiry is far out', () => {
    // No anchor means no computable ceiling. The row keeps what it has — the
    // one direction that cannot grant more time than the record already claims.
    const currentExpiresAt = new Date(now.getTime() + 80 * DAY).toISOString();
    const { expiresAt } = effectiveGrantDeadline({ createdAt: null, currentExpiresAt });
    expect(expiresAt.toISOString()).toBe(currentExpiresAt);
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

  it('never writes expires_at or created_at — the deadline is not the secret', async () => {
    const row = grantRow();
    lookupResult = { data: row, error: null };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    const [write] = recorded.updates;
    expect(Object.keys(write.values).sort()).toEqual(['last_used_at', 'refresh_token']);
    expect(write.values).not.toHaveProperty('expires_at');
    expect(write.values).not.toHaveProperty('created_at');
    // And the caller is handed the grant's own deadline, not a fresh window.
    expect(result!.refreshTokenExpiresAt.toISOString()).toBe(row.expires_at);
  });

  it('holds the deadline fixed across repeated rotations, including a retry', async () => {
    // The mock follows production: each rotation's recorded write is applied to
    // the row the next lookup returns. If the implementation ever started
    // stamping expires_at, the drift would compound here instead of hiding.
    let row = grantRow();
    const originalExpiry = row.expires_at;
    const originalCreatedAt = row.created_at;
    let presented = 'pcp-rt-presented';

    const deadlines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lookupResult = { data: row, error: null };
      recorded.updates = [];

      const result = await exchangeRefreshToken(
        makeSupabase() as never,
        presented,
        CLIENT,
        'pcp_admin',
        HOUR_SECONDS
      );
      expect(result).not.toBeNull();
      deadlines.push(result!.refreshTokenExpiresAt.toISOString());

      row = { ...row, ...recorded.updates[0].values } as typeof row;
      presented = result!.refreshToken;
    }

    expect(deadlines).toEqual([originalExpiry, originalExpiry, originalExpiry]);
    expect(row.expires_at).toBe(originalExpiry);
    expect(row.created_at).toBe(originalCreatedAt);
  });

  it('reports the ceiling, not the stored expiry, when the stored expiry overshoots it', async () => {
    // Issued 89 days ago but carrying a 5-day stored expiry: that reaches day
    // 94. The client must be told day 90, or its cookie outlives the grant.
    const createdAt = new Date(Date.now() - 89 * DAY);
    lookupResult = { data: grantRow({ created_at: createdAt.toISOString() }), error: null };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS
    );

    expect(result!.refreshTokenExpiresAt.getTime()).toBe(
      createdAt.getTime() + REFRESH_ABSOLUTE_DAYS * DAY
    );
    // Still no write to the column — the cap is computed, not persisted.
    expect(recorded.updates[0].values).not.toHaveProperty('expires_at');
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

  it('refuses and deletes a grant whose stored expiry has passed', async () => {
    lookupResult = {
      data: grantRow({ expires_at: new Date(Date.now() - DAY).toISOString() }),
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

  it('exchanges and rotates under a 30-day access lifetime', async () => {
    // Replaces the assertion that 30 days must THROW. Under option C the long
    // access lifetime is restored, so the evidence that changing the guard's
    // contract was safe has to be a working exchange — not a deleted test.
    const row = grantRow();
    lookupResult = { data: row, error: null };

    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      THIRTY_DAYS_SECONDS
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeTruthy();
    expect(result!.refreshToken).toMatch(/^pcp-rt-[0-9a-f]{64}$/);
    expect(result!.refreshToken).not.toBe('pcp-rt-presented');

    // The long access lifetime must not leak into the grant's deadline.
    expect(result!.refreshTokenExpiresAt.toISOString()).toBe(row.expires_at);
    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0].values).not.toHaveProperty('expires_at');
  });

  it('signs the access token for the lifetime it was given', async () => {
    const result = await exchangeRefreshToken(
      makeSupabase() as never,
      'pcp-rt-presented',
      CLIENT,
      'pcp_admin',
      THIRTY_DAYS_SECONDS
    );

    const claims = JSON.parse(
      Buffer.from(result!.accessToken.split('.')[1], 'base64url').toString('utf8')
    ) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(THIRTY_DAYS_SECONDS);
  });
});
