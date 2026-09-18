/**
 * Tests for auth/tokens.ts — PKCE, token storage, JWT decode, expiry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generatePkce,
  decodeJwtPayload,
  isTokenExpired,
  isJwtProvablyExpired,
  getValidAccessToken,
  getValidDelegatedAccessToken,
  loadAuth,
  saveAuth,
  loadDelegatedAuth,
  saveDelegatedAuth,
  clearDelegatedAuth,
  clearAuth,
  clearAuthIfUnchanged,
  saveAuthIfUnchanged,
  updateConfigEmail,
  type StoredAuth,
} from './tokens.js';

// ============================================================================
// PKCE
// ============================================================================

describe('generatePkce', () => {
  it('generates code_verifier of 43+ characters (base64url)', () => {
    const { codeVerifier } = generatePkce();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    // base64url: only alphanumeric, -, _
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates code_challenge that matches SHA-256 of code_verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('generates unique values each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

// ============================================================================
// JWT Decode
// ============================================================================

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'fakesig';
  return `${header}.${body}.${signature}`;
}

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const token = makeJwt({
      type: 'mcp_access',
      sub: 'user-123',
      email: 'wren@example.com',
      scope: 'mcp:tools',
      exp: 9999999999,
      iat: 1000000000,
    });

    const payload = decodeJwtPayload(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-123');
    expect(payload!.email).toBe('wren@example.com');
    expect(payload!.type).toBe('mcp_access');
    expect(payload!.scope).toBe('mcp:tools');
  });

  it('returns null for invalid tokens', () => {
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('not.a.jwt.at.all')).toBeNull();
    expect(decodeJwtPayload('one')).toBeNull();
    expect(decodeJwtPayload('two.parts')).toBeNull();
  });

  it('extracts optional sbSlug and identityId', () => {
    const token = makeJwt({
      type: 'mcp_access',
      sub: 'user-123',
      email: 'test@example.com',
      scope: 'mcp:tools',
      sbSlug: 'wren',
      identityId: 'id-456',
      exp: 9999999999,
      iat: 1000000000,
    });

    const payload = decodeJwtPayload(token);
    expect(payload!.sbSlug).toBe('wren');
    expect(payload!.identityId).toBe('id-456');
  });
});

// ============================================================================
// Token Expiry
// ============================================================================

describe('isTokenExpired', () => {
  const freshAuth: StoredAuth = {
    access_token: 'test',
    refresh_token: 'test-rt',
    expires_in: 30 * 24 * 60 * 60, // 30 days in seconds
    scope: 'mcp:tools',
    issued_at: Date.now(),
  };

  it('returns false for fresh tokens', () => {
    expect(isTokenExpired(freshAuth)).toBe(false);
  });

  it('returns true for expired tokens', () => {
    const expired: StoredAuth = {
      ...freshAuth,
      issued_at: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago
    };
    expect(isTokenExpired(expired)).toBe(true);
  });

  it('respects buffer seconds', () => {
    // Token expires in exactly 60 seconds
    const almostExpired: StoredAuth = {
      ...freshAuth,
      expires_in: 60,
      issued_at: Date.now(),
    };

    // With 300s buffer (default): should be "expired" since 60 < 300
    expect(isTokenExpired(almostExpired)).toBe(true);

    // With 0s buffer: should NOT be expired
    expect(isTokenExpired(almostExpired, 0)).toBe(false);

    // With 30s buffer: should NOT be expired since 60 > 30
    expect(isTokenExpired(almostExpired, 30)).toBe(false);
  });
});

// ============================================================================
// Token Storage (uses temp HOME)
// ============================================================================

describe('loadAuth / saveAuth / clearAuth', () => {
  let origHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-auth-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    // Override homedir() by setting HOME env var
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const testAuth: StoredAuth = {
    access_token: 'at-123',
    refresh_token: 'rt-456',
    expires_in: 2592000,
    scope: 'mcp:tools',
    issued_at: Date.now(),
  };

  it('returns null when no file exists', () => {
    expect(loadAuth()).toBeNull();
  });

  it('round-trips auth data', () => {
    saveAuth(testAuth);
    const loaded = loadAuth();
    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe('at-123');
    expect(loaded!.refresh_token).toBe('rt-456');
    expect(loaded!.expires_in).toBe(2592000);
  });

  it('sets file permissions to 600', () => {
    saveAuth(testAuth);
    const authPath = join(tempHome, '.ink', 'auth.json');
    const stats = statSync(authPath);
    // 0o600 = owner read/write, no group/other
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('clears auth file', () => {
    saveAuth(testAuth);
    expect(loadAuth()).not.toBeNull();
    clearAuth();
    expect(loadAuth()).toBeNull();
  });

  it('clearAuth is safe when no file exists', () => {
    expect(() => clearAuth()).not.toThrow();
  });
});

describe('delegated auth storage', () => {
  let origHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `pcp-delegated-auth-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('round-trips delegated token data', () => {
    saveDelegatedAuth('wren', {
      access_token: 'delegated-token',
      expires_in: 3600,
      issued_at: Date.now(),
      agent_id: 'wren',
      sb_id: 'identity-123',
      scope: 'mcp:tools',
    });

    const loaded = loadDelegatedAuth('wren');
    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe('delegated-token');
    expect(loaded!.agent_id).toBe('wren');
    expect(loaded!.sb_id).toBe('identity-123');
  });

  it('returns delegated token only when not expired', () => {
    saveDelegatedAuth('lumen', {
      access_token: 'fresh-delegated-token',
      expires_in: 3600,
      issued_at: Date.now(),
      agent_id: 'lumen',
    });
    expect(getValidDelegatedAccessToken('lumen')).toBe('fresh-delegated-token');

    saveDelegatedAuth('lumen', {
      access_token: 'stale-delegated-token',
      expires_in: 60,
      issued_at: Date.now() - 2 * 60 * 1000,
      agent_id: 'lumen',
    });
    expect(getValidDelegatedAccessToken('lumen')).toBeNull();
  });

  it('clears delegated auth safely', () => {
    saveDelegatedAuth('aster', {
      access_token: 'token',
      expires_in: 3600,
      issued_at: Date.now(),
      agent_id: 'aster',
    });
    expect(loadDelegatedAuth('aster')).not.toBeNull();
    clearDelegatedAuth('aster');
    expect(loadDelegatedAuth('aster')).toBeNull();
    expect(() => clearDelegatedAuth('aster')).not.toThrow();
  });
});

describe('getValidAccessToken', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let origEnvToken: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnvToken = process.env.INK_ACCESS_TOKEN;
    tempHome = join(tmpdir(), `ink-token-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnvToken === undefined) delete process.env.INK_ACCESS_TOKEN;
    else process.env.INK_ACCESS_TOKEN = origEnvToken;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('prefers INK_ACCESS_TOKEN from environment when present', async () => {
    process.env.INK_ACCESS_TOKEN = 'env-token';
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe('env-token');
  });

  it('returns env token even when auth.json is absent', async () => {
    process.env.INK_ACCESS_TOKEN = 'env-only-token';
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe('env-only-token');
  });

  it('can skip env token lookup when allowEnvToken=false', async () => {
    process.env.INK_ACCESS_TOKEN = 'env-only-token';
    const token = await getValidAccessToken('http://localhost:3001', { allowEnvToken: false });
    expect(token).toBeNull();
  });

  // Regression: long-lived agent sessions inherit INK_ACCESS_TOKEN injected at
  // session start. Once it expires, spawned CLI commands (ink wait, etc.) 401'd
  // forever — even after a fresh `ink login` — because the stale env token
  // short-circuited the auth.json path.
  it('skips a provably-expired env JWT and falls back to auth.json', async () => {
    process.env.INK_ACCESS_TOKEN = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    saveAuth({
      access_token: 'fresh-login-token',
      refresh_token: 'refresh',
      expires_in: 3600,
      scope: 'full',
      issued_at: Date.now(),
    });

    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe('fresh-login-token');
  });

  it('returns null for an expired env JWT when auth.json is absent', async () => {
    process.env.INK_ACCESS_TOKEN = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBeNull();
  });

  it('still uses an env JWT with a future exp', async () => {
    const envJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    process.env.INK_ACCESS_TOKEN = envJwt;
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe(envJwt);
  });
});

// ============================================================================
// Concurrent rotation of the shared credential file
//
// ~/.ink/auth.json is shared by every CLI process on the machine, and the grant
// rotates on refresh. Two processes reading the same secret is ordinary, not
// exotic: a REPL and an `ink wait` running beside it is enough. Before these,
// the loser of that race deleted the winner's freshly-written credential and
// forced a re-login on a session whose grant was alive.
// ============================================================================

describe('getValidAccessToken — a lost rotation race', () => {
  let origHome: string | undefined;
  let origEnvToken: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let tempHome: string;
  let authPath: string;

  const staleAuth = (refreshToken: string): StoredAuth => ({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now() - 2 * 3600 * 1000, // long past the refresh buffer
  });

  const freshAuth = (refreshToken: string): StoredAuth => ({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now(),
  });

  /**
   * A server that refuses everything TERMINALLY — the shape RFC 6749 §5.2 gives
   * a revoked or expired grant, and the only one that licenses deleting the
   * credential. The status is part of that shape: a refusal carrying no status
   * is a proxy or a socket, not the authorization server.
   */
  const refuseEveryExchange = (onCall?: () => void) => {
    globalThis.fetch = (async () => {
      onCall?.();
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  };

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnvToken = process.env.INK_ACCESS_TOKEN;
    origFetch = globalThis.fetch;
    delete process.env.INK_ACCESS_TOKEN;
    tempHome = join(tmpdir(), `ink-rotation-race-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnvToken === undefined) delete process.env.INK_ACCESS_TOKEN;
    else process.env.INK_ACCESS_TOKEN = origEnvToken;
    globalThis.fetch = origFetch;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('does not delete the credential another process just rotated in', async () => {
    saveAuth(staleAuth('refresh-A'));

    // The winner's rotation lands while our exchange is in flight: by the time
    // the server refuses OUR secret, the file already holds the successor.
    refuseEveryExchange(() => saveAuth(freshAuth('refresh-B')));

    const token = await getValidAccessToken('http://localhost:3001');

    expect(existsSync(authPath)).toBe(true);
    expect(loadAuth()!.refresh_token).toBe('refresh-B');
    // And the caller is served from the winner's result rather than sent to
    // re-login while a working credential sits on disk.
    expect(token).toBe('access-for-refresh-B');
  });

  it('still clears the credential when the grant itself is dead', async () => {
    // The control. If a refusal stopped clearing, a revoked or expired grant
    // would sit in the file forever and every command would 401 in silence.
    saveAuth(staleAuth('refresh-A'));
    refuseEveryExchange();

    const token = await getValidAccessToken('http://localhost:3001');

    expect(token).toBeNull();
    expect(existsSync(authPath)).toBe(false);
  });

  it('leaves the file alone when the successor it re-read fails too', async () => {
    // We lost the race AND the winner's secret does not work either. It is
    // still not ours to delete: a third process may be mid-rotation with it.
    saveAuth(staleAuth('refresh-A'));
    refuseEveryExchange(() => {
      if (loadAuth()!.refresh_token === 'refresh-A') saveAuth(staleAuth('refresh-B'));
    });

    const token = await getValidAccessToken('http://localhost:3001');

    expect(token).toBeNull();
    expect(existsSync(authPath)).toBe(true);
    expect(loadAuth()!.refresh_token).toBe('refresh-B');
  });
});

describe('clearAuthIfUnchanged', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let authPath: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-clear-if-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const auth = (refreshToken: string): StoredAuth => ({
    access_token: 'access',
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now(),
  });

  it('removes the file when it still holds the caller has', () => {
    saveAuth(auth('refresh-A'));
    expect(clearAuthIfUnchanged('refresh-A')).toBe(true);
    expect(existsSync(authPath)).toBe(false);
  });

  it('keeps a file that has since been rotated by someone else', () => {
    saveAuth(auth('refresh-B'));
    expect(clearAuthIfUnchanged('refresh-A')).toBe(false);
    expect(existsSync(authPath)).toBe(true);
    expect(loadAuth()!.refresh_token).toBe('refresh-B');
  });

  it('reports false rather than throwing when there is no file', () => {
    expect(clearAuthIfUnchanged('refresh-A')).toBe(false);
  });
});

describe('saveAuth — atomicity', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let authPath: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-atomic-save-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const auth = (token: string): StoredAuth => ({
    access_token: token,
    refresh_token: 'refresh',
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now(),
  });

  it('replaces the file rather than rewriting it in place', () => {
    // The inode is the observable difference, and it is the guarantee itself: a
    // truncate-and-write keeps the entry and exposes a half-written file to any
    // concurrent reader, which loadAuth answers as "not logged in". A rename
    // swaps the directory entry, so a reader sees the whole old file or the
    // whole new one.
    saveAuth(auth('first'));
    const firstInode = statSync(authPath).ino;

    saveAuth(auth('second'));
    const secondInode = statSync(authPath).ino;

    expect(secondInode).not.toBe(firstInode);
    expect(loadAuth()!.access_token).toBe('second');
  });

  it('leaves no temp files behind', () => {
    saveAuth(auth('first'));
    saveAuth(auth('second'));
    const leftovers = readdirSync(join(tempHome, '.ink')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('keeps the credential file owner-only', () => {
    saveAuth(auth('first'));
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });
});

describe('isJwtProvablyExpired', () => {
  it('returns true for a decodable JWT with exp in the past', () => {
    expect(isJwtProvablyExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }))).toBe(true);
  });

  it('returns true when exp is within the buffer window', () => {
    expect(isJwtProvablyExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }), 60)).toBe(
      true
    );
  });

  it('returns false for a JWT with a future exp', () => {
    expect(isJwtProvablyExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }))).toBe(
      false
    );
  });

  it('returns false for opaque (non-JWT) tokens', () => {
    expect(isJwtProvablyExpired('opaque-token-string')).toBe(false);
  });

  it('returns false for a JWT without an exp claim', () => {
    expect(isJwtProvablyExpired(makeJwt({ sub: 'user-1' }))).toBe(false);
  });
});

// ============================================================================
// Config Email Update
// ============================================================================

describe('updateConfigEmail', () => {
  let origHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-config-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates config.json with email', () => {
    updateConfigEmail('test@example.com', 'user-123');
    const configPath = join(tempHome, '.ink', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.email).toBe('test@example.com');
    expect(config.userId).toBe('user-123');
  });

  it('preserves existing config fields', () => {
    const configDir = join(tempHome, '.ink');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ email: 'old@example.com', agentMapping: { 'claude-code': 'wren' } })
    );

    updateConfigEmail('new@example.com');
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
    expect(config.email).toBe('new@example.com');
    expect(config.agentMapping).toEqual({ 'claude-code': 'wren' });
  });
});

// ============================================================================
// What a failed exchange is allowed to mean
//
// One `catch` used to answer every way of not getting a token, and it answered
// with the most destructive reading available: delete the credential. Almost
// none of those failures say anything about the grant. A restarted server, a
// proxy's HTML error page, a 30-second timeout on a train — each of them logged
// the machine out of a session that was alive the whole time.
// ============================================================================

describe('getValidAccessToken — what a failed exchange is allowed to conclude', () => {
  let origHome: string | undefined;
  let origEnvToken: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let tempHome: string;
  let authPath: string;

  const staleAuth = (refreshToken: string): StoredAuth => ({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now() - 2 * 3600 * 1000,
  });

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnvToken = process.env.INK_ACCESS_TOKEN;
    origFetch = globalThis.fetch;
    delete process.env.INK_ACCESS_TOKEN;
    tempHome = join(tmpdir(), `ink-failure-kind-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
    saveAuth(staleAuth('refresh-A'));
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnvToken === undefined) delete process.env.INK_ACCESS_TOKEN;
    else process.env.INK_ACCESS_TOKEN = origEnvToken;
    globalThis.fetch = origFetch;
    rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Every one of these is a failure the CLI can meet on an ordinary day, and
   * in none of them has the authorization server said the grant is invalid.
   * The file must survive all of them.
   */
  const nonTerminalFailures: Array<{ name: string; fetch: typeof globalThis.fetch }> = [
    {
      name: 'a request that never completed (timeout, DNS, reset socket)',
      fetch: (async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      }) as typeof globalThis.fetch,
    },
    {
      name: 'the server being restarted (503)',
      fetch: (async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({ error: 'temporarily_unavailable' }),
        }) as unknown as Response) as typeof globalThis.fetch,
    },
    {
      name: 'a proxy answering with HTML that will not parse',
      fetch: (async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        }) as unknown as Response) as typeof globalThis.fetch,
    },
    {
      name: 'a 500 that happens to carry an OAuth-shaped body',
      fetch: (async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'server_error' }),
        }) as unknown as Response) as typeof globalThis.fetch,
    },
    {
      name: 'the grant being alive but this secret superseded (409)',
      fetch: (async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: 'superseded_grant' }),
        }) as unknown as Response) as typeof globalThis.fetch,
    },
    {
      name: 'a refusal whose code this CLI has never heard of',
      fetch: (async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ error: 'some_future_policy_refusal' }),
        }) as unknown as Response) as typeof globalThis.fetch,
    },
  ];

  for (const failure of nonTerminalFailures) {
    it(`keeps the credential through ${failure.name}`, async () => {
      globalThis.fetch = failure.fetch;

      const token = await getValidAccessToken('http://localhost:3001');

      expect(token).toBeNull();
      expect(existsSync(authPath)).toBe(true);
      expect(loadAuth()!.refresh_token).toBe('refresh-A');
    });
  }

  it('deletes the credential when the server says the grant is invalid', async () => {
    // The control. Without it, "never delete" would pass every test above and
    // leave a genuinely revoked credential on disk, 401ing in silence forever.
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Invalid refresh token' }),
      }) as unknown as Response) as typeof globalThis.fetch;

    const token = await getValidAccessToken('http://localhost:3001');

    expect(token).toBeNull();
    expect(existsSync(authPath)).toBe(false);
  });

  it('deletes the credential when the client is no longer authorized', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_client' }),
      }) as unknown as Response) as typeof globalThis.fetch;

    await getValidAccessToken('http://localhost:3001');

    expect(existsSync(authPath)).toBe(false);
  });
});

