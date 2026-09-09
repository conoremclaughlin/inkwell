/**
 * Desktop Google login — the `desktop` credential source, CLI side.
 *
 * A "Desktop app" OAuth client (the kind gog uses; downloaded from Google
 * Cloud Console as client_secret_*.json) plus the loopback flow: a one-shot
 * HTTP listener on 127.0.0.1 receives the authorization code, the code is
 * exchanged with PKCE for a refresh token, and the result is written as an
 * `authorized_user` file under ~/.ink/google/ for the API server to read.
 *
 * Everything that talks to the network or the browser is injectable so the
 * whole flow can run under test against a fake Google.
 */

import http from 'http';
import crypto from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  DESKTOP_CLIENT_FILENAME,
  DESKTOP_CREDENTIAL_TYPE,
  GOOGLE_AUTH_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  desktopCredentialFilename,
  normalizeGoogleEmail,
  parseDesktopGoogleCredential,
  parseDesktopOAuthClient,
  resolveDesktopCredentialsDir,
  type DesktopGoogleCredential,
  type DesktopOAuthClient,
} from '@inklabs/shared';

export const DESKTOP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DESKTOP_CREDENTIAL_SOURCE_LABEL = 'ink google login';

/** ~/.ink/google unless INK_GOOGLE_CREDENTIALS_DIR says otherwise. */
export function desktopCredentialsDir(): string {
  return resolveDesktopCredentialsDir(process.env, homedir());
}

// ── Client file ───────────────────────────────────────────────────

export interface LoadedDesktopClient {
  client: DesktopOAuthClient;
  /** Where the client now lives — always inside the credentials dir. */
  path: string;
  /** True when an explicit file was copied into the credentials dir. */
  imported: boolean;
}

/**
 * The Desktop OAuth client to log in with. An explicit path is validated and
 * copied to `<dir>/client.json` so later logins need no flag; otherwise the
 * copy already there is used.
 */
