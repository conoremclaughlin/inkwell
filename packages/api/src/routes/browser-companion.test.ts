/**
 * The companion router's boundary: deny-by-default routing, one credential
 * type, and a live grant check on every call.
 *
 * SCOPE, stated because it is easy to over-read these: the router and the
 * token verifier are the real production code here. The
 * `browser_companion_consume_grant` RPC is NOT executed — it is plpgsql, and
 * running it needs the migration applied and a database. The fake below is a
 * hand-port of its refusal ordering, so these tests prove the router reacts
 * correctly to each outcome, not that the SQL produces them. The SQL's own
 * coverage is an integration-tier job once the migration is applied.
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

import { createBrowserCompanionRouter, BROWSER_COMPANION_ALLOWLIST } from './browser-companion';
import { signBrowserClientToken } from '../auth/browser-client-tokens';
import { signInkAccessToken } from '../auth/ink-tokens';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID = 'installation-abc';
const INSTALLATION_SECRET = 'installation-secret-not-sent-anywhere';

interface GrantFixture {
  user_id: string;
  workspace_id: string;
  installation_id: string;
  claimed_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}

function liveGrant(overrides: Partial<GrantFixture> = {}): GrantFixture {
  return {
    user_id: USER_ID,
    workspace_id: WORKSPACE_ID,
    installation_id: INSTALLATION_ID,
    claimed_at: new Date(Date.now() - 60_000).toISOString(),
    revoked_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

let grant: GrantFixture | null = liveGrant();
let rpcThrows = false;
const rpcCalls: Array<Record<string, unknown>> = [];
/** Every table `.from()` is opened against, so a read can be asserted absent. */
const tablesRead: string[] = [];
/** Secret -> grant id, for the pairing-secret lookup. */
let knownSecretHashRow: { id: string; user_id: string; workspace_id: string } | null = null;
let claimResult: { id: string; expires_at: string } | null = null;

/**
 * Hand-port of the plpgsql refusal ordering. See the SCOPE note above.
 *
 * `p_require_live` is honoured here exactly as the function honours it: it
 * gates the revoked and expired branches and nothing else, so a test that
 * exercises the revocation exemption is measuring the same two conditions the
 * SQL drops rather than a fake that waves everything through.
 */
function consumeGrant(args: Record<string, unknown>) {
  rpcCalls.push(args);
  const requireLive = args.p_require_live !== false;

  if (!grant) {
    return {
      outcome: 'refused',
      reason_code: 'grant_not_found',
      expires_at: null,
      revoked_at: null,
    };
  }

  let reason: string | null = null;
  if (grant.claimed_at === null) reason = 'grant_unclaimed';
  else if (grant.user_id !== args.p_user_id) reason = 'user_mismatch';
  else if (grant.workspace_id !== args.p_workspace_id) reason = 'workspace_mismatch';
  else if (grant.installation_id !== args.p_installation_id) reason = 'installation_mismatch';
  else if (requireLive && grant.revoked_at !== null) reason = 'grant_revoked';
  else if (requireLive && new Date(grant.expires_at) <= new Date()) reason = 'grant_expired';

  if (reason) {
    return {
      outcome: 'refused',
      reason_code: reason,
      expires_at: grant.expires_at,
      revoked_at: grant.revoked_at,
    };
  }

  return {
    outcome: 'allowed',
    reason_code: null,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
  };
}

function makeFakeClient() {
  return {
    rpc(_name: string, args: Record<string, unknown>) {
      return {
        maybeSingle: async () => {
          if (rpcThrows) return { data: null, error: { message: 'connection refused' } };
          return { data: consumeGrant(args), error: null };
        },
      };
    },
    from(table: string) {
      tablesRead.push(table);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ['select', 'eq', 'gt', 'is', 'update', 'insert']) {
        builder[method] = chain;
      }
      builder.maybeSingle = async () => {
        if (table === 'users') return { data: { email: 'companion@example.com' }, error: null };
        if (table === 'browser_companion_grants') {
          // Serves both the pairing-secret lookup and the claim UPDATE; each
          // test sets whichever it exercises.
          return { data: claimResult ?? knownSecretHashRow, error: null };
        }
        return { data: null, error: null };
      };
      builder.single = builder.maybeSingle;
      builder.then = undefined;
      return builder;
    },
  };
}