// ============================================================================
// A successful exchange is not automatically a write
//
// An exchange takes as long as the network does, and the file can change
// completely while one is in flight. Storing the result unconditionally on the
// way back rolls the machine backwards onto a secret the server has already
// replaced — or undoes a logout that happened while we were waiting.
// ============================================================================

describe('getValidAccessToken — storing a result that arrived late', () => {
  let origHome: string | undefined;
  let origEnvToken: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let tempHome: string;
  let authPath: string;

  const authFor = (refreshToken: string, ageMs: number): StoredAuth => ({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now() - ageMs,
  });

  /** An exchange that succeeds, with something else happening while it runs. */
  const succeedAfter = (whileInFlight: () => void, granted: string) => {
    globalThis.fetch = (async () => {
      whileInFlight();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `access-for-${granted}`,
          refresh_token: granted,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'full',
        }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  };

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnvToken = process.env.INK_ACCESS_TOKEN;
    origFetch = globalThis.fetch;
    delete process.env.INK_ACCESS_TOKEN;
    tempHome = join(tmpdir(), `ink-late-write-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnvToken === undefined) delete process.env.INK_ACCESS_TOKEN;
    else process.env.INK_ACCESS_TOKEN = origEnvToken;
    globalThis.fetch = origFetch;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('does not roll the file back to its own result when a later generation has landed', async () => {
    // We present A and the server grants B. While we wait, the process that
    // owns the file has already gone A -> B -> C. Writing B now hands the next
    // command a secret the server retired, and the machine is logged out by a
    // response that SUCCEEDED.
    saveAuth(authFor('refresh-A', 2 * 3600 * 1000));
    succeedAfter(() => saveAuth(authFor('refresh-C', 0)), 'refresh-B');

    const token = await getValidAccessToken('http://localhost:3001');

    expect(loadAuth()!.refresh_token).toBe('refresh-C');
    // Our own exchange did succeed, so this command is served rather than failed.
    expect(token).toBe('access-for-refresh-B');
  });

  it('does not recreate the credential when a logout landed while it was in flight', async () => {
    saveAuth(authFor('refresh-A', 2 * 3600 * 1000));
    succeedAfter(() => clearAuth(), 'refresh-B');

    const token = await getValidAccessToken('http://localhost:3001');

    expect(existsSync(authPath)).toBe(false);
    // And the command does not get to act on a session the user just ended.
    expect(token).toBeNull();
  });

  it('stores the result when the file is still the one it rotated', async () => {
    // The control: if the comparison refused everything, every refresh would
    // succeed once and then never persist, and the next command would rotate
    // from a dead secret.
    saveAuth(authFor('refresh-A', 2 * 3600 * 1000));
    succeedAfter(() => {}, 'refresh-B');

    const token = await getValidAccessToken('http://localhost:3001');

    expect(loadAuth()!.refresh_token).toBe('refresh-B');
    expect(token).toBe('access-for-refresh-B');
  });
});

// ============================================================================
// The generation check is a decision, and decisions need exclusion
//
// Writing atomically is not deciding atomically. Every interesting operation on
// ~/.ink/auth.json is read-compare-write, and temp-file+rename does nothing at
// all for the gap between the read and the write — a rotation landing in that
// gap is precisely the case being guarded against, and it lands unseen.
// ============================================================================

describe('credential file lock', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let authPath: string;
  let lockPath: string;

  const authFor = (refreshToken: string): StoredAuth => ({
    access_token: `access-for-${refreshToken}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'full',
    issued_at: Date.now(),
  });

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-lock-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
    lockPath = `${authPath}.lock`;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('deletes nothing while another process holds the lock', () => {
    saveAuth(authFor('refresh-A'));
    mkdirSync(lockPath); // another process is mid-decision about this file

    expect(clearAuthIfUnchanged('refresh-A', { lockWaitMs: 30 })).toBe(false);
    expect(existsSync(authPath)).toBe(true);
  });

  it('writes nothing while another process holds the lock', () => {
    saveAuth(authFor('refresh-A'));
    mkdirSync(lockPath);

    expect(saveAuthIfUnchanged('refresh-A', authFor('refresh-B'), { lockWaitMs: 30 })).toBe(
      'contended'
    );
    expect(loadAuth()!.refresh_token).toBe('refresh-A');
  });

  it('does the work once the lock is free', () => {
    // The control for both of the above: a lock that refused unconditionally
    // would pass them and break every refresh on the machine.
    saveAuth(authFor('refresh-A'));

    expect(saveAuthIfUnchanged('refresh-A', authFor('refresh-B'), { lockWaitMs: 30 })).toBe(
      'saved'
    );
    expect(loadAuth()!.refresh_token).toBe('refresh-B');
    expect(clearAuthIfUnchanged('refresh-B', { lockWaitMs: 30 })).toBe(true);
    expect(existsSync(authPath)).toBe(false);
  });

  it('reports a file that moved on rather than overwriting it', () => {
    saveAuth(authFor('refresh-C'));

    expect(saveAuthIfUnchanged('refresh-A', authFor('refresh-B'), { lockWaitMs: 30 })).toBe(
      'superseded'
    );
    expect(loadAuth()!.refresh_token).toBe('refresh-C');
  });

  it('reports an absent file rather than creating one', () => {
    expect(saveAuthIfUnchanged('refresh-A', authFor('refresh-B'), { lockWaitMs: 30 })).toBe(
      'absent'
    );
    expect(existsSync(authPath)).toBe(false);
  });

  it('breaks a lock left behind by a process that died holding it', () => {
    // Otherwise one crash makes the machine permanently unable to rotate.
    saveAuth(authFor('refresh-A'));
    mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    expect(clearAuthIfUnchanged('refresh-A', { lockWaitMs: 30 })).toBe(true);
    expect(existsSync(authPath)).toBe(false);
  });

  it('lets an explicit login through even against a held lock', () => {
    // A person typing `ink login` decides what this machine's credential is.
    // Silently doing nothing because a background command held a lock would be
    // a worse failure than the one the lock prevents.
    mkdirSync(lockPath);

    saveAuth(authFor('refresh-NEW'), { lockWaitMs: 30 });

    expect(loadAuth()!.refresh_token).toBe('refresh-NEW');
  });

  it('releases the lock after a decision, including a refused one', () => {
    saveAuth(authFor('refresh-A'));

    clearAuthIfUnchanged('refresh-WRONG', { lockWaitMs: 30 });

    expect(existsSync(lockPath)).toBe(false);
  });
});
