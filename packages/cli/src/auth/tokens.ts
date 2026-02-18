/**
 * PCP Auth Tokens
 *
 * PKCE generation, token storage (~/.pcp/auth.json), refresh,
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
  return join(homedir(), '.pcp', 'auth.json');
}

function configFilePath(): string {
  return join(homedir(), '.pcp', 'config.json');
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
  const dir = join(homedir(), '.pcp');
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

export function isTokenExpired(auth: StoredAuth, bufferSeconds = 300): boolean {
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

export async function getValidAccessToken(serverUrl: string): Promise<string | null> {
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
    // Refresh failed (token revoked or expired) — force re-login
    clearAuth();
    return null;
  }
}

// ============================================================================
// Config Helpers
// ============================================================================

export function updateConfigEmail(email: string, userId?: string): void {
  const path = configFilePath();
  const dir = join(homedir(), '.pcp');
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
