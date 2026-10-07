/**
 * The app's Connectors routes, and how the shared OAuth callback settles an
 * app attempt. The OAuth service is a stub; the people, accounts and tokens are
 * invented. No provider, database or network is reached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const oauth = vi.hoisted(() => ({
  isProviderConfigured: vi.fn(() => true),
  getAuthorizationUrl: vi.fn(
    (_provider: string, redirect: string, state: string) =>
      `https://accounts.example.test/auth?redirect=${encodeURIComponent(redirect)}&state=${state}`
  ),
  exchangeCode: vi.fn(),
  getUserInfo: vi.fn(),
  saveConnectedAccount: vi.fn(),
  getConnectedAccounts: vi.fn(),
  getCredentialSources: vi.fn(() => ['cloud']),
  describeDesktopCredentials: vi.fn(),
  disconnectAccount: vi.fn(),
}));
vi.mock('../services/oauth', () => ({ getOAuthService: () => oauth }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    throw new Error('Unexpected database access');
  }),
}));
vi.mock('../config/env', async () => ({
  env: { ...(await import('../test/fake-env')).fakeEnv, MCP_HTTP_PORT: 3001 },
  isDevelopment: () => false,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import adminRouter from './admin';
import { connectorsRouter, servicesFrom } from './admin-connectors';
import { oauthStateStore, resetOAuthAttempts } from '../services/oauth-attempts';

type Handler = (req: Request, res: Response) => unknown;
/* eslint-disable @typescript-eslint/no-explicit-any */
function route(router: unknown, method: string, path: string): Handler {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ADA = 'user-ada';
const SAM = 'user-sam';

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    html: undefined as string | undefined,
    headers: {} as Record<string, string>,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    type() {
      return res;
    },
    send(html: string) {
      res.html = html;
      return res;
    },
  };
  return res;
}

async function call(
  handler: Handler,
  { as = ADA, params = {}, query = {} }: { as?: string; params?: object; query?: object } = {}
) {
  const res = response();
  await handler(
    { params, query, inkUserId: as, inkWorkspaceId: `ws-${as}` } as unknown as Request,
    res as unknown as Response
  );
  return res;
}

const list = route(connectorsRouter, 'get', '/google');
const start = route(connectorsRouter, 'post', '/google/start');
const attempt = route(connectorsRouter, 'get', '/google/attempts/:attemptId');
const disconnect = route(connectorsRouter, 'delete', '/google/:accountId');
const callback = route(adminRouter, 'get', '/oauth/:provider/callback');
const dashboardAuthorize = route(adminRouter, 'get', '/oauth/:provider/authorize');

const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const account = {
  id: 'acct-1',
  provider: 'google',
  email: 'ada@example.test',
  displayName: 'Ada',
  status: 'active',
  scopes: [GMAIL, CALENDAR, 'https://www.googleapis.com/auth/userinfo.email'],
  createdAt: '2026-10-01T10:00:00.000Z',
  accessToken: 'never-sent',
};

async function startAttempt(as = ADA) {
  const res = await call(start, { as });
  const { authUrl, attemptId } = res.body as { authUrl: string; attemptId: string };
  return { attemptId, state: new URL(authUrl).searchParams.get('state')! };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetOAuthAttempts();
  oauth.isProviderConfigured.mockReturnValue(true);
  oauth.getCredentialSources.mockReturnValue(['cloud']);
  oauth.getConnectedAccounts.mockResolvedValue([account]);
  oauth.exchangeCode.mockResolvedValue({ accessToken: 'synthetic-access' });
  oauth.getUserInfo.mockResolvedValue({ id: 'g-1', email: 'ada@example.test' });
  oauth.saveConnectedAccount.mockResolvedValue({ id: 'acct-1' });
  oauth.disconnectAccount.mockResolvedValue({ revoked: true });
});

