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

/** What a `.eq('refresh_token', …).single()` lookup resolves to. */
let lookupResult: { data: unknown; error: unknown } = { data: null, error: null };
/**
 * What a `.eq('previous_refresh_token', …).single()` lookup resolves to — the
 * retry-overlap path. Defaults to no match, which is a PostgREST error and not
 * an empty success.
 */
let previousLookupResult: { data: unknown; error: unknown } = {
  data: null,
  error: { code: 'PGRST116', message: 'no rows' },
};
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
      chain.single = vi.fn(() => {
        const byPrevious = filters.some(([col]) => col === 'previous_refresh_token');
        return Promise.resolve(byPrevious ? previousLookupResult : lookupResult);
      });
      return chain;
    },
  };
}

// ---------------------------------------------------------------------------
// A stateful one-row store, for the cases where scripting the answers would be
// scripting the conclusion.
//
// "Two concurrent consumers" cannot be expressed by handing the second caller a
// pre-decided zero-row result: that asserts the outcome instead of producing
// it. Here both callers run against the same row, and the conditional update
// enforces itself — exactly one write can match `refresh_token`, and which one
// does is decided by arrival order rather than by the test.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

function makeGrantStore(initial: Row) {
  let row: Row | null = { ...initial };
  /** Held open to pin an interleaving: no update applies until this resolves. */
  let updateGate: Promise<void> = Promise.resolve();

  const matches = (candidate: Row, filters: Array<[string, unknown]>) =>
    filters.every(([col, val]) => candidate[col] === val);

  const client = {
    from: (_table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pendingUpdate: Record<string, unknown> | null = null;
      let isDelete = false;

      const chain: Record<string, any> = {};
      chain.select = vi.fn((_cols?: string) => {
        if (!pendingUpdate) return chain;
        const values = pendingUpdate;
        const applied = [...filters];
        return (async () => {
          await updateGate;
          if (!row || !matches(row, applied)) return { data: [], error: null };
          row = { ...row, ...values } as Row;
          return { data: [{ id: row.id }], error: null };
        })();
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
        if (isDelete) {
          if (row && matches(row, filters)) row = null;
          return Promise.resolve({ data: null, error: null });
        }
        return chain;
      });
      chain.single = vi.fn(async () => {
        if (row && matches(row, filters)) return { data: { ...row }, error: null };
        return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      });
      return chain;
    },
  };

  return {
    client,
    current: () => row,
    /** Block every update until the returned function is called. */
    holdUpdates(): () => void {
      let release!: () => void;
      updateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

/** Let every pending microtask chain drain, so an interleaving is not a guess. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  effectiveGrantDeadline,
  isWithinRetryOverlap,
  REFRESH_ABSOLUTE_DAYS,
} from './pcp-tokens';

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
  previousLookupResult = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
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
    // The rotation's whole footprint. `previous_refresh_token` and `rotated_at`
    // record what was replaced and when, for the retry overlap; neither says
    // anything about the deadline.
    expect(Object.keys(write.values).sort()).toEqual([
      'last_used_at',
      'previous_refresh_token',
      'refresh_token',
      'rotated_at',
    ]);
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

  it('refuses a lost race when the row does not record the presented token as its predecessor', async () => {
    // Zero rows updated, and no grant claims the presented value as the one it
    // replaced. Nothing identifies this token, so there is nothing to answer
    // with. (The ordinary lost race — where the winner DID record it — is
    // covered by the retry-overlap suite below, against a real shared row.)
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

// ---------------------------------------------------------------------------
// The retry overlap.
//
// Rotation on its own refuses two clients that have done nothing wrong: the
// loser of a race between processes sharing one grant, and a client whose
// successful response never arrived and which retried the only secret it held.
// Every case below runs against the stateful store, so the conditional update
// decides who wins rather than the test deciding for it.
// ---------------------------------------------------------------------------

describe('exchangeRefreshToken — retry overlap', () => {
  const storeRow = (overrides: Record<string, unknown> = {}): Row => {
    const now = Date.now();
    return {
      id: 'row-1',
      user_id: 'user-1',
      client_id: CLIENT,
      refresh_token: 'pcp-rt-A',
      previous_refresh_token: null,
      rotated_at: null,
      scopes: ['mcp:tools'],
      created_at: new Date(now - 2 * DAY).toISOString(),
      expires_at: new Date(now + 5 * DAY).toISOString(),
      last_used_at: null,
      agent_id: null,
      sb_id: null,
      users: { email: 'tester@example.invalid' },
      ...overrides,
    };
  };

  const exchange = (client: unknown, presented: string, overlapSeconds?: number) =>
    exchangeRefreshToken(
      client as never,
      presented,
      CLIENT,
      'pcp_admin',
      HOUR_SECONDS,
      overlapSeconds === undefined ? undefined : { retryOverlapSeconds: overlapSeconds }
    );

  it('answers a retry of the SAME secret with the successor already committed', async () => {
    // Not three successful rotations each presenting the newly returned value —
    // that is a client that never lost anything. This presents A twice, which
    // is what a client does when the reply carrying B never reached it.
    const store = makeGrantStore(storeRow());

    const first = await exchange(store.client, 'pcp-rt-A');
    expect(first).not.toBeNull();
    const successor = first!.refreshToken;
    expect(successor).not.toBe('pcp-rt-A');

    const retry = await exchange(store.client, 'pcp-rt-A');
    expect(retry).not.toBeNull();
    expect(retry!.refreshToken).toBe(successor);

    // And it rotated NOTHING: the grant still holds the one live secret, so a
    // client retrying ten times converges instead of walking a chain.
    expect(store.current()!.refresh_token).toBe(successor);
    expect(store.current()!.previous_refresh_token).toBe('pcp-rt-A');
  });

  it('serves BOTH of two concurrent consumers, and leaves one live secret', async () => {
    // The shape from the field: two processes share ~/.ink/auth.json, both read
    // A, both exchange. Before the overlap the loser was refused and logged out
    // of a session whose grant was alive in the winner's hands.
    const store = makeGrantStore(storeRow());
    const release = store.holdUpdates();

    const both = Promise.all([
      exchange(store.client, 'pcp-rt-A'),
      exchange(store.client, 'pcp-rt-A'),
    ]);
    await settle(); // both have read A; neither has written
    release();

    const [one, two] = await both;

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    // Both hold the SAME secret, and it is the one actually in the row.
    expect(one!.refreshToken).toBe(two!.refreshToken);
    expect(store.current()!.refresh_token).toBe(one!.refreshToken);
    expect(store.current()!.previous_refresh_token).toBe('pcp-rt-A');

    // Each got its own access token; they are separate grants of the same
    // authority, not one token handed out twice.
    expect(one!.accessToken).toBeTruthy();
    expect(two!.accessToken).toBeTruthy();
    expect(one!.userId).toBe(two!.userId);
  });

  it('refuses the replaced secret once the window has closed', async () => {
    const store = makeGrantStore(storeRow());
    const first = await exchange(store.client, 'pcp-rt-A');

    // Move the rotation stamp back past the window rather than waiting it out.
    store.current()!.rotated_at = new Date(Date.now() - 61_000).toISOString();

    const late = await exchange(store.client, 'pcp-rt-A', 60);
    expect(late).toBeNull();
    // The live secret is untouched — a refusal must not disturb the winner.
    expect(store.current()!.refresh_token).toBe(first!.refreshToken);
  });

  it('is disabled by an overlap of zero, which refuses the retry outright', async () => {
    // The duration is an open policy question (#632 R7). Zero is the pre-overlap
    // behaviour, and it must remain reachable through the parameter — otherwise
    // "parameterized" would be decoration.
    const store = makeGrantStore(storeRow());
    const first = await exchange(store.client, 'pcp-rt-A', 0);
    expect(first).not.toBeNull();

    expect(await exchange(store.client, 'pcp-rt-A', 0)).toBeNull();
    expect(store.current()!.refresh_token).toBe(first!.refreshToken);
  });

  it('honours a retry right at the edge of the window and refuses one just past it', async () => {
    const store = makeGrantStore(storeRow());
    await exchange(store.client, 'pcp-rt-A');

    store.current()!.rotated_at = new Date(Date.now() - 10_000).toISOString();
    expect(await exchange(store.client, 'pcp-rt-A', 11)).not.toBeNull();
    expect(await exchange(store.client, 'pcp-rt-A', 9)).toBeNull();
  });

  it('does not move the deadline for a retry, any more than for a rotation', async () => {
    const store = makeGrantStore(storeRow());
    const originalExpiry = store.current()!.expires_at as string;
    const originalCreatedAt = store.current()!.created_at as string;

    const first = await exchange(store.client, 'pcp-rt-A');
    const retry = await exchange(store.client, 'pcp-rt-A');

    expect(retry!.refreshTokenExpiresAt.toISOString()).toBe(
      first!.refreshTokenExpiresAt.toISOString()
    );
    expect(retry!.refreshTokenExpiresAt.toISOString()).toBe(originalExpiry);
    expect(store.current()!.expires_at).toBe(originalExpiry);
    expect(store.current()!.created_at).toBe(originalCreatedAt);
  });

  it('caps a retry at the absolute ceiling exactly as the rotation does', async () => {
    const createdAt = new Date(Date.now() - 89 * DAY);
    const store = makeGrantStore(storeRow({ created_at: createdAt.toISOString() }));

    await exchange(store.client, 'pcp-rt-A');
    const retry = await exchange(store.client, 'pcp-rt-A');

    expect(retry!.refreshTokenExpiresAt.getTime()).toBe(
      createdAt.getTime() + REFRESH_ABSOLUTE_DAYS * DAY
    );
  });

  it('carries exactly the authority the winner got — no more', async () => {
    // A replay that widened scope, or dropped an agent binding, would be a
    // quiet authority change on the path a client cannot see.
    const store = makeGrantStore(
      storeRow({ scopes: ['mcp:tools', 'admin'], agent_id: 'wren', sb_id: 'sb-uuid-1' })
    );

    const first = await exchange(store.client, 'pcp-rt-A');
    const retry = await exchange(store.client, 'pcp-rt-A');

    const claimsOf = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    const winner = claimsOf(first!.accessToken);
    const replay = claimsOf(retry!.accessToken);

    expect(replay.scope).toBe(winner.scope);
    expect(replay.scope).toBe('mcp:tools admin');
    expect(replay.agentId).toBe('wren');
    expect(replay.identityId).toBe('sb-uuid-1');
    expect(replay.sub).toBe(winner.sub);
    expect(replay.type).toBe(winner.type);
    expect(retry!.agentId).toBe(first!.agentId);
    expect(retry!.identityId).toBe(first!.identityId);
  });

  it('refuses a retry from a different client_id', async () => {
    const store = makeGrantStore(storeRow());
    await exchange(store.client, 'pcp-rt-A');

    const crossClient = await exchangeRefreshToken(
      store.client as never,
      'pcp-rt-A',
      'some-other-client',
      'pcp_admin',
      HOUR_SECONDS
    );
    expect(crossClient).toBeNull();
  });

  it('refuses a retry of a grant that has since passed its deadline, and deletes it', async () => {
    // Inside the retry window but past the grant's own — the overlap rescues a
    // client from a race, never from expiry.
    const store = makeGrantStore(storeRow());
    await exchange(store.client, 'pcp-rt-A');
    store.current()!.expires_at = new Date(Date.now() - DAY).toISOString();

    expect(await exchange(store.client, 'pcp-rt-A')).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('refuses a retry of a grant past its absolute ceiling, however fresh its expires_at', async () => {
    const store = makeGrantStore(storeRow());
    await exchange(store.client, 'pcp-rt-A');
    store.current()!.created_at = new Date(
      Date.now() - (REFRESH_ABSOLUTE_DAYS + 1) * DAY
    ).toISOString();
    store.current()!.expires_at = new Date(Date.now() + 6 * DAY).toISOString();

    expect(await exchange(store.client, 'pcp-rt-A')).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('refuses a token this grant never issued — the overlap is not a lookup bypass', async () => {
    const store = makeGrantStore(storeRow());
    await exchange(store.client, 'pcp-rt-A');

    expect(await exchange(store.client, 'pcp-rt-never-issued')).toBeNull();
  });

  it('rotates only ONE generation back — the secret before last is dead', async () => {
    // A: rotated to B, then B rotated to C. A is two generations back and the
    // row no longer names it, so it is refused even though no time has passed.
    const store = makeGrantStore(storeRow());
    const first = await exchange(store.client, 'pcp-rt-A');
    const second = await exchange(store.client, first!.refreshToken);

    expect(await exchange(store.client, first!.refreshToken)).not.toBeNull(); // B: one back
    expect(await exchange(store.client, 'pcp-rt-A')).toBeNull(); // A: two back
    expect(store.current()!.refresh_token).toBe(second!.refreshToken);
  });
});

describe('isWithinRetryOverlap', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('is false for a row that has never rotated', () => {
    expect(isWithinRetryOverlap({ rotatedAt: null, now, overlapSeconds: 60 })).toBe(false);
  });

  it('is false for an unparseable stamp rather than treating NaN as recent', () => {
    expect(isWithinRetryOverlap({ rotatedAt: 'not-a-date', now, overlapSeconds: 60 })).toBe(false);
  });

  it('is false for any stamp when the window is zero', () => {
    expect(isWithinRetryOverlap({ rotatedAt: now.toISOString(), now, overlapSeconds: 0 })).toBe(
      false
    );
  });

  it('holds until the window elapses and not after', () => {
    const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
    expect(isWithinRetryOverlap({ rotatedAt: at(59), now, overlapSeconds: 60 })).toBe(true);
    expect(isWithinRetryOverlap({ rotatedAt: at(60), now, overlapSeconds: 60 })).toBe(true);
    expect(isWithinRetryOverlap({ rotatedAt: at(61), now, overlapSeconds: 60 })).toBe(false);
  });

  it('treats a stamp in the future as clock skew, not as a fresh rotation forever', () => {
    // Inside, because refusing a client for the server's own clock helps nobody
    // — and the far edge still bounds it.
    const future = new Date(now.getTime() + 5_000).toISOString();
    expect(isWithinRetryOverlap({ rotatedAt: future, now, overlapSeconds: 60 })).toBe(true);
  });
});
