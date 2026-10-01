/**
 * What the CORS and CSRF middleware actually do to a companion request, as
 * opposed to what the extension design assumes they do.
 *
 * The assumption worth checking is a specific one. `createBrowserCors()`
 * allowlists three localhost origins; a side panel page or content script
 * fetching the API has origin `chrome-extension://<id>`, which is not one of
 * them. Routing companion calls through the extension service worker with
 * `host_permissions` is the stated fix, and Chrome does exempt that context
 * from CORS enforcement — but a client-side exemption cannot undo a
 * *server-side* rejection. If this middleware refused unknown origins, the
 * service worker would change nothing and the design would be wrong.
 *
 * So the thing to establish is which of the two it is, and the answer is
 * visible only in the response: a status, and the presence or absence of one
 * header. That is what is measured here.
 *
 * SCOPE: this exercises the real `createBrowserCors()` and the real
 * `requireCookieCsrfHeader` in the order `mcp/server.ts` mounts them
 * (createBrowserCors → express.json → requireCookieCsrfHeader → router). It
 * does not exercise Chrome. What a browser then does with these headers is
 * the browser's rule, not this server's, and is cited rather than claimed.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createBrowserCompanionRouter } from './browser-companion';
import { signBrowserClientToken } from '../auth/browser-client-tokens';
import { createBrowserCors, requireCookieCsrfHeader } from '../security/cookie-csrf';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID = 'installation-abc';

/** A plausible extension id: 32 lowercase letters, as Chrome mints them. */
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';
/** One of the three origins createBrowserCors() does allow — the control. */
const DASHBOARD_ORIGIN = 'http://localhost:3002';

let rpcCalls = 0;

function makeFakeClient() {
  return {
    rpc() {
      return {
        maybeSingle: async () => {
          rpcCalls += 1;
          return {
            data: {
              outcome: 'allowed',
              reason_code: null,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              revoked_at: null,
            },
            error: null,
          };
        },
      };
    },
    from() {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ['select', 'eq', 'gt', 'is', 'update', 'insert']) {
        builder[method] = chain;
      }
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.single = builder.maybeSingle;
      return builder;
    },
  };
}

function token(): string {
  return signBrowserClientToken({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    installationId: INSTALLATION_ID,
    grantId: GRANT_ID,
  });
}

describe('companion requests under the real CORS and CSRF middleware', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    // Same order as mcp/server.ts.
    app.use(createBrowserCors());
    app.use(express.json());
    app.use(requireCookieCsrfHeader);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow fake, see SCOPE
    app.use('/api/browser-companion', createBrowserCompanionRouter(makeFakeClient() as any));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}/api/browser-companion`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    rpcCalls = 0;
  });

  describe('an extension origin is not rejected by the server — it is not vouched for', () => {
    it('serves the request and withholds the allow-origin header', async () => {
      const res = await fetch(`${baseUrl}/session`, {
        headers: { authorization: `Bearer ${token()}`, origin: EXTENSION_ORIGIN },
      });

      // The measurement. The server does not refuse on Origin: the handler
      // runs and answers. What it withholds is the header that would tell a
      // *browser* the response may be read cross-origin.
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(rpcCalls).toBe(1);
    });

    it('CONTROL: an allowlisted origin gets the header, so its absence above is the policy', async () => {
      const res = await fetch(`${baseUrl}/session`, {
        headers: { authorization: `Bearer ${token()}`, origin: DASHBOARD_ORIGIN },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD_ORIGIN);
    });

    it('answers a preflight from an extension origin without vouching for it', async () => {
      const res = await fetch(`${baseUrl}/auth/revoke`, {
        method: 'OPTIONS',
        headers: {
          origin: EXTENSION_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      // Not an error status. The preflight is answered; what it does not carry
      // is permission, and that distinction is the whole finding.
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('CONTROL: the same preflight from the dashboard origin IS vouched for', async () => {
      const res = await fetch(`${baseUrl}/auth/revoke`, {
        method: 'OPTIONS',
        headers: {
          origin: DASHBOARD_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD_ORIGIN);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });
  });

  describe('what this does and does not license', () => {
    it('a page-context fetch is refused by the browser, not by us — so nothing here proves it works', () => {
      // Deliberately an assertion about the code, not about Chrome. A side
      // panel page or content script sending Origin: chrome-extension://… gets
      // a 200 with no allow-origin header (measured above), and the browser
      // then withholds the response from the page. That last step is the
      // browser's rule and is not exercised by any test in this repo.
      //
      // The consequence for the extension: companion calls go through the
      // service worker with an exact host permission and credentials omitted.
      // Widening the allowlist to reflect chrome-extension:// origins is the
      // shortcut that would make a page-context fetch work, and it is the one
      // createBrowserCors()'s own comment warns against — the policy is
      // coupled to the non-simple-header CSRF defense, and reflecting a
      // credentialed origin breaks it.
      const source = createBrowserCors.toString();
      expect(source).toContain('localhost:3001');
      expect(source).not.toContain('chrome-extension');
    });
  });

  describe('the cookie CSRF guard does not fire on bearer-only calls', () => {
    it('lets a bearer POST with no cookie through', async () => {
      const res = await fetch(`${baseUrl}/auth/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).not.toBe(403);
      expect(rpcCalls).toBe(1);
    });

    it('CONTROL: the guard is live — the same POST with a cookie and no CSRF header is refused', async () => {
      // Without this, the test above would pass against a build where the
      // guard had been removed entirely.
      const res = await fetch(`${baseUrl}/auth/revoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token()}`,
          'content-type': 'application/json',
          cookie: 'ink_session=whatever',
        },
        body: '{}',
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'Cookie-authenticated mutations require CSRF protection',
      });
      // It never reached the grant check.
      expect(rpcCalls).toBe(0);
    });
  });
});
