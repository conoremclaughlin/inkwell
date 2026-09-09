/**
 * OAuthService credential sources against the REAL database.
 *
 * The unit suite proves the decisions; this proves the two things a mocked
 * client cannot: that the version guard on every cloud row write matches (and
 * refuses) against real Postgres timestamps round-tripped through PostgREST,
 * and that the email binding works off the real users table. It also pins
 * that a healthy cloud row — the pre-existing flow — behaves exactly as before.
 *
 * Google itself is never called: the token endpoint is stubbed, everything
 * else passes through to the real fetch so the Supabase client keeps working.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY (local stack).
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { GOOGLE_OAUTH_SCOPES, GOOGLE_TOKEN_URL } from '@inklabs/shared';
import {
  INTEGRATION_TEST_USER_EMAIL,
  INTEGRATION_TEST_USER_ID,
} from '../test/integration-fixtures';
import type { Database } from '../data/supabase/types';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const d = SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;
const USER = INTEGRATION_TEST_USER_ID;
const EMAIL = INTEGRATION_TEST_USER_EMAIL;

d('OAuthService credential sources (integration)', () => {
  const client: SupabaseClient<Database> = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const realFetch = globalThis.fetch;
  const createdRows: string[] = [];
  const dirs: string[] = [];
  let OAuthService: typeof import('./oauth').OAuthService;
  let DesktopGoogleCredentialStore: typeof import('./google-desktop-credentials').DesktopGoogleCredentialStore;

  /** Google's token endpoint is stubbed; everything else (Supabase) is real. */
  function stubGoogle(handler: () => Promise<Response> | Response) {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(GOOGLE_TOKEN_URL)) return Promise.resolve(handler());
      return realFetch(input, init);
    });
  }

  function desktopDir(...emails: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ink-google-it-'));
    dirs.push(dir);
    for (const email of emails) {
      writeFileSync(
        join(dir, `${email}.json`),
        JSON.stringify({
          type: 'authorized_user',
          client_id: 'desk-client',
          client_secret: 'desk-secret',
          refresh_token: `rt-${email}`,
          email,
          scopes: [...GOOGLE_OAUTH_SCOPES],
        })
      );
    }
    return dir;
  }

  function service(sources: Array<'cloud' | 'desktop'>, dir: string) {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ access_token: 'access-desktop', expires_in: 3600 }),
    }));
    const desktopStore = new DesktopGoogleCredentialStore({
      dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { svc: new OAuthService({ sources, desktopStore }), fetchImpl };
  }

  async function insertCloudRow(
    overrides: Partial<Database['public']['Tables']['connected_accounts']['Insert']> = {}
  ) {
    const id = randomUUID();
    createdRows.push(id);
    const { error } = await client.from('connected_accounts').insert({
      id,
      user_id: USER,
      provider: 'google',
      provider_account_id: `it-${id}`,
      email: EMAIL,
      access_token: 'stored-cloud',
      refresh_token: 'refresh-cloud',
      token_type: 'Bearer',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scopes: [...GOOGLE_OAUTH_SCOPES],
      status: 'active',
      last_error: null,
      workspace_id: null,
      ...overrides,
    });
    expect(error).toBeNull();
    return id;
  }

  async function readRow(id: string) {
    const { data, error } = await client
      .from('connected_accounts')
      .select('status, access_token, refresh_token, last_error, last_used_at, updated_at')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function clearTestUserGoogleRows() {
    await client.from('connected_accounts').delete().eq('user_id', USER).eq('provider', 'google');
  }

  beforeAll(async () => {
    // The service reads its own client from config/env — same .env.local.
    ({ OAuthService } = await import('./oauth'));
    ({ DesktopGoogleCredentialStore } = await import('./google-desktop-credentials'));
    // The canonical integration user, with the email the binding keys on.
    const { data: existing } = await client
      .from('users')
      .select('id, email')
      .eq('id', USER)
      .maybeSingle();
    if (!existing) {
      const { error } = await client.from('users').insert({
        id: USER,
        email: EMAIL,
        username: 'integration-test-user',
        first_name: 'Integration',
        last_name: 'Test',
        timezone: 'UTC',
        preferences: {},
      });
      expect(error).toBeNull();
    } else if (existing.email !== EMAIL) {
      const { error } = await client.from('users').update({ email: EMAIL }).eq('id', USER);
      expect(error).toBeNull();
    }
  });

  beforeEach(async () => {
    await clearTestUserGoogleRows();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  afterAll(async () => {
    await clearTestUserGoogleRows();
  });

  it('pre-existing flow: a healthy cloud row is served as before — stored token, last_used_at stamped, no desktop read', async () => {
    const id = await insertCloudRow();
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    expect(await svc.getValidAccessToken(USER, 'google')).toBe('stored-cloud');

    const row = await readRow(id);
    expect(row.status).toBe('active');
    expect(row.access_token).toBe('stored-cloud');
    expect(row.last_used_at).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await svc.inspectAccountHealth(USER, 'google')).toMatchObject({
      state: 'active',
      source: 'cloud',
    });
  });

  it('refresh success lands through the version guard against real timestamps', async () => {
    const id = await insertCloudRow({
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
    stubGoogle(
      () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 })
        )
    );
    const { svc } = service(['cloud'], desktopDir());

    expect(await svc.getValidAccessToken(USER, 'google')).toBe('fresh-token');

    const row = await readRow(id);
    expect(row.access_token).toBe('fresh-token');
    expect(row.status).toBe('active');
    expect(row.last_error).toBeNull();
  });

  it('refresh failure marks the row expired through the version guard', async () => {
    const id = await insertCloudRow({
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
    stubGoogle(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const { svc } = service(['cloud'], desktopDir());

    await expect(svc.getValidAccessToken(USER, 'google')).rejects.toThrow(
      /^Failed to refresh google token$/
    );

    const row = await readRow(id);
    expect(row.status).toBe('expired');
    expect(row.last_error).toMatch(/Failed to refresh token/);
  });

  it('an expired row with no refresh token is marked expired (guard matched) and the desktop file serves', async () => {
    const id = await insertCloudRow({
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      refresh_token: null,
    });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    expect(await svc.getValidAccessToken(USER, 'google')).toBe('access-desktop');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const row = await readRow(id);
    expect(row.status).toBe('expired');
    expect(row.last_error).toBe('Access token expired and no refresh token is stored');
    expect(await svc.inspectAccountHealth(USER, 'google')).toMatchObject({
      state: 'active',
      source: 'desktop',
    });
  });

  it('the guard refuses a write whose observed version is stale, and accepts the current one', async () => {
    const id = await insertCloudRow({
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      refresh_token: null,
    });
    const before = await readRow(id);
    const staleVersion = before.updated_at as string;

    // A reconnect lands on the row: new tokens, new version.
    const { error: reconnectError } = await client
      .from('connected_accounts')
      .update({
        access_token: 'new-cloud',
        refresh_token: 'new-refresh',
        status: 'active',
        last_error: null,
        updated_at: new Date(Date.now() + 1000).toISOString(),
      })
      .eq('id', id);
    expect(reconnectError).toBeNull();

    // The exact statement shape the service uses, with the stale version: no row matches.
    const { error: staleError } = await client
      .from('connected_accounts')
      .update({
        status: 'expired',
        last_error: 'stale write',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('updated_at', staleVersion);
    expect(staleError).toBeNull();
    const afterStale = await readRow(id);
    expect(afterStale).toMatchObject({
      status: 'active',
      refresh_token: 'new-refresh',
      last_error: null,
    });

    // With the version actually observed on the row, the same statement lands.
    const { error: freshError } = await client
      .from('connected_accounts')
      .update({
        status: 'expired',
        last_error: 'fresh write',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('updated_at', afterStale.updated_at as string);
    expect(freshError).toBeNull();
    expect((await readRow(id)).status).toBe('expired');
  });

  it("never binds another address's desktop file to the test user (real users table)", async () => {
    const { svc, fetchImpl } = service(
      ['cloud', 'desktop'],
      desktopDir('someone-else@example.com')
    );

    await expect(svc.getValidAccessToken(USER, 'google')).rejects.toThrow(
      /^No active google account found$/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await svc.inspectAccountHealth(USER, 'google')).toMatchObject({
      state: 'missing',
      source: null,
    });
  });

  it('a bound desktop file is used when no cloud row exists, and an unreadable one reads as unknown', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const dir = desktopDir(EMAIL);
    const { svc, fetchImpl } = service(['cloud', 'desktop'], dir);

    expect(await svc.getValidAccessToken(USER, 'google')).toBe('access-desktop');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const file = join(dir, `${EMAIL}.json`);
    chmodSync(file, 0o000);
    try {
      const fresh = service(['cloud', 'desktop'], dir).svc;
      const health = await fresh.inspectAccountHealth(USER, 'google');
      expect(health).toMatchObject({ state: 'unknown', source: null });
      expect(health.reason).toMatch(/could not be read or parsed/);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});
