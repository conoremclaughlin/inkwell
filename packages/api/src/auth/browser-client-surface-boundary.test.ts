/**
 * A `browser_client` credential must reach nothing outside the companion
 * router.
 *
 * Every authenticated surface in packages/api/src goes through one of three
 * doors, and this file walks all three:
 *
 *   1. `InkAuthProvider.verifyAccessToken` — /mcp, /token/delegate,
 *      /api/hooks, /api/sessions, /api/alerts
 *   2. `adminAuthMiddleware` — /api/admin/*, including its two `mcp_access`
 *      exception routes
 *   3. `chatAuthMiddleware` — /api/chat, /api/kindle (Supabase tokens only)
 *
 * The census test at the bottom is what keeps that list honest: it fails when
 * a new bearer-verification call site appears anywhere in the package, so a
 * fourth door cannot be added without someone deciding whether a browser
 * token may pass it. Enumerating the doors is the point — testing one and
 * inferring the rest is how an "every" claim gets made without being checked.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
  },
  // admin.ts imports this alongside `env`; without it the module throws at
  // import time and every test below fails for an unrelated reason.
  isDevelopment: () => false,
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { signBrowserClientToken } from './browser-client-tokens';
import { signInkAccessToken } from './ink-tokens';
import { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import { createHookLifecycleRouter } from '../routes/hook-lifecycle';
import type { DataComposer } from '../data/composer';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const browserToken = () =>
  signBrowserClientToken({
    userId: USER_ID,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    installationId: 'installation-abc',
    grantId: '33333333-3333-4333-8333-333333333333',
  });

const mcpToken = () =>
  signInkAccessToken(
    { type: 'mcp_access', sub: USER_ID, email: 'mcp@example.com', scope: 'mcp:tools' },
    3600
  );

const adminToken = () =>
  signInkAccessToken(
    { type: 'pcp_admin', sub: USER_ID, email: 'admin@example.com', scope: 'admin' },
    3600
  );

// ---------------------------------------------------------------------------
// Door 1: InkAuthProvider.verifyAccessToken
// ---------------------------------------------------------------------------

describe('door 1 — InkAuthProvider.verifyAccessToken', () => {
  const provider = new InkAuthProvider();

  it('refuses a browser_client token', () => {
    expect(provider.verifyAccessToken(`Bearer ${browserToken()}`)).toBeNull();
  });

  it('CONTROL: accepts an mcp_access token', () => {
    // Without this the refusal above would also pass against a verifier that
    // rejects everything — which is what a bad JWT_SECRET in the harness
    // would produce.
    const payload = provider.verifyAccessToken(`Bearer ${mcpToken()}`);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(USER_ID);
  });

  it('refuses a pcp_admin token too, so the door is type-pinned in both directions', () => {
    expect(provider.verifyAccessToken(`Bearer ${adminToken()}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Door 1, end to end through a router that uses it
// ---------------------------------------------------------------------------

describe('door 1 end-to-end — /api/hooks', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const dataComposer = {
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      }),
      repositories: {
        memory: {
          getSession: async () => null,
          updateSession: async () => undefined,
        },
      },
    } as unknown as DataComposer;

    const app = express();
    app.use(express.json());
    app.use('/api/hooks', createHookLifecycleRouter(dataComposer));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const postHook = (token: string) =>
    fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: '44444444-4444-4444-8444-444444444444' }),
    });

  it('refuses a browser_client token with 401', async () => {
    expect((await postHook(browserToken())).status).toBe(401);
  });

  it('CONTROL: an mcp_access token gets past authentication', async () => {
    // Not asserting 200 — the fake data layer decides what happens after the
    // gate. What matters is that the gate is not what stopped it.
    expect((await postHook(mcpToken())).status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Door 2: adminAuthMiddleware, including its mcp_access exception routes
// ---------------------------------------------------------------------------

describe('door 2 — /api/admin', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Tier 3 falls through to supabase.auth.getUser(). A token we signed with
    // JWT_SECRET is not a Supabase-issued JWT, so Supabase would reject it;
    // the mock stands in for that rejection rather than asserting it.
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
        from: () => ({
          select: () => ({
            eq: () => ({ single: async () => ({ data: null, error: { message: 'none' } }) }),
          }),
        }),
      }),
    }));

    const { default: adminRouter } = await import('../routes/admin');

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.doUnmock('@supabase/supabase-js');
  });

  const getAdmin = (path: string, token?: string) =>
    fetch(`${baseUrl}/api/admin${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('refuses a browser_client token on an ordinary admin route', async () => {
    expect((await getAdmin('/workspaces', browserToken())).status).toBe(401);
  });

  // The two routes that deliberately accept a *different* token type than the
  // rest of the admin router. They are the likeliest place for a third type to
  // be let in by accident, so they get named individually.
  it.each(['/sessions/synced', '/approval-requests'])(
    'refuses a browser_client token on the mcp_access exception route %s',
    async (path) => {
      expect((await getAdmin(path, browserToken())).status).toBe(401);
    }
  );

  it('CONTROL: an mcp_access token IS accepted on an exception route', async () => {
    // Proves the exception routes are reachable in this harness — otherwise
    // the two refusals above would pass for the wrong reason.
    expect((await getAdmin('/approval-requests', mcpToken())).status).not.toBe(401);
  });

  it('CONTROL: an mcp_access token is still refused on an ordinary admin route', async () => {
    // And proves the exception is route-scoped rather than a general opening.
    expect((await getAdmin('/workspaces', mcpToken())).status).toBe(401);
  });

  it('CONTROL: a pcp_admin token gets past authentication', async () => {
    expect((await getAdmin('/workspaces', adminToken())).status).not.toBe(401);
  });

  it('the browser pairing-code mint is behind admin auth', async () => {
    // It is registered after `router.use(adminAuthMiddleware)`. Express
    // applies middleware in registration order, so "after" is the whole
    // guarantee — and a route moved above that line would silently become
    // unauthenticated.
    const res = await fetch(`${baseUrl}/api/admin/browser-companion/pairing-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 'installation-abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a browser_client token on the pairing-code mint', async () => {
    const res = await fetch(`${baseUrl}/api/admin/browser-companion/pairing-code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${browserToken()}`,
      },
      body: JSON.stringify({ installationId: 'installation-abc' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

describe('bearer-verification census', () => {
  /**
   * Every place in the package that turns a bearer token into a user.
   *
   * A new entry here means a new authenticated surface, and whoever adds it
   * has to decide — visibly, in this diff — whether a `browser_client` token
   * may pass it. Without this the claim "a browser token reaches nothing else"
   * would rest on a grep someone ran once.
   */
  const EXPECTED_CALL_SITES = [
    // The two verifier definitions. They belong here: a change to either is a
    // change to what every door downstream accepts.
    'auth/browser-client-tokens.ts',
    'auth/ink-tokens.ts',
    // Door 1 and its consumers.
    'mcp/auth/ink-auth-provider.ts',
    'mcp/server.ts',
    'routes/alerts.ts',
    'routes/hook-lifecycle.ts',
    'routes/sessions.ts',
    // Door 2.
    'routes/admin.ts',
    // Door 3.
    'routes/chat-auth.ts',
    // The companion router itself.
    'routes/browser-companion.ts',
  ].sort();

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(full, out);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has not grown a new authenticated surface', () => {
    const srcRoot = join(__dirname, '..');
    // `verifyAccessToken(` also matches its own definition in the provider,
    // which is correct: that file is a call site's worth of decision-making.
    const pattern =
      /(?:^|[^A-Za-z])(?:verifyAccessToken|verifyInkAccessToken|verifyBrowserClientToken)\s*\(|auth\.getUser\s*\(/;

    const found = walk(srcRoot)
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          // Skip comment lines: a prose mention of the function name is not a
          // call site, and counting one would make this census cry wolf.
          .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
          .some((line) => pattern.test(line))
      )
      .map((file) => file.slice(srcRoot.length + 1))
      .sort();

    expect(found).toEqual(EXPECTED_CALL_SITES);
  });
});
