/**
 * Google credential contracts shared by the API server and the `ink` CLI.
 *
 * Google access has two credential SOURCES:
 *
 *   - `cloud`   — the web OAuth connection stored in `connected_accounts`,
 *                 established from the dashboard through the server's own
 *                 OAuth client (the "Web application" client in Google Cloud).
 *   - `desktop` — an `authorized_user` file the operator obtained locally with
 *                 `ink google login`: a "Desktop app" OAuth client plus the
 *                 loopback flow, stored under `~/.ink/google/`. This is the
 *                 same client file gog (gogcli) uses and the same file shape
 *                 gcloud writes for application-default credentials.
 *
 * The CLI writes the desktop file; the server reads it. The scope list and the
 * file shape live HERE so both sides import one definition instead of each
 * keeping a copy that has to be kept in step by hand.
 */

import { join } from 'path';

// ── Endpoints ─────────────────────────────────────────────────────

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ── Scopes ────────────────────────────────────────────────────────

/**
 * Every scope the Inkwell Google integrations need. The server's provider
 * config and the CLI's consent request both read this list, so a credential
 * obtained on the desktop covers exactly what the cloud connection covers.
 */
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events', // Read + write events (respond, update)
  'https://www.googleapis.com/auth/spreadsheets', // Sheets read/write
  'https://www.googleapis.com/auth/documents', // Docs read/write
  'https://www.googleapis.com/auth/drive', // Drive (list/read/write/move/delete)
] as const;

/** Required scopes the granted set does not cover. */
export function missingGoogleScopes(
  granted: readonly string[],
  required: readonly string[] = GOOGLE_OAUTH_SCOPES
): string[] {
  const have = new Set(granted);
  return required.filter((scope) => !have.has(scope));
}

// ── Credential sources ────────────────────────────────────────────

export const GOOGLE_CREDENTIAL_SOURCES = ['cloud', 'desktop'] as const;
export type GoogleCredentialSource = (typeof GOOGLE_CREDENTIAL_SOURCES)[number];

/** What the server tries when nothing is configured: the cloud row first, then a desktop file. */
export const DEFAULT_GOOGLE_CREDENTIAL_SOURCES: readonly GoogleCredentialSource[] = [
  'cloud',
  'desktop',
];

/**
 * Parse `GOOGLE_CREDENTIAL_SOURCES` ("cloud,desktop", "desktop", …) into an
 * ordered, de-duplicated list. Unknown names are an error rather than a
 * silent skip: a typo that quietly disabled a source would look exactly like a
 * missing credential.
 */
export function parseGoogleCredentialSources(
  raw: string | null | undefined
): GoogleCredentialSource[] {
  const text = raw?.trim();
  if (!text) return [...DEFAULT_GOOGLE_CREDENTIAL_SOURCES];
  const out: GoogleCredentialSource[] = [];
  for (const token of text.split(',')) {
    const name = token.trim().toLowerCase();
    if (!name) continue;
    if (!(GOOGLE_CREDENTIAL_SOURCES as readonly string[]).includes(name)) {
      throw new Error(
        `Unknown Google credential source "${token.trim()}" in GOOGLE_CREDENTIAL_SOURCES ` +
          `(expected a comma-separated list of: ${GOOGLE_CREDENTIAL_SOURCES.join(', ')})`
      );
    }
    if (!out.includes(name as GoogleCredentialSource)) out.push(name as GoogleCredentialSource);
  }
  if (out.length === 0) return [...DEFAULT_GOOGLE_CREDENTIAL_SOURCES];
  return out;
}

// ── Desktop credential files ──────────────────────────────────────

/** The Desktop OAuth client, copied from Google's downloaded `client_secret_*.json`. */
export const DESKTOP_CLIENT_FILENAME = 'client.json';

