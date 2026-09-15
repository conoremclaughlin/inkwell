/**
 * The desktop Google login flow against a fake Google.
 *
 * The consent request is pinned against the SHARED scope list (the same list
 * the server requires), the redirect is accepted only for the running flow's
 * state, and the stored file is owner-only and round-trips through the shared
 * parser the server uses.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTH_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  parseDesktopGoogleCredential,
} from '@inklabs/shared';
import {
  checkDesktopCredential,
  listDesktopCredentials,
  loadDesktopOAuthClient,
  removeDesktopCredential,
  runDesktopGoogleLogin,
  writeDesktopCredential,
} from './google-desktop-login.js';

const cleanup: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-google-login-'));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop() as string, { recursive: true, force: true });
});

const CLIENT = { clientId: 'desk-client', clientSecret: 'desk-secret' };

function fakeGoogle(opts: { refreshToken?: string | null; email?: string; scope?: string } = {}) {
  const calls: Array<{
    url: string;
    body: string | undefined;
    headers: Record<string, string> | undefined;
  }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body as string | undefined,
      headers: init?.headers as Record<string, string>,
    });
    if (url === GOOGLE_TOKEN_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'at-1',
          refresh_token: opts.refreshToken === undefined ? 'rt-1' : opts.refreshToken,
          scope: opts.scope ?? GOOGLE_OAUTH_SCOPES.join(' '),
        }),
      };
    }
    if (url === GOOGLE_USERINFO_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ email: opts.email ?? 'Me@Example.com' }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** What a real browser does after the user clicks Allow: follow Google's redirect back to the loopback. */
function approvingBrowser(mutate?: (redirect: URL) => void) {
  const consentUrls: URL[] = [];
  return {
    consentUrls,
    openUrl: (url: string) => {
      const consent = new URL(url);
      consentUrls.push(consent);
      const redirect = new URL(consent.searchParams.get('redirect_uri') as string);
      redirect.searchParams.set('code', 'the-code');
      redirect.searchParams.set('state', consent.searchParams.get('state') as string);
      mutate?.(redirect);
      void fetch(redirect).catch(() => {});
    },
  };
}

describe('runDesktopGoogleLogin', () => {
  it('asks for exactly the shared scopes with offline consent, exchanges with PKCE, and returns the bound credential', async () => {
    const google = fakeGoogle();
    const browser = approvingBrowser();
    const now = Date.parse('2026-09-08T18:00:00.000Z');

    const { credential, requestedScopes } = await runDesktopGoogleLogin({
      client: CLIENT,
      browser: true,
      deps: {
        fetchImpl: google.fetchImpl,
        openUrl: browser.openUrl,
        now: () => now,
        timeoutMs: 5000,
      },
    });

    const consent = browser.consentUrls[0];
    expect(consent.origin + consent.pathname).toBe(GOOGLE_AUTH_URL);
    expect(consent.searchParams.get('client_id')).toBe('desk-client');
    expect(consent.searchParams.get('scope')).toBe(GOOGLE_OAUTH_SCOPES.join(' '));
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(consent.searchParams.get('prompt')).toBe('consent');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    );
    expect(requestedScopes).toEqual([...GOOGLE_OAUTH_SCOPES]);

    const exchange = new URLSearchParams(google.calls[0].body);
    expect(google.calls[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('client_secret')).toBe('desk-secret');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('redirect_uri')).toBe(consent.searchParams.get('redirect_uri'));
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(google.calls[1].headers?.Authorization).toBe('Bearer at-1');

    expect(credential).toEqual({
      type: 'authorized_user',
      client_id: 'desk-client',
      client_secret: 'desk-secret',
      refresh_token: 'rt-1',
      email: 'me@example.com',
      scopes: [...GOOGLE_OAUTH_SCOPES],
      obtained_at: '2026-09-08T18:00:00.000Z',
      source: 'ink google login',
    });
  });

  it('refuses a redirect carrying a different state', async () => {
    const google = fakeGoogle();
    const browser = approvingBrowser((redirect) =>
      redirect.searchParams.set('state', 'someone-elses')
    );

    await expect(
      runDesktopGoogleLogin({
        client: CLIENT,
        browser: true,
        deps: { fetchImpl: google.fetchImpl, openUrl: browser.openUrl, timeoutMs: 5000 },
      })
    ).rejects.toThrow(/State mismatch/);
    expect(google.calls).toEqual([]);
  });

  it("surfaces Google's own refusal from the redirect", async () => {
    const google = fakeGoogle();
    const browser = approvingBrowser((redirect) => {
      redirect.searchParams.delete('code');
      redirect.searchParams.set('error', 'access_denied');
    });

    await expect(
      runDesktopGoogleLogin({
        client: CLIENT,
        browser: true,
        deps: { fetchImpl: google.fetchImpl, openUrl: browser.openUrl, timeoutMs: 5000 },
      })
    ).rejects.toThrow(/access_denied/);
  });

  it('fails loudly, with the fix, when Google returns no refresh token', async () => {
    const google = fakeGoogle({ refreshToken: null });
    const browser = approvingBrowser();

    await expect(
      runDesktopGoogleLogin({
        client: CLIENT,
        browser: true,
        deps: { fetchImpl: google.fetchImpl, openUrl: browser.openUrl, timeoutMs: 5000 },
      })
    ).rejects.toThrow(/myaccount\.google\.com\/permissions/);
  });

  it('prints the URL instead of opening a browser when asked', async () => {
    const google = fakeGoogle();
    const printed: string[] = [];
    const browser = approvingBrowser();
    const login = runDesktopGoogleLogin({
      client: CLIENT,
      browser: false,
      deps: {
        fetchImpl: google.fetchImpl,
        print: (line) => {
          printed.push(line);
          if (line.startsWith('https://')) browser.openUrl(line);
        },
        timeoutMs: 5000,
      },
    });
    const { credential } = await login;
    expect(printed.some((line) => line.startsWith(GOOGLE_AUTH_URL))).toBe(true);
    expect(credential.email).toBe('me@example.com');
  });
});

