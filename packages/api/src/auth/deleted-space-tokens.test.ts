/**
 * A deleted space's SB tokens are refused on their next request (task
 * 3f7f6a8f). Deleting a space cascades its identity rows away; here that is a
 * row removed from the fake table, and for a refresh record its sb_id set to
 * null, as ON DELETE SET NULL leaves it. The tokens are real: signed and
 * verified with the test key, through the real provider and the real refresh
 * exchange. The database is a fake.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failOn: null as string | null,
  throwOn: null as string | null,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

/**
 * A query builder over db.tables: select/eq/limit/single/maybeSingle, insert,
 * delete and update. maybeSingle answers as PostgREST does: more than one row
 * is an error, with no data.
 */
function fakeClient() {
  return {
    from(table: string) {
      if (db.throwOn === table) throw new Error('socket closed');
      const read = { table, filters: [] as Array<[string, unknown]> };
      db.reads.push(read);
      let mode: 'select' | 'insert' | 'delete' | 'update' = 'select';
      let patch: Row = {};
      const matching = () =>
        (db.tables[table] ?? []).filter((row) =>
          read.filters.every(([column, value]) => row[column] === value)
        );
      const run = () => {
        if (db.failOn === table) return { data: null, error: { message: 'connection reset' } };
        if (mode === 'insert') {
          (db.tables[table] ??= []).push({
            agent_id: null,
            sb_id: null,
            users: { email: 'owner@example.test' },
            ...patch,
          });
          return { data: null, error: null };
        }
        if (mode === 'delete') {
          const gone = new Set(matching());
          db.tables[table] = (db.tables[table] ?? []).filter((row) => !gone.has(row));
          return { data: null, error: null };
        }
        if (mode === 'update') {
          for (const row of matching()) Object.assign(row, patch);
          return { data: null, error: null };
        }
        return { data: matching(), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          read.filters.push([column, value]);
          return builder;
        },
        limit: () => builder,
        insert: (fields: Row) => {
          mode = 'insert';
          patch = fields;
          return builder;
        },
        maybeSingle: async () => {
          const result = run();
          const rows = (result.data as Row[] | null) ?? [];
          if (result.error) return { data: null, error: result.error };
          return rows.length > 1
            ? { data: null, error: { message: 'multiple rows returned' } }
            : { data: rows[0] ?? null, error: null };
        },
        delete: () => {
          mode = 'delete';
          return builder;
        },
        update: (fields: Row) => {
          mode = 'update';
          patch = fields;
          return builder;
        },
        single: async () => {
          const result = run();
          const rows = (result.data as Row[] | null) ?? [];
          return rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: result.error ?? { message: 'not one row' } };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient() }));
vi.mock('../config/env', async () => ({ env: (await import('../test/fake-env')).fakeEnv }));
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import { signInkAccessToken, signRunnerAccessToken } from './ink-tokens';
import { tokenIdentityState } from './token-identity';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const SB = '00000000-0000-4000-8000-000000000010';
const SPACE = '00000000-0000-4000-8000-000000000020';
const OTHER_SPACE = '00000000-0000-4000-8000-000000000021';
const REFRESH = 'ink-rt-synthetic-refresh-token';

const identity = (): Row => ({ id: SB, user_id: OWNER, agent_id: 'pip', workspace_id: SPACE });

/** What deleting SPACE leaves: its identity rows gone, refresh records' sb_id nulled. */
function deleteSpace() {
  db.tables.agent_identities = db.tables.agent_identities.filter(
    (row) => row.workspace_id !== SPACE
  );
  for (const row of db.tables.mcp_tokens) if (row.sb_id === SB) row.sb_id = null;
}

const runnerToken = () =>
  `Bearer ${signRunnerAccessToken({ userId: OWNER, email: 'owner@example.test', sbSlug: 'pip', sbId: SB })}`;

beforeEach(() => {
  db.tables = {
    agent_identities: [identity()],
    mcp_tokens: [
      {
        id: 'rt-1',
        user_id: OWNER,
        client_id: 'ink-cli',
        refresh_token: REFRESH,
        scopes: ['mcp:tools'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        agent_id: 'pip',
        sb_id: SB,
        users: { email: 'owner@example.test' },
      },
    ],
  };
  db.failOn = null;
  db.throwOn = null;
  db.reads.length = 0;
});

describe('tokenIdentityState', () => {
  const supabase = fakeClient() as never;

  it('reads nothing for a token that names no SB', async () => {
    await expect(tokenIdentityState(supabase, { userId: OWNER })).resolves.toBe('none');
    expect(db.reads).toEqual([]);
  });

  it('checks a UUID exactly: live while its row exists, gone once it does not', async () => {
    await expect(
      tokenIdentityState(supabase, { userId: OWNER, sbId: SB, sbSlug: 'pip' })
    ).resolves.toBe('live');
    expect(db.reads[0].filters).toEqual([['id', SB]]);
    deleteSpace();
    await expect(
      tokenIdentityState(supabase, { userId: OWNER, sbId: SB, sbSlug: 'pip' })
    ).resolves.toBe('gone');
  });

  it("checks a slug alone among the token's user's identities", async () => {
    await expect(tokenIdentityState(supabase, { userId: OWNER, sbSlug: 'pip' })).resolves.toBe(
      'live'
    );
    expect(db.reads[0].filters).toEqual([
      ['user_id', OWNER],
      ['agent_id', 'pip'],
    ]);
    // Another person's "pip" is not this user's SB.
    deleteSpace();
    db.tables.agent_identities.push({
      id: 'x',
      user_id: OTHER_USER,
      agent_id: 'pip',
      workspace_id: OTHER_SPACE,
    });
    await expect(tokenIdentityState(supabase, { userId: OWNER, sbSlug: 'pip' })).resolves.toBe(
      'gone'
    );
  });

  it('says unreadable, and does not throw, when the read itself throws', async () => {
    const throwing = {
      from: () => {
        throw new Error('socket closed');
      },
    } as never;
    await expect(tokenIdentityState(throwing, { userId: OWNER, sbId: SB })).resolves.toBe(
      'unreadable'
    );
  });

  it('says unreadable, never live, when the read fails', async () => {
    db.failOn = 'agent_identities';
    await expect(tokenIdentityState(supabase, { userId: OWNER, sbId: SB })).resolves.toBe(
      'unreadable'
    );
  });
});

/**
 * Whether the verifier accepted the token, read the same way on either side
 * of this change: main returned the token's claims, or null; the fix returns
 * a verdict. So the regression below fails on main at the refusal itself.
 */
const accepted = (result: unknown): boolean =>
  !!result &&
  ((result as { ok?: unknown }).ok === true || 'userId' in (result as Record<string, unknown>));

describe('InkAuthProvider.verifyAccessToken: the SB a token names must still exist', () => {
  it('accepts a runner token while its SB exists, and refuses the same token once its space is deleted', async () => {
    const provider = new InkAuthProvider();
    const token = runnerToken();
    expect(accepted(await provider.verifyAccessToken(token))).toBe(true);

    deleteSpace();
    // On main this returned the token's claims: the deleted SB was accepted.
    expect(accepted(await provider.verifyAccessToken(token))).toBe(false);
    expect(await provider.verifyAccessToken(token)).toEqual({ ok: false, status: 401 });
    // The signature still checks out; only the identity read can tell.
    expect(provider.verifyAccessTokenSignature(token)).toMatchObject({ sbId: SB });
  });

  it('refuses a slug-only token whose slug its user no longer has', async () => {
    const provider = new InkAuthProvider();
    const token = `Bearer ${signInkAccessToken(
      {
        type: 'mcp_access',
        sub: OWNER,
        email: 'owner@example.test',
        scope: 'mcp:tools',
        sbSlug: 'pip',
      },
      3600
    )}`;
    expect(accepted(await provider.verifyAccessToken(token))).toBe(true);
    deleteSpace();
    expect(accepted(await provider.verifyAccessToken(token))).toBe(false);
    expect(await provider.verifyAccessToken(token)).toEqual({ ok: false, status: 401 });
  });

  it("leaves a person's token alone, with no identity read", async () => {
    const provider = new InkAuthProvider();
    const token = `Bearer ${signInkAccessToken(
      { type: 'mcp_access', sub: OWNER, email: 'owner@example.test', scope: 'mcp:tools' },
      3600
    )}`;
    expect(await provider.verifyAccessToken(token)).toMatchObject({ ok: true });
    expect(db.reads).toEqual([]);
  });

  it('answers 503, not 401, when the SB cannot be read', async () => {
    const provider = new InkAuthProvider();
    db.failOn = 'agent_identities';
    expect(await provider.verifyAccessToken(runnerToken())).toEqual({ ok: false, status: 503 });
  });
});

describe('refresh exchange: a record whose SB is gone mints nothing', () => {
  const refresh = (provider: InkAuthProvider) =>
    provider.exchangeRefreshToken({ refreshToken: REFRESH, clientId: 'ink-cli' });

  it('mints while the SB exists', async () => {
    await expect(refresh(new InkAuthProvider())).resolves.toHaveProperty('access_token');
  });

  it('refuses after the space is deleted, and deletes the record', async () => {
    deleteSpace();
    // ON DELETE SET NULL left the record bound by slug alone.
    expect(db.tables.mcp_tokens[0]).toMatchObject({ agent_id: 'pip', sb_id: null });
    await expect(refresh(new InkAuthProvider())).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(db.tables.mcp_tokens).toEqual([]);
  });

  it('a later SB of the same slug does not revive a refused record', async () => {
    deleteSpace();
    await refresh(new InkAuthProvider());
    db.tables.agent_identities.push({
      id: 'new',
      user_id: OWNER,
      agent_id: 'pip',
      workspace_id: SPACE,
    });
    await expect(refresh(new InkAuthProvider())).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it("the exchange alone can't refuse a nulled record while a same-slug SB exists", async () => {
    // A slug is unique only within a workspace, and a nulled record kept only
    // its slug. The database now leaves no such record: mcp_tokens_sb_id_fkey
    // deletes a deleted SB's records (deleted-space-tokens.integration.test.ts),
    // and a login that names an SB binds its UUID or is refused (below). This
    // fake has no foreign key, so it pins what the exchange does on its own.
    db.tables.agent_identities.push({
      id: 'twin',
      user_id: OWNER,
      agent_id: 'pip',
      workspace_id: OTHER_SPACE,
    });
    deleteSpace();
    await expect(refresh(new InkAuthProvider())).resolves.toHaveProperty('access_token');
  });
});

describe('login: a code exchange that names an SB binds its UUID, or issues nothing', () => {
  /**
   * Exchange an authorization code for OWNER, naming `sbSlug` or no SB. The code
   * is placed where the auth callback would put it; the callback's own path
   * (Supabase sign-in, account resolution) isn't what's under test here.
   */
  async function login(sbSlug?: string) {
    db.tables.mcp_tokens = [];
    const provider = new InkAuthProvider();
    (provider as unknown as { authCodes: Map<string, unknown> }).authCodes.set('code-1', {
      clientId: 'ink-cli',
      codeChallenge: '',
      redirectUri: 'http://localhost/callback',
      userId: OWNER,
      userEmail: 'owner@example.test',
      ...(sbSlug ? { sbSlug } : {}),
      expiresAt: Date.now() + 60_000,
    });
    const result = await provider.exchangeAuthorizationCode({
      code: 'code-1',
      codeVerifier: '',
      clientId: 'ink-cli',
    });
    return { provider, result };
  }

  it("binds a unique SB's UUID into the access token and the refresh record", async () => {
    const { provider, result } = await login('pip');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(db.tables.mcp_tokens).toHaveLength(1);
    expect(db.tables.mcp_tokens[0]).toMatchObject({ agent_id: 'pip', sb_id: SB });
    expect(provider.verifyAccessTokenSignature(`Bearer ${result.access_token}`)).toMatchObject({
      sbId: SB,
    });
  });

  // On main each of these issued a pair bound by slug alone: a refresh record
  // with sb_id null, which ON DELETE CASCADE can't reach (Lumen, PR #795).
  it.each([
    ['its account has no SB of that slug', 'invalid_grant'],
    ['more than one of its SBs has that slug', 'invalid_grant'],
    ['the identity read fails', 'server_error'],
    ['the identity read throws', 'server_error'],
  ])('refuses, and stores no refresh record, when %s', async (situation, expected) => {
    if (situation.startsWith('its account has no')) db.tables.agent_identities = [];
    if (situation.startsWith('more than one')) {
      db.tables.agent_identities.push({ ...identity(), id: 'twin', workspace_id: OTHER_SPACE });
    }
    if (situation === 'the identity read fails') db.failOn = 'agent_identities';
    if (situation === 'the identity read throws') db.throwOn = 'agent_identities';
    const { result } = await login('pip');
    expect('error' in result ? result.error : 'a token pair was issued').toBe(expected);
    expect(db.tables.mcp_tokens).toEqual([]);
  });

  it("leaves a person's login alone: no SB named, no identity read", async () => {
    const { result } = await login();
    expect(result).toHaveProperty('access_token');
    expect(db.reads.filter((read) => read.table === 'agent_identities')).toEqual([]);
    expect(db.tables.mcp_tokens[0]).toMatchObject({ agent_id: null, sb_id: null });
  });
});
