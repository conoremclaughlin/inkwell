/**
 * Boundaries that read data written BEFORE the agentId -> sbSlug rename.
 *
 * The MCP parameter flag day is deliberate. None of these are MCP parameters:
 * they are tokens in flight, JWTs already issued, files on disk and JSONB rows,
 * and nothing rewrites any of them. Every test here feeds the OLD shape to the
 * NEW code — the direction that breaks in production, and the direction a
 * rename-and-rename-the-fixture sweep cannot detect.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret-key',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
  },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Imported from SOURCE, not '@inklabs/shared': that specifier resolves to the
// package's built dist/, so a test using it exercises the last build rather than
// the code under review. Mutating the source left such a test green.
import { decodeContextToken, encodeContextToken } from '../../../shared/src/runner/mcp-config';
import { normalizePendingAuth } from '../mcp/auth/pcp-auth-provider';
import { archivedMetadataSlug } from '../routes/admin';
import { resolveServerSbSlug } from '../server';

const legacyToken = (extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      sessionId: 'sess-1',
      studioId: 'studio-1',
      agentId: 'aster',
      cliAttached: true,
      runtime: 'codex',
      repoRoot: '/repos/inkwell',
      ...extra,
    })
  ).toString('base64url');

describe('x-ink-context tokens minted before the rename', () => {
  it('still decodes, and yields the slug', () => {
    const decoded = decodeContextToken(legacyToken());

    // Rejecting the token discards its session, studio, runtime and
    // cliAttached together, and disables the context-session auth fallback.
    expect(decoded).not.toBeNull();
    expect(decoded?.sbSlug).toBe('aster');
  });

  it('keeps every other field the caller depends on', () => {
    const decoded = decodeContextToken(legacyToken());

    expect(decoded).toMatchObject({
      sessionId: 'sess-1',
      studioId: 'studio-1',
      cliAttached: true,
      runtime: 'codex',
      repoRoot: '/repos/inkwell',
    });
  });

  it('prefers a real sbSlug over a stale agentId on the same token', () => {
    expect(decodeContextToken(legacyToken({ sbSlug: 'lumen' }))?.sbSlug).toBe('lumen');
  });

  it('still refuses a token with no slug at all', () => {
    // Control: the compat path is not a way to smuggle an identity-less token through.
    const noSlug = Buffer.from(JSON.stringify({ sessionId: 's' })).toString('base64url');
    expect(decodeContextToken(noSlug)).toBeNull();
    expect(decodeContextToken('not-base64url-at-all!!')).toBeNull();
    expect(decodeContextToken(undefined)).toBeNull();
  });

  it('round-trips a current token unchanged', () => {
    const token = encodeContextToken({
      sessionId: 'sess-2',
      studioId: 'studio-2',
      sbSlug: 'wren',
      cliAttached: false,
      runtime: 'claude',
    });
    expect(decodeContextToken(token)?.sbSlug).toBe('wren');
  });
});

describe('pending-auth JWTs issued before the rename', () => {
  it('keeps the SB binding that mints the credentials', () => {
    const payload = jwt.decode(
      jwt.sign(
        {
          type: 'pending_auth',
          clientId: 'c1',
          codeChallenge: 'x',
          redirectUri: 'r',
          agentId: 'aster',
        },
        'test-jwt-secret-that-is-at-least-32-characters-long'
      )
    ) as never;

    // handleAuthCallback verifies with jwt.verify() directly, so it never
    // reaches verifyPcpAccessToken's normalization. Losing the slug here mints
    // an access AND refresh credential with no SB binding at all.
    expect(normalizePendingAuth(payload).sbSlug).toBe('aster');
  });

  it('prefers a real sbSlug and leaves an unbound request unbound', () => {
    expect(normalizePendingAuth({ sbSlug: 'wren', agentId: 'aster' } as never).sbSlug).toBe('wren');
    expect(normalizePendingAuth({ clientId: 'c1' } as never).sbSlug).toBeUndefined();
  });
});

describe('archived memory metadata written before the rename', () => {
  it('still resolves the slug for the scoped fallback', () => {
    // memory_history.metadata is JSONB no migration rewrites; reading only the
    // new key makes a deleted memory's history silently disappear.
    expect(archivedMetadataSlug({ agentId: 'aster', workspaceId: 'ws-1' })).toBe('aster');
  });

  it('prefers the new key and tolerates absence', () => {
    expect(archivedMetadataSlug({ sbSlug: 'wren', agentId: 'aster' })).toBe('wren');
    expect(archivedMetadataSlug({})).toBeUndefined();
    expect(archivedMetadataSlug(null)).toBeUndefined();
  });
});

describe('the slug this server routes as', () => {
  const saved = { SB_SLUG: process.env.SB_SLUG, AGENT_ID: process.env.AGENT_ID };
  const set = (sb?: string, agent?: string) => {
    sb === undefined ? delete process.env.SB_SLUG : (process.env.SB_SLUG = sb);
    agent === undefined ? delete process.env.AGENT_ID : (process.env.AGENT_ID = agent);
  };
  afterEach(() => set(saved.SB_SLUG, saved.AGENT_ID));

  it('honours the documented SB_SLUG', () => {
    set('benson', undefined);
    // The banner read SB_SLUG while the routing identity read AGENT_ID, so the
    // banner said Benson and the no-route fallback dispatched to Myra.
    expect(resolveServerSbSlug()).toBe('benson');
  });

  it('prefers SB_SLUG when a stale AGENT_ID is also present', () => {
    set('benson', 'myra');
    expect(resolveServerSbSlug()).toBe('benson');
  });

  it('still falls back to AGENT_ID for processes started before the rename', () => {
    set(undefined, 'myra');
    expect(resolveServerSbSlug()).toBe('myra');
  });

  it('defaults when neither is set', () => {
    set(undefined, undefined);
    expect(resolveServerSbSlug()).toBe('myra');
  });
});