/** `~/.ink/google` unless `INK_GOOGLE_CREDENTIALS_DIR` points somewhere else. */
export function resolveDesktopCredentialsDir(
  env: Record<string, string | undefined>,
  homeDir: string
): string {
  const override = env.INK_GOOGLE_CREDENTIALS_DIR?.trim();
  return override ? override : join(homeDir, '.ink', 'google');
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface DesktopOAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Google's downloaded client JSON is `{ "installed": { client_id, client_secret, … } }`
 * for a Desktop app. A bare `{ client_id, client_secret }` is accepted too. A
 * `"web"` client is refused: it cannot use the loopback redirect this login
 * relies on, and Google would reject the flow with a redirect_uri error later.
 */
export function parseDesktopOAuthClient(raw: unknown): ParseResult<DesktopOAuthClient> {
  if (!raw || typeof raw !== 'object')
    return { ok: false, reason: 'client file is not a JSON object' };
  const record = raw as Record<string, unknown>;
  if (record.web && !record.installed) {
    return {
      ok: false,
      reason:
        'this is a "Web application" OAuth client; the desktop login needs a "Desktop app" client ' +
        '(Google Cloud Console → Credentials → Create OAuth client ID → Desktop app)',
    };
  }
  const body = (record.installed ?? record) as Record<string, unknown>;
  const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : '';
  if (!clientId) return { ok: false, reason: 'client file has no client_id' };
  if (!clientSecret) return { ok: false, reason: 'client file has no client_secret' };
  return { ok: true, value: { clientId, clientSecret } };
}

export const DESKTOP_CREDENTIAL_TYPE = 'authorized_user' as const;

/**
 * One stored desktop login. The first three keys are Google's `authorized_user`
 * shape (what gcloud writes, what google-auth-library's `fromJSON` reads); the
 * rest are Inkwell's, and `email` is the load-bearing one — the server binds a
 * file to an Inkwell user ONLY through it.
 */
export interface DesktopGoogleCredential {
  type: typeof DESKTOP_CREDENTIAL_TYPE;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** The Google account the refresh token belongs to, normalized lowercase. */
  email: string;
  /** Scopes Google actually granted at login. */
  scopes: string[];
  /** ISO time the refresh token was obtained. */
  obtained_at?: string;
  /** Who wrote the file (e.g. "ink google login"). */
  source?: string;
}

export function normalizeGoogleEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseDesktopGoogleCredential(raw: unknown): ParseResult<DesktopGoogleCredential> {
  if (!raw || typeof raw !== 'object')
    return { ok: false, reason: 'credential is not a JSON object' };
  const record = raw as Record<string, unknown>;
  if (record.type !== DESKTOP_CREDENTIAL_TYPE) {
    return { ok: false, reason: `type must be "${DESKTOP_CREDENTIAL_TYPE}"` };
  }
  const requiredString = (key: 'client_id' | 'client_secret' | 'refresh_token' | 'email') => {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const clientId = requiredString('client_id');
  const clientSecret = requiredString('client_secret');
  const refreshToken = requiredString('refresh_token');
  const email = requiredString('email');
  if (!clientId) return { ok: false, reason: 'missing client_id' };
  if (!clientSecret) return { ok: false, reason: 'missing client_secret' };
  if (!refreshToken) return { ok: false, reason: 'missing refresh_token' };
  if (!email || !email.includes('@')) {
    return {
      ok: false,
      reason: 'missing email — the server binds a desktop credential to a user by it',
    };
  }
  const scopesRaw = record.scopes;
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((s): s is string => typeof s === 'string')
    : [];
  if (scopesRaw !== undefined && !Array.isArray(scopesRaw)) {
    return { ok: false, reason: 'scopes must be an array of strings' };
  }
  const obtainedAt = typeof record.obtained_at === 'string' ? record.obtained_at : undefined;
  const source = typeof record.source === 'string' ? record.source : undefined;
  return {
    ok: true,
    value: {
      type: DESKTOP_CREDENTIAL_TYPE,
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      email: normalizeGoogleEmail(email),
      scopes,
      ...(obtainedAt ? { obtained_at: obtainedAt } : {}),
      ...(source ? { source } : {}),
    },
  };
}

/** `<email>.json`, with anything that is not filename-safe replaced. */
export function desktopCredentialFilename(email: string): string {
  const safe = normalizeGoogleEmail(email).replace(/[^a-z0-9@._+-]/g, '_');
  return `${safe}.json`;
}
