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

// The provider's identity read. A chain that finds the SB, so an admitted
// token reads as live; every from() is recorded.
const identityReads = vi.hoisted(() => [] as string[]);
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      identityReads.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [{ id: '00000000-0000-4000-8000-0000000000b1' }], error: null });
      return chain;
    },
  })),
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

  it.each(['sbSlug', 'sbId', 'sessionId', 'workspaceId', 'threadId', 'threadKey'] as const)(
    'refuses a space-turn token missing %s',
    (claim) => {
      const { [claim]: _dropped, ...rest } = spaceTurnClaims;
      expect(provider.verifyAccessTokenSignature(`Bearer ${sign(rest)}`)).toBeNull();
    }
  );

  it.each(['sbSlug', 'sbId', 'threadKey'] as const)(
    'refuses a space-turn token whose %s is blank',
    (claim) => {
      const token = sign({ ...spaceTurnClaims, [claim]: '  ' });
      expect(provider.verifyAccessTokenSignature(`Bearer ${token}`)).toBeNull();
    }
  );

  it('refuses a space-turn token that names no SB at all', () => {
    // With no SB claim the request would be enriched from the unsigned
    // context header and could act as another of the owner's inklings.
    const { sbSlug: _s, sbId: _i, ...noSb } = spaceTurnClaims;
    expect(provider.verifyAccessTokenSignature(`Bearer ${sign(noSb)}`)).toBeNull();
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

  it('keeps the scope on a verified token that names no SB (defense in depth)', () => {
    // The verifier no longer passes such a token, but the handoff must not
    // read a narrow token as an unscoped one if one ever reaches it.
    expect(
      tokenIdentityContext({
        sessionId: SESSION,
        scope: 'mcp:space-turn',
        workspaceId: WORKSPACE,
        threadId: THREAD,
        threadKey: THREAD_KEY,
      })
    ).toEqual({
      tokenScope: 'mcp:space-turn',
      tokenWorkspaceId: WORKSPACE,
      tokenThreadId: THREAD,
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

describe('the seam: verifyAccessToken refuses a space-turn token unless asked not to', () => {
  const provider = new InkAuthProvider();

  it.each(['mcp:space-turn', 'mcp:tools mcp:space-turn'])(
    'refuses %s by default with a classified 403, before the identity read',
    async (scope) => {
      identityReads.length = 0;
      const verdict = await provider.verifyAccessToken(
        `Bearer ${sign({ ...spaceTurnClaims, scope })}`
      );
      expect(verdict).toEqual({ ok: false, status: 403, reason: 'space_turn_token_refused' });
      expect(identityReads).toEqual([]);
    }
  );

  it('admits a space-turn token when the caller opts in, after the identity read', async () => {
    identityReads.length = 0;
    const verdict = await provider.verifyAccessToken(`Bearer ${sign(spaceTurnClaims)}`, {
      allowSpaceTurn: true,
    });
    expect(verdict).toMatchObject({
      ok: true,
      token: { scope: 'mcp:space-turn', threadKey: THREAD_KEY },
    });
    expect(identityReads).toEqual(['agent_identities']);
  });

  it('admits an ordinary runner token either way (control)', async () => {
    const bearer = `Bearer ${sign({ scope: 'mcp:tools', sbId: SB, sessionId: SESSION })}`;
    expect(await provider.verifyAccessToken(bearer)).toMatchObject({
      ok: true,
      token: { scope: 'mcp:tools' },
    });
    expect(await provider.verifyAccessToken(bearer, { allowSpaceTurn: true })).toMatchObject({
      ok: true,
      token: { scope: 'mcp:tools' },
    });
  });

  it('still refuses an incomplete space-turn token as invalid (401), opted in or not', async () => {
    const { threadKey: _k, ...unbound } = spaceTurnClaims;
    const bearer = `Bearer ${sign(unbound)}`;
    expect(await provider.verifyAccessToken(bearer)).toEqual({ ok: false, status: 401 });
    expect(await provider.verifyAccessToken(bearer, { allowSpaceTurn: true })).toEqual({
      ok: false,
      status: 401,
    });
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
