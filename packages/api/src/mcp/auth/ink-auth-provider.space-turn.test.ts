/**
 * A space-turn token's scope and conversation survive verification, and an
 * incomplete one is refused (ink://specs/inkling-multi-person-groups, Phase 1).
 *
 * Tokens are signed here with jwt.sign rather than the new signer, so each
 * case fails on its assertion, not on a missing import, against a tree that
 * predates the scope.
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { fakeEnv } from '../../test/fake-env';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));
vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { InkAuthProvider } from './ink-auth-provider';
import { tokenIdentityContext } from '../../utils/request-context';

const USER = '00000000-0000-4000-8000-0000000000a1';
const SB = '00000000-0000-4000-8000-0000000000b1';
const SESSION = '00000000-0000-4000-8000-0000000000c1';
const WORKSPACE = '00000000-0000-4000-8000-0000000000d1';
const THREAD = '00000000-0000-4000-8000-0000000000e1';
const THREAD_KEY = 'inkling:thread:fixture-group';

function sign(claims: Record<string, unknown>): string {
  return jwt.sign(
    { type: 'mcp_access', sub: USER, email: 'owner@example.invalid', ...claims },
    fakeEnv.JWT_SECRET,
    { expiresIn: 600 }
  );
}

const spaceTurnClaims = {
  scope: 'mcp:space-turn',
  sbSlug: 'fixture-inkling',
  sbId: SB,
  sessionId: SESSION,
  workspaceId: WORKSPACE,
  threadId: THREAD,
  threadKey: THREAD_KEY,
};

describe('space-turn token verification', () => {
  const provider = new InkAuthProvider();

  it('carries the scope and the signed conversation into the verified token', () => {
    const verified = provider.verifyAccessTokenSignature(`Bearer ${sign(spaceTurnClaims)}`);
    expect(verified).toMatchObject({
      userId: USER,
      sbId: SB,
      sessionId: SESSION,
      scope: 'mcp:space-turn',
      workspaceId: WORKSPACE,
      threadId: THREAD,
      threadKey: THREAD_KEY,
    });
  });

  it.each(['sessionId', 'workspaceId', 'threadId', 'threadKey'] as const)(
    'refuses a space-turn token missing %s',
    (claim) => {
      const { [claim]: _dropped, ...rest } = spaceTurnClaims;
      expect(provider.verifyAccessTokenSignature(`Bearer ${sign(rest)}`)).toBeNull();
    }
  );

  it('refuses a space-turn token whose binding claim is blank', () => {
    const token = sign({ ...spaceTurnClaims, threadKey: '  ' });
    expect(provider.verifyAccessTokenSignature(`Bearer ${token}`)).toBeNull();
  });

  it('reads the narrow scope wherever it appears in a scope set', () => {
    const verified = provider.verifyAccessTokenSignature(
      `Bearer ${sign({ ...spaceTurnClaims, scope: 'mcp:tools mcp:space-turn' })}`
    );
    expect(verified?.threadKey).toBe(THREAD_KEY);
    // And a mixed set missing a binding claim is refused like a bare one.
    const { threadId: _t, ...unbound } = spaceTurnClaims;
    const mixedUnbound = sign({ ...unbound, scope: 'mcp:tools mcp:space-turn' });
    expect(provider.verifyAccessTokenSignature(`Bearer ${mixedUnbound}`)).toBeNull();
  });

  it('reads a token with no scope claim as mcp:tools, unchanged otherwise', () => {
    const verified = provider.verifyAccessTokenSignature(
      `Bearer ${sign({ sbSlug: 'fixture-inkling', sbId: SB, sessionId: SESSION })}`
    );
    expect(verified).toMatchObject({ userId: USER, sbId: SB, sessionId: SESSION });
    expect(verified?.scope).toBe('mcp:tools');
    expect(verified?.threadKey).toBeUndefined();
  });

  it('keeps an ordinary runner token broad and drops conversation claims it carries', () => {
    const verified = provider.verifyAccessTokenSignature(
      `Bearer ${sign({ scope: 'mcp:tools', sbId: SB, sessionId: SESSION, threadKey: THREAD_KEY })}`
    );
    expect(verified?.scope).toBe('mcp:tools');
    // A conversation claim means something only on the scope that binds it.
    expect(verified?.threadKey).toBeUndefined();
  });
});

describe('space-turn claims reach the request context', () => {
  const provider = new InkAuthProvider();

  it('sets the token scope and conversation next to the session binding', () => {
    const verified = provider.verifyAccessTokenSignature(`Bearer ${sign(spaceTurnClaims)}`);
    expect(tokenIdentityContext(verified)).toMatchObject({
      tokenSbId: SB,
      tokenSessionId: SESSION,
      tokenScope: 'mcp:space-turn',
      tokenWorkspaceId: WORKSPACE,
      tokenThreadId: THREAD,
      tokenThreadKey: THREAD_KEY,
    });
  });

  it('keeps the scope on a token that names no SB', () => {
    const { sbSlug: _s, sbId: _i, ...noSb } = spaceTurnClaims;
    const verified = provider.verifyAccessTokenSignature(`Bearer ${sign(noSb)}`);
    // An unbound narrow token must not read as an unscoped one downstream.
    expect(tokenIdentityContext(verified)).toMatchObject({
      tokenScope: 'mcp:space-turn',
      tokenThreadKey: THREAD_KEY,
    });
  });

  it('gives an ordinary runner token mcp:tools and no conversation', () => {
    const verified = provider.verifyAccessTokenSignature(
      `Bearer ${sign({ scope: 'mcp:tools', sbId: SB, sessionId: SESSION })}`
    );
    const ctx = tokenIdentityContext(verified);
    expect(ctx.tokenScope).toBe('mcp:tools');
    expect(ctx.tokenThreadKey).toBeUndefined();
  });
});

describe('signSpaceTurnAccessToken', () => {
  it('signs what the verifier reads back', async () => {
    const { signSpaceTurnAccessToken } = await import('../../auth/ink-tokens');
    const token = signSpaceTurnAccessToken({
      userId: USER,
      email: 'owner@example.invalid',
      sbId: SB,
      sbSlug: 'fixture-inkling',
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      threadKey: THREAD_KEY,
    });
    const verified = new InkAuthProvider().verifyAccessTokenSignature(`Bearer ${token}`);
    expect(verified).toMatchObject({ scope: 'mcp:space-turn', threadKey: THREAD_KEY });
    const exp = verified?.expiresAt ?? 0;
    // The default lifetime is the runner token's hour.
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
  });
});
