/**
 * OAuthService.disconnectAccount: what it asks the provider, and what it says
 * happened. Over the in-memory FakePostgrest, with fetch stubbed; the account
 * and tokens are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePostgrest } from '../test/fake-postgrest';

let db: FakePostgrest;
vi.mock('@supabase/supabase-js', () => ({ createClient: () => db }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
    GOOGLE_CLIENT_ID: 'synthetic-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  },
  isDevelopment: () => false,
}));
vi.mock('../utils/request-context', () => ({
  getRequestContext: () => undefined,
  getSessionContext: () => undefined,
}));

const { OAuthService } = await import('./oauth');

const USER = 'user-ada';

function seedAccount(tokens: { access_token: string; refresh_token: string | null }) {
  return db.seed('connected_accounts', {
    user_id: USER,
    provider: 'google',
    provider_account_id: 'g-1',
    status: 'active',
    workspace_id: null,
    ...tokens,
  }).id as string;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new FakePostgrest();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('disconnecting a Google account', () => {
  it('revokes the refresh token in the request body, never the URL, and says Google confirmed it', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const id = seedAccount({ access_token: 'access-1', refresh_token: 'refresh-1' });
    const service = new OAuthService({ sources: ['cloud'] });
    expect(await service.disconnectAccount(id, USER, null)).toEqual({ revoked: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(url)).not.toContain('refresh-1');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=refresh-1',
    });
    expect(db.rows('connected_accounts')).toHaveLength(0);
  });

  it('uses the access token when there is no refresh token', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const id = seedAccount({ access_token: 'access-only', refresh_token: null });
    await new OAuthService({ sources: ['cloud'] }).disconnectAccount(id, USER, null);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ body: 'token=access-only' });
  });

  it('says Google didn’t revoke it when Google refuses or can’t be reached, and removes the row anyway', async () => {
    for (const answer of [
      () => Promise.resolve(new Response('{"error":"invalid_token"}', { status: 400 })),
      () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      fetchMock.mockImplementationOnce(answer);
      const id = seedAccount({ access_token: 'a', refresh_token: 'r' });
      expect(
        await new OAuthService({ sources: ['cloud'] }).disconnectAccount(id, USER, null)
      ).toEqual({
        revoked: false,
      });
      expect(db.rows('connected_accounts')).toHaveLength(0);
    }
  });

  it('touches nobody else’s account', async () => {
    const id = seedAccount({ access_token: 'a', refresh_token: 'r' });
    await expect(
      new OAuthService({ sources: ['cloud'] }).disconnectAccount(id, 'user-sam', null)
    ).rejects.toThrow('Account not found');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.rows('connected_accounts')).toHaveLength(1);
  });
});

describe('the Google sign-in address', () => {
  it('asks Google to keep what was granted before, so a reconnect can’t quietly narrow it', () => {
    const url = new URL(
      new OAuthService({ sources: ['cloud'] }).getAuthorizationUrl(
        'google',
        'https://inkwell.example.test/api/admin/oauth/google/callback',
        'synthetic-state'
      )
    );
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('state')).toBe('synthetic-state');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });
});