describe('credential files', () => {
  it('writes an owner-only file named by the email that the shared parser reads back', () => {
    const dir = join(tempDir(), 'google');
    const credential = {
      type: 'authorized_user' as const,
      client_id: 'c',
      client_secret: 's',
      refresh_token: 'r',
      email: 'me@example.com',
      scopes: ['a'],
      obtained_at: '2026-09-08T18:00:00.000Z',
      source: 'ink google login',
    };

    const path = writeDesktopCredential(dir, credential);

    expect(path).toBe(join(dir, 'me@example.com' + '.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(parseDesktopGoogleCredential(JSON.parse(readFileSync(path, 'utf-8')))).toEqual({
      ok: true,
      value: credential,
    });

    const listed = listDesktopCredentials(dir);
    expect(listed.credentials.map((c) => c.credential.email)).toEqual(['me@example.com']);
    expect(listed.malformed).toEqual([]);

    expect(removeDesktopCredential(dir, 'ME@example.com')).toBe(true);
    expect(removeDesktopCredential(dir, 'me@example.com')).toBe(false);
    expect(listDesktopCredentials(dir).credentials).toEqual([]);
  });

  it('reports malformed files instead of throwing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'broken.json'), '{"type":"authorized_user"}');
    writeFileSync(join(dir, 'garbage.json'), 'not json');
    const listed = listDesktopCredentials(dir);
    expect(listed.credentials).toEqual([]);
    expect(listed.malformed.map((m) => m.path).sort()).toEqual([
      join(dir, 'broken.json'),
      join(dir, 'garbage.json'),
    ]);
  });
});

describe('loadDesktopOAuthClient', () => {
  it("imports Google's downloaded Desktop client into the credentials dir, then finds it without a flag", () => {
    const downloads = tempDir();
    const dir = join(tempDir(), 'google');
    const downloaded = join(downloads, 'client_secret_123.json');
    writeFileSync(
      downloaded,
      JSON.stringify({ installed: { client_id: 'id', client_secret: 'sec' } })
    );

    const first = loadDesktopOAuthClient(dir, downloaded);
    expect(first).toEqual({
      client: { clientId: 'id', clientSecret: 'sec' },
      path: join(dir, 'client.json'),
      imported: true,
    });
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    const second = loadDesktopOAuthClient(dir);
    expect(second).toEqual({
      client: { clientId: 'id', clientSecret: 'sec' },
      path: join(dir, 'client.json'),
      imported: false,
    });
  });

  it('refuses a Web-application client and explains what to create instead', () => {
    const dir = tempDir();
    const web = join(dir, 'web.json');
    writeFileSync(web, JSON.stringify({ web: { client_id: 'id', client_secret: 'sec' } }));
    expect(() => loadDesktopOAuthClient(join(dir, 'google'), web)).toThrow(/Desktop app/);
  });

  it('says how to get a client when none is stored', () => {
    expect(() => loadDesktopOAuthClient(join(tempDir(), 'google'))).toThrow(
      /ink google login --client/
    );
  });
});

describe('checkDesktopCredential', () => {
  const credential = {
    type: 'authorized_user' as const,
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
    email: 'me@example.com',
    scopes: [],
  };

  it('reports a working refresh', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ expires_in: 3599 }),
    }));
    expect(await checkDesktopCredential(credential, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: true,
      expiresInSeconds: 3599,
    });
  });

  it("reports Google's refusal with its description", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
    }));
    expect(await checkDesktopCredential(credential, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      status: 400,
      error: 'Token has been expired or revoked.',
    });
  });
});
