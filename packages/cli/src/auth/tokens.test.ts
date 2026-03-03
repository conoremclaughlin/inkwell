/**
 * Tests for auth/tokens.ts — PKCE, token storage, JWT decode, expiry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generatePkce,
  decodeJwtPayload,
  isTokenExpired,
  getValidAccessToken,
  loadAuth,
  saveAuth,
  clearAuth,
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

  it('extracts optional agentId and identityId', () => {
    const token = makeJwt({
      type: 'mcp_access',
      sub: 'user-123',
      email: 'test@example.com',
      scope: 'mcp:tools',
      agentId: 'wren',
      identityId: 'id-456',
      exp: 9999999999,
      iat: 1000000000,
    });

    const payload = decodeJwtPayload(token);
    expect(payload!.agentId).toBe('wren');
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
    tempHome = join(tmpdir(), `pcp-auth-test-${Date.now()}`);
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
    const authPath = join(tempHome, '.pcp', 'auth.json');
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

describe('getValidAccessToken', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let origEnvToken: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnvToken = process.env.PCP_ACCESS_TOKEN;
    tempHome = join(tmpdir(), `pcp-token-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnvToken === undefined) delete process.env.PCP_ACCESS_TOKEN;
    else process.env.PCP_ACCESS_TOKEN = origEnvToken;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('prefers PCP_ACCESS_TOKEN from environment when present', async () => {
    process.env.PCP_ACCESS_TOKEN = 'env-token';
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe('env-token');
  });

  it('returns env token even when auth.json is absent', async () => {
    process.env.PCP_ACCESS_TOKEN = 'env-only-token';
    const token = await getValidAccessToken('http://localhost:3001');
    expect(token).toBe('env-only-token');
  });

  it('can skip env token lookup when allowEnvToken=false', async () => {
    process.env.PCP_ACCESS_TOKEN = 'env-only-token';
    const token = await getValidAccessToken('http://localhost:3001', { allowEnvToken: false });
    expect(token).toBeNull();
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
    tempHome = join(tmpdir(), `pcp-config-test-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates config.json with email', () => {
    updateConfigEmail('test@example.com', 'user-123');
    const configPath = join(tempHome, '.pcp', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.email).toBe('test@example.com');
    expect(config.userId).toBe('user-123');
  });

  it('preserves existing config fields', () => {
    const configDir = join(tempHome, '.pcp');
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
