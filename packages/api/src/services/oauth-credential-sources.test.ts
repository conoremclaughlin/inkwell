/**
 * OAuthService with two Google credential sources.
 *
 * Pins: the cloud path is untouched for anyone without a desktop file; a
 * desktop file is bound strictly by the user's email; the configured order is
 * the order tried; inspectAccountHealth names the source getValidAccessToken
 * would use; and the scope list is the one the CLI consents to.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_OAUTH_SCOPES } from '@inklabs/shared';
import { createTableAwareSupabaseMock } from '../test/table-aware-supabase-mock';

const from = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from }),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  getRequestContext: () => undefined,
  getSessionContext: () => undefined,
}));

const { OAuthService } = await import('./oauth');
const { DesktopGoogleCredentialStore } = await import('./google-desktop-credentials');

const USER_ID = '00000000-0000-0000-0000-000000000001';
const EMAIL = 'me@example.com';
const NOW = new Date('2026-09-08T12:00:00.000Z');

const cleanup: string[] = [];
function desktopDir(...emails: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-google-sources-'));
  cleanup.push(dir);
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

function tables(specs: Parameters<typeof createTableAwareSupabaseMock>[0]) {
  const mock = createTableAwareSupabaseMock(specs);
  from.mockImplementation(mock.from);
  return mock;
}

const userWithEmail = { maybeSingle: [{ data: { email: EMAIL }, error: null }] };
const noCloudRow = { maybeSingle: [{ data: null, error: null }] };
const cloudUpdateAck = { then: { data: null, error: null } };

function cloudRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
    status: 'active',
    access_token: 'stored-cloud',
    refresh_token: 'refresh-cloud',
    expires_at: '2026-09-09T12:00:00.000Z',
    last_error: null,
    last_used_at: null,
    updated_at: '2026-09-08T11:00:00.000Z',
    ...overrides,
  };
}

function desktopFetch(...responses: Array<{ status?: number; body?: string; token?: string }>) {
  const fetchImpl = vi.fn();
  // No arguments means "Google grants once" — the common case.
  for (const r of responses.length > 0 ? responses : [{}]) {
    const status = r.status ?? 200;
    const body =
      r.body ?? JSON.stringify({ access_token: r.token ?? 'access-desktop', expires_in: 3600 });
    fetchImpl.mockResolvedValueOnce({
      ok: status < 400,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
  }
  return fetchImpl;
}

function service(sources: Array<'cloud' | 'desktop'>, dir: string, fetchImpl = desktopFetch()) {
  const desktopStore = new DesktopGoogleCredentialStore({
    dir,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW.getTime(),
  });
  return { svc: new OAuthService({ sources, desktopStore }), fetchImpl };
}

function tablesTouched(): string[] {
  return [...new Set(from.mock.calls.map((call) => call[0] as string))];
}

beforeEach(() => {
  from.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  while (cleanup.length) rmSync(cleanup.pop() as string, { recursive: true, force: true });
});

describe('the scope list', () => {
  it('is the shared list the CLI consents to — one definition, not two copies', () => {
    const { svc } = service(['cloud'], desktopDir());
    expect(svc.getRequiredScopes('google')).toEqual([...GOOGLE_OAUTH_SCOPES]);
  });
});

describe('getValidAccessToken — source order and binding', () => {
  it('cloud first: an active cloud row wins and nothing desktop is consulted', async () => {
    tables({
      connected_accounts: [{ maybeSingle: [{ data: cloudRow(), error: null }] }, cloudUpdateAck],
    });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    expect(await svc.getValidAccessToken(USER_ID, 'google')).toBe('stored-cloud');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tablesTouched()).toEqual(['connected_accounts']);
  });

  it('falls through to a desktop file bound to the user, and health names that source', async () => {
    tables({
      users: [userWithEmail],
      connected_accounts: [noCloudRow, { then: { data: [], error: null } }],
    });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    expect(await svc.getValidAccessToken(USER_ID, 'google')).toBe('access-desktop');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('refresh_token')).toBe(
      `rt-${EMAIL}`
    );

    const health = await svc.inspectAccountHealth(USER_ID, 'google');
    expect(health.source).toBe('desktop');
    expect(health.state).toBe('active');
  });

  it("never binds another address's file — the user sees the message they always saw", async () => {
    tables({
      users: [userWithEmail],
      connected_accounts: [noCloudRow, { then: { data: [], error: null } }],
    });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir('other@example.com'));

    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
      /^No active google account found$/
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    const health = await svc.inspectAccountHealth(USER_ID, 'google');
    expect(health).toMatchObject({
      state: 'missing',
      source: null,
      reason: 'No google account has been connected',
    });
  });

  it('binds nothing when the user email cannot be read', async () => {
    tables({
      users: [{ maybeSingle: [{ data: null, error: { message: 'connection reset' } }] }],
      connected_accounts: [noCloudRow],
    });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
      /^No active google account found$/
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    // Lumen (PR #588): the failed lookup is not "nothing connected" — health
    // must say it could not look. Failures are never cached, so the next call
    // asks again.
    tables({
      users: [{ maybeSingle: [{ data: null, error: { message: 'connection reset' } }] }],
      connected_accounts: [{ then: { data: [], error: null } }],
    });
    const health = await svc.inspectAccountHealth(USER_ID, 'google');
    expect(health).toMatchObject({ state: 'unknown', source: null });
    expect(health.reason).toMatch(/connection reset/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names both sources when both had a credential and both failed', async () => {
    // Cloud: inside the refresh window, and Google refuses the refresh.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant"}',
      })
    );
    tables({
      users: [userWithEmail],
      connected_accounts: [
        {
          maybeSingle: [
            { data: cloudRow({ expires_at: '2026-09-08T12:02:00.000Z' }), error: null },
          ],
        },
        cloudUpdateAck,
      ],
    });
    const { svc } = service(
      ['cloud', 'desktop'],
      desktopDir(EMAIL),
      desktopFetch({ status: 400, body: '{"error":"invalid_grant","error_description":"expired"}' })
    );

    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
      /No usable google credential — cloud: Failed to refresh google token; desktop: Google refused the desktop credential .*invalid_grant/
    );
  });

  it('desktop first: the cloud table is never touched when the desktop file serves', async () => {
    tables({ users: [userWithEmail] });
    const { svc } = service(['desktop', 'cloud'], desktopDir(EMAIL));

    expect(await svc.getValidAccessToken(USER_ID, 'google')).toBe('access-desktop');
    expect(tablesTouched()).toEqual(['users']);
  });

  it('a non-Google provider never consults the desktop source', async () => {
    tables({ connected_accounts: [noCloudRow] });
    const { svc, fetchImpl } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    await expect(svc.getValidAccessToken(USER_ID, 'github')).rejects.toThrow(
      /^No active github account found$/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tablesTouched()).toEqual(['connected_accounts']);
  });
});

describe('inspectAccountHealth — the verdict follows the call', () => {
  it('reports the desktop file as the pending source when the cloud row is unusable', async () => {
    tables({
      users: [userWithEmail],
      connected_accounts: [{ then: { data: [cloudRow({ status: 'expired' })], error: null } }],
    });
    const { svc } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    const health = await svc.inspectAccountHealth(USER_ID, 'google');
    expect(health.source).toBe('desktop');
    expect(health.state).toBe('refresh_required');
  });

  it('prefers a refusal over a blank: a refused desktop file is reported, not hidden behind "missing"', async () => {
    tables({
      users: [userWithEmail],
      connected_accounts: [noCloudRow, { then: { data: [], error: null } }],
    });
    const { svc } = service(
      ['cloud', 'desktop'],
      desktopDir(EMAIL),
      desktopFetch({ status: 400, body: '{"error":"invalid_grant"}' })
    );
    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(/invalid_grant/);

    const health = await svc.inspectAccountHealth(USER_ID, 'google');
    expect(health).toMatchObject({ state: 'unusable', source: 'desktop' });
    expect(health.lastError).toContain('invalid_grant');
  });

  it('describes only the credential bound to this user', async () => {
    tables({ users: [userWithEmail] });
    const dir = desktopDir(EMAIL, 'other@example.com');
    const { svc } = service(['cloud', 'desktop'], dir);

    const described = await svc.describeDesktopCredentials(USER_ID);
    expect(described.dir).toBe(dir);
    expect(described.email).toBe(EMAIL);
    expect(described.credentials.map((c) => c.email)).toEqual([EMAIL]);
    expect(described.credentials[0].state).toBe('refresh_required');
    expect(described.error).toBeNull();
  });
});

describe('Lumen review (PR #588): fallback and unknown state', () => {
  it('uses desktop when the active cloud row has an expired token and cannot refresh', async () => {
    const row = cloudRow({ expires_at: '2026-09-08T11:00:00.000Z', refresh_token: null });
    tables({
      users: [userWithEmail],
      connected_accounts: [
        { then: { data: [row], error: null } },
        { maybeSingle: [{ data: row, error: null }] },
        cloudUpdateAck,
      ],
    });
    const { svc } = service(['cloud', 'desktop'], desktopDir(EMAIL));

    expect(await svc.inspectAccountHealth(USER_ID, 'google')).toMatchObject({
      state: 'refresh_required',
      source: 'desktop',
    });
    expect(await svc.getValidAccessToken(USER_ID, 'google')).toBe('access-desktop');
  });

  it('marks that expired, refresh-less cloud row so the dashboard agrees with the verdict', async () => {
    const row = cloudRow({ expires_at: '2026-09-08T11:00:00.000Z', refresh_token: null });
    const mock = tables({
      connected_accounts: [{ maybeSingle: [{ data: row, error: null }] }, cloudUpdateAck],
    });
    const { svc } = service(['cloud'], desktopDir());

    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
      /^Access token expired and no refresh token is stored$/
    );
    const update = mock.calls.find(
      (c) =>
        c.table === 'connected_accounts' &&
        (c.builder.update as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    expect(update).toBeDefined();
    expect((update!.builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'expired',
      last_error: 'Access token expired and no refresh token is stored',
    });
  });

  it('reads unreadable desktop storage as unknown in health and binds nothing for access', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const dir = desktopDir(EMAIL);
    chmodSync(dir, 0o000);
    try {
      tables({
        users: [userWithEmail],
        connected_accounts: [{ then: { data: [], error: null } }, noCloudRow],
      });
      const { svc, fetchImpl } = service(['cloud', 'desktop'], dir);

      const health = await svc.inspectAccountHealth(USER_ID, 'google');
      expect(health).toMatchObject({ state: 'unknown', source: null });
      expect(health.reason).toMatch(/Could not read/);

      await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
        /^No active google account found$/
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

/**
 * A row that another writer replaces between this service's read and its
 * write — the OAuth callback saving a fresh login to the same id. Writes must
 * be guarded on the version they observed. (Lumen, PR #588 round 3.)
 */