function browserToken(overrides: Partial<Record<string, string>> = {}): string {
  return signBrowserClientToken({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    installationId: INSTALLATION_ID,
    grantId: GRANT_ID,
    ...overrides,
  });
}

describe('browser companion router', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
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
    grant = liveGrant();
    rpcThrows = false;
    rpcCalls.length = 0;
    tablesRead.length = 0;
    knownSecretHashRow = null;
    claimResult = null;
  });

  const get = (path: string, token?: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });

  // -------------------------------------------------------------------------
  describe('deny by default', () => {
    it('CONTROL: an allowlisted route with a valid token and a live grant succeeds', () => {
      // Every 403 below is meaningless without this: it proves the harness can
      // let something through, so a refusal is the allowlist and not a broken
      // fixture.
      return get('/session', browserToken()).then(async (res) => {
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ grantId: GRANT_ID });
      });
    });

    it.each(['/threads', '/commands', '/observations', '/', '/auth', '/session/extra', '/admin'])(
      'refuses unlisted path %s with a valid token',
      async (path) => {
        const res = await get(path, browserToken());
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'companion_route_not_allowed' });
      }
    );

    it('refuses a listed path presented with the wrong method', async () => {
      // /session is GET-only; the allowlist matches method AND path.
      const res = await post('/session', {}, browserToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'companion_route_not_allowed' });
    });

    it('refuses before authenticating, so an unlisted path leaks nothing about credentials', async () => {
      const res = await get('/threads');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'companion_route_not_allowed' });
    });

    it('the allowlist is four auth-gate entries and nothing else', () => {
      // This PR ships the credential boundary, not the companion API. If an
      // endpoint is added, this assertion is the review gate it has to pass
      // through.
      expect(
        BROWSER_COMPANION_ALLOWLIST.map((route) => `${route.method} ${route.path}`).sort()
      ).toEqual(['GET /session', 'POST /auth/pair-claim', 'POST /auth/revoke', 'POST /auth/token']);
    });
  });

  // -------------------------------------------------------------------------
  describe('one credential type', () => {
    it('refuses a missing bearer token', async () => {
      const res = await get('/session');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'browser_credential_required' });
    });

    it('refuses a pcp_admin token', async () => {
      const admin = signInkAccessToken(
        { type: 'pcp_admin', sub: USER_ID, email: 'admin@example.com', scope: 'admin' },
        3600
      );
      const res = await get('/session', admin);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'browser_credential_invalid' });
    });

    it('refuses an mcp_access token', async () => {
      const mcp = signInkAccessToken(
        { type: 'mcp_access', sub: USER_ID, email: 'mcp@example.com', scope: 'mcp:tools' },
        3600
      );
      const res = await get('/session', mcp);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'browser_credential_invalid' });
    });

    it('refuses an expired browser token', async () => {
      const res = await get(
        '/session',
        signBrowserClientToken(
          {
            userId: USER_ID,
            workspaceId: WORKSPACE_ID,
            installationId: INSTALLATION_ID,
            grantId: GRANT_ID,
          },
          -1
        )
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('live grant check', () => {
    it.each([
      ['revoked', { revoked_at: new Date().toISOString() }, 'grant_revoked'],
      [
        'wall-clock expired',
        { expires_at: new Date(Date.now() - 1000).toISOString() },
        'grant_expired',
      ],
      ['unclaimed', { claimed_at: null }, 'grant_unclaimed'],
      [
        'bound to another installation',
        { installation_id: 'someone-else' },
        'installation_mismatch',
      ],
      [
        'bound to another user',
        { user_id: '99999999-9999-4999-8999-999999999999' },
        'user_mismatch',
      ],
      [
        'bound to another workspace',
        { workspace_id: '88888888-8888-4888-8888-888888888888' },
        'workspace_mismatch',
      ],
    ])('refuses a grant that is %s', async (_label, overrides, reason) => {
      grant = liveGrant(overrides as Partial<GrantFixture>);
      const res = await get('/session', browserToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'grant_not_live', reason });
    });

    it('refuses when the grant row is gone', async () => {
      grant = null;
      const res = await get('/session', browserToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'grant_not_found' });
    });

    it('a revoked grant refuses a token that is still cryptographically valid', async () => {
      // The whole reason the DB check exists. The JWT below verifies fine —
      // revocation cannot reach it, because verification is local with no DB
      // read. Only the grant row can say no.
      const token = browserToken();
      expect((await get('/session', token)).status).toBe(200);

      grant = liveGrant({ revoked_at: new Date().toISOString() });
      expect((await get('/session', token)).status).toBe(403);
    });

    it('reports an unavailable checker as 503, not as a refusal', async () => {
      // Fail closed, but distinguishably: a 403 here would read back as "the
      // user revoked this" when the truth is an outage.
      rpcThrows = true;
      const res = await get('/session', browserToken());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'grant_check_unavailable' });
    });

    it('expiry needs no sweep — it is evaluated on the request itself', async () => {
      // Nothing ticks in this test. sweepExpiredLeases() runs inside
      // `if (heartbeatServiceEnabled)`, and CLAUDE.md requires
      // ENABLE_HEARTBEATS=false on isolated servers, so an expiry that rode
      // that sweep would never fire in the environment this gets tested in.
      grant = liveGrant({ expires_at: new Date(Date.now() - 1).toISOString() });
      const res = await get('/session', browserToken());
      expect(await res.json()).toMatchObject({ reason: 'grant_expired' });
    });
  });

  // -------------------------------------------------------------------------
  describe('every protected call cross-checks the stored row', () => {
    it('sends all four bindings to the checker, not just the grant id', async () => {
      await get('/session', browserToken());
      expect(rpcCalls.at(-1)).toMatchObject({
        p_grant_id: GRANT_ID,
        p_user_id: USER_ID,
        p_workspace_id: WORKSPACE_ID,
        p_installation_id: INSTALLATION_ID,
      });
    });

    it('checks on every call, not once per token', async () => {
      // The short JWT is a ceiling on a forgotten check, never a substitute
      // for the gate. Two requests with the same token means two DB reads.
      const token = browserToken();
      await get('/session', token);
      await get('/session', token);
      expect(rpcCalls).toHaveLength(2);
    });

    it('requires liveness on a reporting route', async () => {
      await get('/session', browserToken());
      expect(rpcCalls.at(-1)).toMatchObject({ p_require_live: true });
    });
  });

  // -------------------------------------------------------------------------
  describe('revocation survives the state it revokes', () => {
    it('revokes an expired grant', async () => {
      // The case that motivates the exemption. Routing /auth/revoke through
      // the same liveness gate it exists to close would leave an expired
      // grant claimed and unrevoked forever — and expiry is exactly when a
      // user reaches for Disconnect.
      grant = liveGrant({ expires_at: new Date(Date.now() - 1000).toISOString() });
      const res = await post('/auth/revoke', {}, browserToken());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ revoked: true, grantId: GRANT_ID });
    });

    it('CONTROL: the same expired grant is refused on the reporting route', async () => {
      // Without this, the test above would pass just as well against a router
      // that had stopped checking liveness anywhere.
      grant = liveGrant({ expires_at: new Date(Date.now() - 1000).toISOString() });
      const res = await get('/session', browserToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'grant_expired' });
    });

    it('is idempotent — revoking an already-revoked grant succeeds', async () => {
      grant = liveGrant({ revoked_at: new Date().toISOString() });
      expect((await post('/auth/revoke', {}, browserToken())).status).toBe(200);
    });

    it('asks the checker to skip liveness and only liveness', async () => {
      grant = liveGrant({ revoked_at: new Date().toISOString() });
      await post('/auth/revoke', {}, browserToken());
      expect(rpcCalls.at(-1)).toMatchObject({
        p_require_live: false,
        p_grant_id: GRANT_ID,
        p_user_id: USER_ID,
        p_workspace_id: WORKSPACE_ID,
        p_installation_id: INSTALLATION_ID,
      });
    });

    it.each([
      ['another user', { user_id: '99999999-9999-4999-8999-999999999999' }, 'user_mismatch'],
      [
        'another workspace',
        { workspace_id: '88888888-8888-4888-8888-888888888888' },
        'workspace_mismatch',
      ],
      ['another installation', { installation_id: 'someone-else' }, 'installation_mismatch'],
    ])(
      'still refuses a grant belonging to %s, expired or not',
      async (_label, overrides, reason) => {
        // The exemption is about liveness, never ownership. An expired grant
        // is not an unowned one.
        grant = liveGrant({
          ...(overrides as Partial<GrantFixture>),
          expires_at: new Date(Date.now() - 1000).toISOString(),
        });
        const res = await post('/auth/revoke', {}, browserToken());
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'grant_not_owned', reason });
      }
    );

    it('accepts the pairing secret when the short JWT has lapsed', async () => {
      // The JWT lives 300 s and the grant lives 12 h, so requiring a fresh
      // token to revoke would lock a user out of disconnecting for the same
      // reason they want to.
      knownSecretHashRow = { id: GRANT_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID };
      grant = liveGrant({ expires_at: new Date(Date.now() - 1000).toISOString() });
      const res = await post('/auth/revoke', {
        pairingSecret: 'ink-bc-anything',
        installationId: INSTALLATION_ID,
      });
      expect(res.status).toBe(200);
    });

    it('refuses an unknown pairing secret', async () => {
      knownSecretHashRow = null;
      const res = await post('/auth/revoke', {
        pairingSecret: 'ink-bc-wrong',
        installationId: INSTALLATION_ID,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_secret' });
    });

    it('refuses a bad bearer token rather than falling through to the body', async () => {
      // Otherwise presenting a junk JWT alongside a valid secret would
      // silently downgrade to whichever credential happened to work.
      knownSecretHashRow = { id: GRANT_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID };
      const admin = signInkAccessToken(
        { type: 'pcp_admin', sub: USER_ID, email: 'admin@example.com', scope: 'admin' },
        3600
      );
      const res = await fetch(`${baseUrl}/auth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
        body: JSON.stringify({
          pairingSecret: 'ink-bc-anything',
          installationId: INSTALLATION_ID,
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'browser_credential_invalid' });
    });

    it('refuses with no credential at all', async () => {
      const res = await post('/auth/revoke', {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'browser_credential_required' });
    });
  });

  // -------------------------------------------------------------------------
  describe('this grant confers no page authority', () => {
    it('the checker is never asked to spend an action budget', async () => {
      // The counter was dropped. Nothing in this PR admits a page action, so
      // the only traffic it could have counted is the extension's own
      // polling of /session — a budget that measures elapsed time.
      await get('/session', browserToken());
      await post('/auth/revoke', {}, browserToken());
      for (const call of rpcCalls) {
        expect(Object.keys(call)).not.toContain('p_count_action');
      }
    });

    it('CONTROL: those same calls did reach the checker', async () => {
      await get('/session', browserToken());
      expect(rpcCalls.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('pairing endpoints', () => {
    it.each([
      ['no installation or secret', { pairingCode: 'ABCD-EFGH-JKLM' }],
      ['no code or secret', { installationId: 'x' }],
      [
        'no installation secret',
        { pairingCode: 'ABCD-EFGH-JKLM', installationId: INSTALLATION_ID },
      ],
    ])('rejects a claim with %s', async (_label, body) => {
      // The third is the one that matters: a code plus an installation id is
      // what an observer of the pairing screen has, and on its own it must
      // not be enough to claim.
      claimResult = { id: GRANT_ID, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      expect((await post('/auth/pair-claim', body)).status).toBe(400);
    });

    it('returns the pairing secret once, marked for session storage', async () => {
      claimResult = { id: GRANT_ID, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      const res = await post('/auth/pair-claim', {
        pairingCode: 'abcd-efgh-jklm',
        installationId: INSTALLATION_ID,
        installationSecret: INSTALLATION_SECRET,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.grantId).toBe(GRANT_ID);
      expect(String(body.pairingSecret)).toMatch(/^ink-bc-[0-9a-f]{64}$/);
      // storage.session, not storage.local: the credential should not outlive
      // the browser session the user granted it in.
      expect(body.storage).toBe('session');
    });

    it('refuses an unknown pairing code', async () => {
      claimResult = null;
      const res = await post('/auth/pair-claim', {
        pairingCode: 'abcd-efgh-jklm',
        installationId: INSTALLATION_ID,
        installationSecret: INSTALLATION_SECRET,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_or_expired_code' });
    });

    it('mints a short-lived token from a pairing secret', async () => {
      knownSecretHashRow = { id: GRANT_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID };
      const res = await post('/auth/token', {
        pairingSecret: 'ink-bc-anything',
        installationId: INSTALLATION_ID,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.expiresIn).toBe(300);
      // No action budget is reported, because none is conferred.
      expect(Object.keys(body)).not.toContain('actionsRemaining');
    });

    it('does not read the user record to mint a token', async () => {
      // The token carries no email claim, so there is nothing to look it up
      // for. A claim nobody consumes is a value handed to the extension for
      // free.
      knownSecretHashRow = { id: GRANT_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID };
      tablesRead.length = 0;
      await post('/auth/token', {
        pairingSecret: 'ink-bc-anything',
        installationId: INSTALLATION_ID,
      });
      expect(tablesRead).not.toContain('users');
      // CONTROL: the request did reach the database.
      expect(tablesRead.length).toBeGreaterThan(0);
    });

    it('refuses an unknown pairing secret', async () => {
      knownSecretHashRow = null;
      const res = await post('/auth/token', {
        pairingSecret: 'ink-bc-wrong',
        installationId: INSTALLATION_ID,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_secret' });
    });

    it('refuses to mint a token for a revoked grant', async () => {
      knownSecretHashRow = { id: GRANT_ID, user_id: USER_ID, workspace_id: WORKSPACE_ID };
      grant = liveGrant({ revoked_at: new Date().toISOString() });
      const res = await post('/auth/token', {
        pairingSecret: 'ink-bc-anything',
        installationId: INSTALLATION_ID,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'grant_revoked' });
    });
  });

  // -------------------------------------------------------------------------
  describe('/session reports fields, not prose', () => {
    it('returns the bindings and grant state as discrete fields', async () => {
      const body = (await (await get('/session', browserToken())).json()) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({
        grantId: GRANT_ID,
        installationId: INSTALLATION_ID,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        grantExpiresAt: grant!.expires_at,
        grantRevokedAt: null,
        pageAuthority: 'none',
      });
    });

    it('states that no page authority is conferred rather than leaving it to be inferred', async () => {
      // This grant is pairing and installation authority. A reader who took
      // "/session returned 200" for permission to read the page would be
      // wrong, so the response says so in a field.
      const body = (await (await get('/session', browserToken())).json()) as Record<
        string,
        unknown
      >;
      expect(body.pageAuthority).toBe('none');
      expect(Object.keys(body)).not.toContain('scope');
      expect(Object.keys(body)).not.toContain('permissions');
    });
  });
});
