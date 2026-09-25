/**
 * Compatibility with data written before agentId -> sbSlug.
 *
 * No migration renames anything, so both of these shapes are what is actually
 * on disk and in the database right now. Each test feeds the OLD shape to the
 * NEW code — the direction that breaks in production if the compat is dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { JWT_SECRET: TEST_JWT_SECRET } = fakeEnv;

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
    // Inlined: vi.mock factories are hoisted above every top-level const.
  },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { verifyInkAccessToken } from './ink-tokens';
import { parseStudioLease } from '../services/studio-lease.service';
import { fakeEnv, fakeWrongValue } from '../test/fake-env';

const sign = (claims: Record<string, unknown>) =>
  jwt.sign(claims, TEST_JWT_SECRET, { expiresIn: '1h' });

describe('access tokens minted before the rename', () => {
  it('reads a legacy agentId claim as sbSlug', () => {
    const token = sign({
      type: 'mcp_access',
      sub: 'user-1',
      email: 'a@b.c',
      scope: 'mcp:tools',
      agentId: 'wren',
    });

    const payload = verifyInkAccessToken(token, 'mcp_access');

    // Every runner token issued in the hour before deploy looks like this.
    // Without the normalization the SB is anonymous for the rest of its life.
    expect(payload?.sbSlug).toBe('wren');
  });

  it('prefers a real sbSlug claim over a stale agentId on the same token', () => {
    const token = sign({
      type: 'mcp_access',
      sub: 'user-1',
      email: 'a@b.c',
      scope: 'mcp:tools',
      sbSlug: 'lumen',
      agentId: 'wren',
    });

    expect(verifyInkAccessToken(token, 'mcp_access')?.sbSlug).toBe('lumen');
  });

  it('leaves a token with neither claim without a slug', () => {
    const token = sign({ type: 'mcp_access', sub: 'user-1', email: 'a@b.c', scope: 'mcp:tools' });

    expect(verifyInkAccessToken(token, 'mcp_access')?.sbSlug).toBeUndefined();
  });

  it('still rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign(
      { type: 'mcp_access', sub: 'user-1', email: 'a@b.c', scope: 'mcp:tools', agentId: 'wren' },
      fakeWrongValue
    );

    // Control: the compat path must not become a way in.
    expect(verifyInkAccessToken(forged, 'mcp_access')).toBeNull();
  });
});

describe('studio lease rows written before the rename', () => {
  const base = {
    sessionId: 'sess-1',
    threadKey: 'pr:1',
    acquiredAt: '2026-09-01T00:00:00Z',
    heartbeatAt: '2026-09-01T00:00:00Z',
  };

  it('reads a legacy agentId key as sbSlug', () => {
    const lease = parseStudioLease({ ...base, agentId: 'wren' } as never);

    // A lease whose holder parsed as '' reads as held by nobody, and the next
    // caller takes a worktree someone is working in.
    expect(lease?.sbSlug).toBe('wren');
    expect(lease?.sbSlug).not.toBe('');
  });

  it('prefers sbSlug when a row carries both', () => {
    const lease = parseStudioLease({ ...base, sbSlug: 'lumen', agentId: 'wren' } as never);
    expect(lease?.sbSlug).toBe('lumen');
  });

  it('still yields an empty holder when a row carries neither', () => {
    expect(parseStudioLease({ ...base } as never)?.sbSlug).toBe('');
  });
});
