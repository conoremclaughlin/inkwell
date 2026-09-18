/**
 * PCP Auth Tokens
 *
 * PKCE generation, token storage (~/.ink/auth.json), refresh,
 * and JWT payload decoding for CLI OAuth flow.
 */

import crypto from 'crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from 'fs';
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
  agentId?: string;
  identityId?: string;
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

function sanitizeAgentId(agentId: string): string {
  return agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function delegatedAuthFilePath(agentId: string): string {
  return join(delegatedAuthDirPath(), `${sanitizeAgentId(agentId)}.json`);
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

/**
 * Write a credential file so a concurrent reader sees all of it or none of it.
 *
 * `writeFileSync` on an existing path truncates and then writes, so a second
 * process reading in between gets a partial file. `loadAuth` answers a parse
 * failure with null, which its callers read as "not logged in" — a race that
 * logs the CLI out of a perfectly good session. Writing a sibling temp file and
 * renaming makes the swap atomic: `rename(2)` within a directory either has
 * happened or has not.
 */
function writeCredentialFileAtomically(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; the rename failure is what matters.
    }
    throw err;
  }
  chmodSync(path, 0o600);
}

export function saveAuth(auth: StoredAuth): void {
  const dir = join(homedir(), '.ink');
  mkdirSync(dir, { recursive: true });
  writeCredentialFileAtomically(authFilePath(), JSON.stringify(auth, null, 2) + '\n');
}

export function clearAuth(): void {
  const path = authFilePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Delete the stored credential only if it is still the one the caller was
 * holding.
 *
 * `~/.ink/auth.json` is shared by every CLI process on the machine, and a
 * refresh rotates it. A caller whose own refresh failed cannot conclude the
 * file is dead: another process may have rotated the grant a moment earlier, in
 * which case the file now holds a working secret that is none of this caller's
 * business to delete. Comparing before unlinking keeps a lost race from logging
 * the winner out.
 *
 * The compare and the unlink are not one operation, so a rotation landing
 * between them is still lost. That window is microseconds against the seconds a
 * token exchange takes, and the server's retry overlap means the loser
 * usually succeeds and never reaches this function at all.
 *
 * @returns whether the file was removed
 */
export function clearAuthIfUnchanged(refreshToken: string): boolean {
  const current = loadAuth();
  if (!current) return false;
  if (current.refresh_token !== refreshToken) return false;
  clearAuth();
  return true;
}

export function loadDelegatedAuth(agentId: string): StoredDelegatedAuth | null {
  const path = delegatedAuthFilePath(agentId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveDelegatedAuth(agentId: string, auth: StoredDelegatedAuth): void {
  const dir = delegatedAuthDirPath();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort only; some environments may not support chmod.
  }

  writeCredentialFileAtomically(
    delegatedAuthFilePath(agentId),
    JSON.stringify(auth, null, 2) + '\n'
  );
}

export function clearDelegatedAuth(agentId: string): void {
  const path = delegatedAuthFilePath(agentId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ============================================================================
// JWT Decode (no verification — server-issued, trusted locally)
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

export async function getValidAccessToken(
  serverUrl: string,
  options?: { allowEnvToken?: boolean }
): Promise<string | null> {
  const allowEnvToken = options?.allowEnvToken !== false;
  if (allowEnvToken) {
    const envToken = process.env.INK_ACCESS_TOKEN?.trim();
    // Skip a provably-expired env token instead of returning it blindly.
    // Long-lived agent sessions inherit INK_ACCESS_TOKEN injected at session
    // start; once it expires, every spawned CLI command would 401 forever —
    // even after a fresh `ink login` — because the env token short-circuits
    // the auth.json path below.
    if (envToken && !isJwtProvablyExpired(envToken)) {
      return envToken;
    }
  }

  const auth = loadAuth();
  if (!auth) return null;

  if (!isTokenExpired(auth)) {
    return auth.access_token;
  }

  // Attempt refresh
  try {
    const refreshed = await refreshAccessToken(serverUrl, auth);
    saveAuth(refreshed);
    return refreshed.access_token;
  } catch {
    // A failed exchange is not proof the grant is dead. `~/.ink/auth.json` is
    // shared by every CLI process on this machine, and the grant rotates: if
    // another process refreshed while we were in flight, the secret we
    // presented is the one IT retired, and the file already holds the live
    // successor. Re-read before concluding anything.
    const current = loadAuth();
    if (current && current.refresh_token !== auth.refresh_token) {
      // Someone else won. Their result is the answer.
      if (!isTokenExpired(current)) return current.access_token;
      try {
        const refreshed = await refreshAccessToken(serverUrl, current);
        saveAuth(refreshed);
        return refreshed.access_token;
      } catch {
        // Their secret failed too, but it is not ours to delete — we never
        // held it, and a third process may be mid-rotation with it right now.
        return null;
      }
    }

    // The file still holds the secret we presented, so the failure is the
    // grant's own: revoked, or past its deadline. Clear it — but conditionally,
    // so a rotation landing in the meantime survives.
    clearAuthIfUnchanged(auth.refresh_token);
    return null;
  }
}

export function getValidDelegatedAccessToken(
  agentId: string,
  options?: { bufferSeconds?: number }
): string | null {
  const auth = loadDelegatedAuth(agentId);
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