describe('listing', () => {
  it('shows the person’s Google accounts and the services granted, never tokens or paths', async () => {
    oauth.getConnectedAccounts.mockResolvedValue([
      account,
      { ...account, id: 'acct-2', status: 'expired', scopes: [] },
      { ...account, id: 'other', provider: 'github' },
    ]);
    const res = await call(list);
    expect(res.body).toEqual({
      configured: true,
      accounts: [
        {
          id: 'acct-1',
          email: 'ada@example.test',
          displayName: 'Ada',
          status: 'active',
          services: ['gmail', 'calendar'],
          connectedAt: '2026-10-01T10:00:00.000Z',
        },
        {
          id: 'acct-2',
          email: 'ada@example.test',
          displayName: 'Ada',
          status: 'needs_attention',
          services: [],
          connectedAt: '2026-10-01T10:00:00.000Z',
        },
      ],
      serverSignIn: 'no',
    });
    expect(JSON.stringify(res.body)).not.toContain('never-sent');
    expect(oauth.getConnectedAccounts).toHaveBeenCalledWith(ADA, `ws-${ADA}`);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('says whether the server could still use a desktop sign-in, without its path', async () => {
    oauth.getCredentialSources.mockReturnValue(['cloud', 'desktop']);
    const serverSignIn = async () =>
      ((await call(list)).body as { serverSignIn: string }).serverSignIn;
    oauth.describeDesktopCredentials.mockResolvedValue({
      dir: '/Users/host/.ink/google',
      error: null,
      credentials: [{ path: '/Users/host/.ink/google/ada.json', state: 'active' }],
    });
    const res = await call(list);
    expect((res.body as { serverSignIn: string }).serverSignIn).toBe('yes');
    expect(JSON.stringify(res.body)).not.toContain('/Users/host');
    oauth.describeDesktopCredentials.mockResolvedValue({
      error: null,
      credentials: [{ path: '/x', state: 'unusable' }],
    });
    expect(await serverSignIn()).toBe('no');
  });

  it('says unknown, never no, when it can’t tell', async () => {
    oauth.getCredentialSources.mockReturnValue(['cloud', 'desktop']);
    const serverSignIn = async () =>
      ((await call(list)).body as { serverSignIn: string }).serverSignIn;
    oauth.describeDesktopCredentials.mockResolvedValue({
      error: 'storage unreadable',
      credentials: [],
    });
    expect(await serverSignIn()).toBe('unknown');
    oauth.describeDesktopCredentials.mockRejectedValue(new Error('lookup failed'));
    expect(await serverSignIn()).toBe('unknown');
    // Without desktop as a source, the server can't use one at all.
    oauth.getCredentialSources.mockReturnValue(['cloud']);
    expect(await serverSignIn()).toBe('no');
  });

  it('maps the services from their scopes', () => {
    expect(
      servicesFrom([
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/gmail.send',
      ])
    ).toEqual(['gmail', 'drive', 'docs', 'sheets']);
  });
});

describe('connecting', () => {
  it('refuses when Google isn’t set up', async () => {
    oauth.isProviderConfigured.mockReturnValue(false);
    expect(await call(start)).toMatchObject({
      statusCode: 409,
      body: { code: 'google_not_configured' },
    });
  });

  it('starts an attempt whose state belongs to it, and nothing has settled it yet', async () => {
    const res = await call(start);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const { attemptId, state } = await startAttempt();
    expect(oauthStateStore.get(state)).toMatchObject({
      userId: ADA,
      provider: 'google',
      appAttemptId: attemptId,
    });
    // An account already connected is not evidence for this attempt.
    expect((await call(attempt, { params: { attemptId } })).body).toEqual({
      status: 'pending',
      accountId: null,
    });
  });

  it('is settled only by its own callback, with the account it saved', async () => {
    const { attemptId, state } = await startAttempt();
    const page = await call(callback, {
      params: { provider: 'google' },
      query: { state, code: 'synthetic-code' },
    });
    expect((await call(attempt, { params: { attemptId } })).body).toEqual({
      status: 'connected',
      accountId: 'acct-1',
    });
    expect(page.html).toContain('href="inkling://connectors"');
    expect(page.html).toContain('Go back to Inkling');
  });

  it('settles a consumed state with a missing or malformed code as failed', async () => {
    for (const query of [{}, { code: '' }, { code: ['synthetic-code'] }]) {
      const { attemptId, state } = await startAttempt();
      await call(callback, { params: { provider: 'google' }, query: { state, ...query } });
      expect((await call(attempt, { params: { attemptId } })).body).toMatchObject({
        status: 'failed',
      });
    }
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('lets an unknown state or another provider’s callback settle nothing', async () => {
    const { attemptId, state } = await startAttempt();
    await call(callback, {
      params: { provider: 'google' },
      query: { state: 'not-a-state', code: 'synthetic-code' },
    });
    await call(callback, {
      params: { provider: 'github' },
      query: { state, code: 'synthetic-code' },
    });
    expect((await call(attempt, { params: { attemptId } })).body).toMatchObject({
      status: 'pending',
    });
    // The state wasn't consumed, so its own callback still settles it.
    await call(callback, {
      params: { provider: 'google' },
      query: { state, code: 'synthetic-code' },
    });
    expect((await call(attempt, { params: { attemptId } })).body).toMatchObject({
      status: 'connected',
    });
  });

  it('sends Google the same return address when starting as when exchanging the code', async () => {
    const res = await call(start);
    const authUrl = new URL((res.body as { authUrl: string }).authUrl);
    const state = authUrl.searchParams.get('state')!;
    await call(callback, {
      params: { provider: 'google' },
      query: { state, code: 'synthetic-code' },
    });
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      'google',
      'synthetic-code',
      authUrl.searchParams.get('redirect')
    );
  });

  it('reads a denial, a failure and a late return as such, never as connected', async () => {
    const denied = await startAttempt();
    await call(callback, {
      params: { provider: 'google' },
      query: { state: denied.state, error: 'access_denied' },
    });
    oauth.exchangeCode.mockRejectedValueOnce(new Error('boom'));
    const failed = await startAttempt();
    await call(callback, {
      params: { provider: 'google' },
      query: { state: failed.state, code: 'synthetic-code' },
    });
    const late = await startAttempt();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await call(callback, {
      params: { provider: 'google' },
      query: { state: late.state, code: 'synthetic-code' },
    });
    const statuses = await Promise.all(
      [denied, failed, late].map(
        async ({ attemptId }) =>
          ((await call(attempt, { params: { attemptId } })).body as { status: string }).status
      )
    );
    expect(statuses).toEqual(['denied', 'failed', 'expired']);
  });

  it('reads an attempt that never came back as expired once its state runs out', async () => {
    const { attemptId } = await startAttempt();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await call(attempt, { params: { attemptId } })).body).toMatchObject({
      status: 'expired',
    });
  });

  it('never shows one person another’s attempt', async () => {
    const { attemptId } = await startAttempt(ADA);
    expect((await call(attempt, { as: SAM, params: { attemptId } })).body).toEqual({
      status: 'unknown',
      accountId: null,
    });
    expect((await call(attempt, { params: { attemptId: 'made-up' } })).body).toMatchObject({
      status: 'unknown',
    });
  });

  it('leaves the dashboard’s flow as it was: no app link, no attempt', async () => {
    const res = response();
    await dashboardAuthorize(
      {
        params: { provider: 'google' },
        inkUserId: ADA,
        inkWorkspaceId: 'ws',
      } as unknown as Request,
      res as unknown as Response
    );
    const state = new URL((res.body as { authUrl: string }).authUrl).searchParams.get('state')!;
    expect(oauthStateStore.get(state)?.appAttemptId).toBeUndefined();
    const page = await call(callback, {
      params: { provider: 'google' },
      query: { state, code: 'synthetic-code' },
    });
    expect(page.html).not.toContain('inkling://');
    expect(page.html).toContain('Close Window');
  });
});

describe('disconnecting', () => {
  it('says what was removed, whether Google revoked it, and whether the server still could', async () => {
    oauth.disconnectAccount.mockResolvedValue({ revoked: false });
    const res = await call(disconnect, { params: { accountId: 'acct-1' } });
    expect(res.body).toEqual({ removed: true, revokedAtGoogle: false, serverSignIn: 'no' });
    expect(oauth.disconnectAccount).toHaveBeenCalledWith('acct-1', ADA, `ws-${ADA}`);
  });

  it('refuses an account that isn’t the person’s Google account', async () => {
    for (const accountId of ['someone-else', 'other']) {
      oauth.getConnectedAccounts.mockResolvedValue([
        account,
        { ...account, id: 'other', provider: 'github' },
      ]);
      const res = await call(disconnect, { params: { accountId } });
      expect(res).toMatchObject({ statusCode: 404, body: { code: 'account_not_found' } });
    }
    expect(oauth.disconnectAccount).not.toHaveBeenCalled();
  });
});
