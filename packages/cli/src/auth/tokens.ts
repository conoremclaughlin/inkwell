/**
 * Inkwell Auth Tokens
 *
 * PKCE generation, token storage (~/.ink/auth.json), refresh,
 * and JWT payload decoding for CLI OAuth flow.
 */

import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds from issuance
  scope: string;
  issued_at: number; // Date.now() at storage time
}

export interface StoredDelegatedAuth {
  access_token: string;
  expires_in: number; // seconds from issuance
  issued_at: number; // Date.now() at storage time
  scope?: string;
  agent_id: string;
  sb_id?: string;
}

type ExpiringToken = {
  expires_in: number;
  issued_at: number;
};

export interface JwtPayload {
  type: string;
  sub: string; // userId
  email: string;
  scope: string;
  sbSlug?: string;
  identityId?: string;
  sessionId?: string;
  exp: number;
  iat: number;
}

// ============================================================================
// Paths
// ============================================================================

const CLIENT_ID = 'sb-cli';

function authFilePath(): string {
  return join(homedir(), '.ink', 'auth.json');
}

function configFilePath(): string {
  return join(homedir(), '.ink', 'config.json');
}

function delegatedAuthDirPath(): string {
  return join(homedir(), '.ink', 'auth', 'agents');
}

function sanitizeSlug(sbSlug: string): string {
  return sbSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function delegatedAuthFilePath(sbSlug: string): string {
  return join(delegatedAuthDirPath(), `${sanitizeSlug(sbSlug)}.json`);
}

// ============================================================================
// PKCE
// ============================================================================

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ============================================================================
// Token Storage
// ============================================================================

export function loadAuth(): StoredAuth | null {
  const path = authFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  const path = authFilePath();
  const dir = join(homedir(), '.ink');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(auth, null, 2) + '\n');
  chmodSync(path, 0o600);
}

export function clearAuth(): void {
  const path = authFilePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function loadDelegatedAuth(sbSlug: string): StoredDelegatedAuth | null {
  const path = delegatedAuthFilePath(sbSlug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveDelegatedAuth(sbSlug: string, auth: StoredDelegatedAuth): void {
  const dir = delegatedAuthDirPath();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort only; some environments may not support chmod.
  }

  const path = delegatedAuthFilePath(sbSlug);
  writeFileSync(path, JSON.stringify(auth, null, 2) + '\n');
  chmodSync(path, 0o600);
}

export function clearDelegatedAuth(sbSlug: string): void {
  const path = delegatedAuthFilePath(sbSlug);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ============================================================================
// Unverified JWT decode — selection only; the server authenticates the token
// ============================================================================

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ============================================================================
// Token Expiry
// ============================================================================

export function isTokenExpired(auth: ExpiringToken, bufferSeconds = 300): boolean {
  const expiresAtMs = auth.issued_at + auth.expires_in * 1000;
  return Date.now() + bufferSeconds * 1000 >= expiresAtMs;
}

// ============================================================================
// Token Refresh
// ============================================================================

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

export async function refreshAccessToken(serverUrl: string, auth: StoredAuth): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: CLIENT_ID,
  });

  const response = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await response.json()) as TokenResponse;

  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || auth.refresh_token,
    expires_in: data.expires_in,
    scope: data.scope || auth.scope,
    issued_at: Date.now(),
  };
}

// ============================================================================
// High-Level: Get Valid Access Token
// ============================================================================

/**
 * True when a token is a decodable JWT whose exp is in the past (with buffer).
 * Opaque/undecodable tokens return false — we only skip tokens we can PROVE
 * are expired.
 */
export function isJwtProvablyExpired(token: string, bufferSeconds = 60): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 <= Date.now() + bufferSeconds * 1000;
}

/** Which credential this process would present, and where it came from. */
export interface SelectedCredential {
  source: 'env' | 'stored';
  token: string;
}

/** A token naming a session must never widen into the machine login. */
export function hasSessionTokenBinding(): boolean {
  // Set explicitly by server launchers, independently of whether minting or
  // delivery left a token. INK_SESSION_ID alone also describes interactive OAuth.
  if (requiresRunnerCredential()) return true;
  const token = process.env.INK_ACCESS_TOKEN?.trim();
  const sessionId = token ? decodeJwtPayload(token)?.sessionId : undefined;
  // Interactive launchers also set INK_SESSION_ID beside a human OAuth token.
  // Only the credential's own claim limits authority to that session. Decoding
  // is not verification; the server still verifies the signature and scope.
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}

function requiresRunnerCredential(): boolean {
  // A malformed policy value is a refusal, never an opt-out into machine auth.
  return process.env.INK_RUNNER_AUTH_REQUIRED !== undefined;
}