function racingCloudRow(old: Record<string, unknown>, replacement: Record<string, unknown>) {
  const live: Record<string, unknown> = { ...old };
  from.mockImplementation(() => {
    const filters: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      },
      is: (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        // The read has produced the old snapshot; before its consumer's write
        // arrives, the callback saves a new login to that id.
        Object.assign(live, replacement);
        return { data: { ...old }, error: null };
      },
      update: (value: Record<string, unknown>) => {
        patch = value;
        return builder;
      },
      then: (resolve: (value: { data: null; error: null }) => unknown) => {
        if (patch && filters.every(([key, value]) => live[key] === value))
          Object.assign(live, patch);
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return builder;
  });
  return live;
}

const RECONNECTED = {
  access_token: 'new-cloud',
  refresh_token: 'new-refresh',
  expires_at: '2026-09-09T12:00:00.000Z',
  updated_at: NOW.toISOString(),
  status: 'active',
  last_error: null,
};

describe('Lumen review round 3 (PR #588): incomplete reads and concurrent cloud reconnect', () => {
  it('reports unknown when the directory is readable but the bound credential file is not', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const dir = desktopDir(EMAIL);
    const file = join(dir, `${EMAIL}.json`);
    chmodSync(file, 0o000);
    try {
      tables({
        users: [userWithEmail],
        connected_accounts: [{ then: { data: [], error: null } }],
      });
      const { svc, fetchImpl } = service(['cloud', 'desktop'], dir);
      const health = await svc.inspectAccountHealth(USER_ID, 'google');
      expect(health).toMatchObject({ state: 'unknown', source: null });
      expect(health.reason).toMatch(/could not be read or parsed/);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('does not expire a newly reconnected row based on a stale no-refresh-token read', async () => {
    const live = racingCloudRow(
      cloudRow({ expires_at: '2026-09-08T11:00:00.000Z', refresh_token: null }),
      RECONNECTED
    );
    const { svc } = service(['cloud'], desktopDir());
    await svc.getValidAccessToken(USER_ID, 'google').catch(() => undefined);
    expect(live).toMatchObject({
      status: 'active',
      access_token: 'new-cloud',
      refresh_token: 'new-refresh',
      last_error: null,
    });
  });

  it('does not expire a newly reconnected row when a stale refresh token is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant"}',
      })
    );
    const live = racingCloudRow(cloudRow({ expires_at: '2026-09-08T12:02:00.000Z' }), RECONNECTED);
    const { svc } = service(['cloud'], desktopDir());
    await expect(svc.getValidAccessToken(USER_ID, 'google')).rejects.toThrow(
      /^Failed to refresh google token$/
    );
    expect(live).toMatchObject({
      status: 'active',
      refresh_token: 'new-refresh',
      last_error: null,
    });
  });

  it('does not overwrite a newly reconnected row with a refresh of the old token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-old',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      })
    );
    const live = racingCloudRow(cloudRow({ expires_at: '2026-09-08T12:02:00.000Z' }), RECONNECTED);
    const { svc } = service(['cloud'], desktopDir());
    // The refreshed token is still good for THIS call…
    expect(await svc.getValidAccessToken(USER_ID, 'google')).toBe('refreshed-old');
    // …but the row keeps the login that arrived in between.
    expect(live).toMatchObject({ access_token: 'new-cloud', refresh_token: 'new-refresh' });
  });
});