export function loadDesktopOAuthClient(dir: string, explicitPath?: string): LoadedDesktopClient {
  const target = join(dir, DESKTOP_CLIENT_FILENAME);
  const source = explicitPath ? resolve(explicitPath) : target;
  if (!existsSync(source)) {
    throw new Error(
      explicitPath
        ? `Client file not found: ${source}`
        : `No Desktop OAuth client at ${target}. Create one in Google Cloud Console ` +
            `(Credentials → Create OAuth client ID → Desktop app), download the JSON, ` +
            `and run: ink google login --client <path-to-client_secret_*.json>`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(source, 'utf-8'));
  } catch (err) {
    throw new Error(`Client file ${source} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = parseDesktopOAuthClient(raw);
  if (!parsed.ok) throw new Error(`Client file ${source}: ${parsed.reason}`);

  let imported = false;
  if (explicitPath && resolve(source) !== resolve(target)) {
    ensurePrivateDir(dir);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    imported = true;
  }
  return { client: parsed.value, path: target, imported };
}

// ── Credential files ──────────────────────────────────────────────

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort; some filesystems refuse.
  }
}

/** Write atomically (temp file + rename) with owner-only permissions. Returns the path. */
export function writeDesktopCredential(dir: string, credential: DesktopGoogleCredential): string {
  ensurePrivateDir(dir);
  const path = join(dir, desktopCredentialFilename(credential.email));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export interface StoredDesktopCredential {
  path: string;
  credential: DesktopGoogleCredential;
  modifiedAt: Date;
}

/** Every well-formed credential file in the directory; malformed ones are reported, not thrown. */
export function listDesktopCredentials(dir: string): {
  credentials: StoredDesktopCredential[];
  malformed: Array<{ path: string; reason: string }>;
} {
  const credentials: StoredDesktopCredential[] = [];
  const malformed: Array<{ path: string; reason: string }> = [];
  if (!existsSync(dir)) return { credentials, malformed };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name === DESKTOP_CLIENT_FILENAME) continue;
    const path = join(dir, name);
    try {
      const parsed = parseDesktopGoogleCredential(JSON.parse(readFileSync(path, 'utf-8')));
      if (!parsed.ok) {
        malformed.push({ path, reason: parsed.reason });
        continue;
      }
      credentials.push({ path, credential: parsed.value, modifiedAt: statSync(path).mtime });
    } catch (err) {
      malformed.push({ path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { credentials, malformed };
}

/** Delete the stored login for one account. Returns false when there was none. */
export function removeDesktopCredential(dir: string, email: string): boolean {
  const path = join(dir, desktopCredentialFilename(email));
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

// ── The login flow ────────────────────────────────────────────────

export interface DesktopLoginDeps {
  fetchImpl?: typeof fetch;
  /** Open the consent URL; the default prints nothing and expects the caller to. */
  openUrl?: (url: string) => void;
  /** Where the URL goes when no browser is opened, and where progress lines go. */
  print?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

export interface DesktopLoginOptions {
  client: DesktopOAuthClient;
  /** Defaults to the shared list the server requires. */
  scopes?: readonly string[];
  /** Open a browser (true) or print the URL (false). */
  browser: boolean;
  deps?: DesktopLoginDeps;
}

export interface DesktopLoginResult {
  credential: DesktopGoogleCredential;
  /** Scopes the login asked for; compare with credential.scopes for what was granted. */
  requestedScopes: string[];
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#fafafa">
  <h2 style="color:#16a34a">Google login complete</h2>
  <p style="color:#555">You can close this tab and return to the terminal.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#fafafa">
  <h2 style="color:#dc2626">Google login failed</h2>
  <p style="color:#555">${msg}</p>
</body></html>`;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface LoopbackServer {
  port: number;
  code: Promise<string>;
  close: () => void;
}

/**
 * One-shot listener for Google's redirect. Only the expected `state` is
 * accepted — a redirect carrying any other state is someone else's flow (or an
 * attacker's) and is refused.
 */
function startLoopbackServer(expectedState: string, timeoutMs: number): Promise<LoopbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (err: Error) => void = () => {};
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const authCode = url.searchParams.get('code');
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('State mismatch — this redirect does not belong to the running login.'));
        rejectCode(new Error('State mismatch in Google redirect'));
        return;
      }
      if (error) {
        const description = url.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(description));
        rejectCode(new Error(`Google refused the login: ${description}`));
        return;
      }
      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Missing authorization code'));
        rejectCode(new Error('Google redirect carried no authorization code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);
      resolveCode(authCode);
    });

    const timer = setTimeout(() => {
      rejectCode(new Error(`Google login timed out after ${Math.round(timeoutMs / 1000)}s`));
      server.close();
    }, timeoutMs);

    server.on('error', (err) => {
      clearTimeout(timer);
      rejectServer(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveServer({
        port,
        code,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

/**
 * Run the loopback flow and return the credential to store. Does not write
 * anything — the caller decides where it goes.
 */
export async function runDesktopGoogleLogin(
  options: DesktopLoginOptions
): Promise<DesktopLoginResult> {
  const deps = options.deps ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  const print = deps.print ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const scopes = [...(options.scopes ?? GOOGLE_OAUTH_SCOPES)];

  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');

  const server = await startLoopbackServer(state, deps.timeoutMs ?? DESKTOP_LOGIN_TIMEOUT_MS);
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    const consent = new URL(GOOGLE_AUTH_URL);
    consent.searchParams.set('client_id', options.client.clientId);
    consent.searchParams.set('redirect_uri', redirectUri);
    consent.searchParams.set('response_type', 'code');
    consent.searchParams.set('scope', scopes.join(' '));
    consent.searchParams.set('state', state);
    consent.searchParams.set('code_challenge', codeChallenge);
    consent.searchParams.set('code_challenge_method', 'S256');
    // offline + consent: the only combination Google guarantees a refresh token for.
    consent.searchParams.set('access_type', 'offline');
    consent.searchParams.set('prompt', 'consent');

    if (options.browser && deps.openUrl) {
      deps.openUrl(consent.toString());
    } else {
      print('Open this URL in your browser to sign in:');
      print('');
      print(consent.toString());
      print('');
    }

    const code = await server.code;

    const tokenBody = new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || tokens.error || !tokens.access_token) {
      throw new Error(
        `Token exchange failed: ${tokens.error_description || tokens.error || tokenResponse.status}`
      );
    }
    if (!tokens.refresh_token) {
      throw new Error(
        'Google returned no refresh token. Remove this app at https://myaccount.google.com/permissions ' +
          'and run the login again so consent is granted afresh.'
      );
    }

    const infoResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = (await infoResponse.json()) as { email?: string };
    if (!infoResponse.ok || !info.email) {
      throw new Error('Could not read the signed-in account email from Google');
    }

    const credential: DesktopGoogleCredential = {
      type: DESKTOP_CREDENTIAL_TYPE,
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: tokens.refresh_token,
      email: normalizeGoogleEmail(info.email),
      scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : scopes,
      obtained_at: new Date(now()).toISOString(),
      source: DESKTOP_CREDENTIAL_SOURCE_LABEL,
    };
    return { credential, requestedScopes: scopes };
  } finally {
    server.close();
  }
}

// ── Liveness check ────────────────────────────────────────────────

export type DesktopCredentialCheck =
  | { ok: true; expiresInSeconds: number | null }
  | { ok: false; status: number | null; error: string };

/**
 * Ask Google whether the stored refresh token still works. This is the same
 * request the server makes before every call, so a green here is a green
 * there. `invalid_grant` is what Google's seven-day testing-mode expiry looks
 * like from this side.
 */
export async function checkDesktopCredential(
  credential: DesktopGoogleCredential,
  fetchImpl: typeof fetch = fetch
): Promise<DesktopCredentialCheck> {
  const body = new URLSearchParams({
    client_id: credential.client_id,
    client_secret: credential.client_secret,
    refresh_token: credential.refresh_token,
    grant_type: 'refresh_token',
  });
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
  const data = (await response.json().catch(() => ({}))) as {
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.error_description || data.error || `HTTP ${response.status}`,
    };
  }
  return { ok: true, expiresInSeconds: data.expires_in ?? null };
}