function usableRunnerCredential(token: string): boolean {
  const payload = decodeJwtPayload(token);
  const sessionId = process.env.INK_SESSION_ID?.trim();
  const sbSlug = process.env.SB_SLUG?.trim();
  // These are selection checks, NOT signature verification. Only the server
  // can authenticate the JWT; its refusal must not trigger another credential.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const nbf = (payload as JwtPayload & { nbf?: unknown }).nbf;
  return (
    process.env.INK_RUNNER_AUTH_REQUIRED === '1' &&
    !!sessionId &&
    payload.sessionId === sessionId &&
    !!sbSlug &&
    payload.sbSlug === sbSlug &&
    payload.type === 'mcp_access' &&
    typeof payload.sub === 'string' &&
    !!payload.sub.trim() &&
    typeof payload.scope === 'string' &&
    payload.scope.split(/\s+/).includes('mcp:tools') &&
    typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp) &&
    payload.exp * 1000 > Date.now() + 60_000 &&
    (nbf === undefined ||
      (typeof nbf === 'number' && Number.isFinite(nbf) && nbf * 1000 <= Date.now()))
  );
}

/**
 * The credential-selection half of `getValidAccessToken`, without the network.
 *
 * Callers that need to know WHO this process is — not to make a request, but
 * to scope something to the account — must not restate this precedence. The
 * env token is skipped when provably expired, and restating that rule without
 * the expiry check picks a different account than the request will actually
 * use. `agent-backend.ts` did exactly that: an expired env token for one
 * account and valid stored auth for another meant the HTTP call went out as
 * the second while the cache was keyed to the first. (Lumen, #665 r3.)
 *
 * Synchronous on purpose: it never refreshes, so it is safe on a launch path.
 * A refresh rotates the token but not the account, so the identity it reports
 * is the identity the eventual request carries.
 */
export function selectCredential(options?: { allowEnvToken?: boolean }): SelectedCredential | null {
  const allowEnvToken = options?.allowEnvToken !== false;
  if (requiresRunnerCredential()) {
    const token = process.env.INK_ACCESS_TOKEN?.trim();
    return allowEnvToken && token && usableRunnerCredential(token)
      ? { source: 'env', token }
      : null;
  }
  if (allowEnvToken) {
    const envToken = process.env.INK_ACCESS_TOKEN?.trim();
    // Skip provably expired env tokens. Unscoped commands may use the
    // stored login below; session-bound commands must instead re-admit.
    if (envToken && !isJwtProvablyExpired(envToken)) {
      return { source: 'env', token: envToken };
    }
  }
  // Expired/revoked session authority requires re-admission, not auth.json.
  // This also fences explicit allowEnvToken:false fallback callers.
  if (hasSessionTokenBinding()) return null;
  const auth = loadAuth();
  return auth ? { source: 'stored', token: auth.access_token } : null;
}

export async function getValidAccessToken(
  serverUrl: string,
  options?: { allowEnvToken?: boolean }
): Promise<string | null> {
  const selected = selectCredential(options);
  if (!selected && requiresRunnerCredential()) {
    throw new Error('Server runner credential unavailable; re-admit the session before retrying');
  }
  if (!selected) return null;
  if (selected.source === 'env') return selected.token;

  const auth = loadAuth();
  if (!auth) return null;

  if (!isTokenExpired(auth)) {
    return auth.access_token;
  }

  // One refresh per refresh token. Calls that overlap in this process (a batch
  // of concurrent reads) would otherwise each spend the same refresh token,
  // and a refresh that fails clears auth.json for everyone.
  const key = `${serverUrl}\n${auth.refresh_token}`;
  const inFlight = refreshesInFlight.get(key);
  if (inFlight) return inFlight;
  const refresh = refreshStoredAuth(serverUrl, auth).finally(() => {
    refreshesInFlight.delete(key);
  });
  refreshesInFlight.set(key, refresh);
  return refresh;
}

const refreshesInFlight = new Map<string, Promise<string | null>>();

async function refreshStoredAuth(serverUrl: string, auth: StoredAuth): Promise<string | null> {
  try {
    const refreshed = await refreshAccessToken(serverUrl, auth);
    saveAuth(refreshed);
    return refreshed.access_token;
  } catch {
    // Refresh failed (token revoked or expired) — force re-login
    clearAuth();
    return null;
  }
}

export function getValidDelegatedAccessToken(
  sbSlug: string,
  options?: { bufferSeconds?: number }
): string | null {
  if (hasSessionTokenBinding()) return null;
  const auth = loadDelegatedAuth(sbSlug);
  if (!auth) return null;
  if (isTokenExpired(auth, options?.bufferSeconds ?? 300)) return null;
  return auth.access_token;
}

// ============================================================================
// Config Helpers
// ============================================================================

export function updateConfigEmail(email: string, userId?: string): void {
  const path = configFilePath();
  const dir = join(homedir(), '.ink');
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Overwrite unparseable config
    }
  }

  existing.email = email;
  if (userId) existing.userId = userId;
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
}

export { CLIENT_ID };
