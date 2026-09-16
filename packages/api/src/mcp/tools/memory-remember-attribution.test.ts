/**
 * remember() attributes to the session the caller is actually running in.
 *
 * Unit coverage for PR #596 through the real request context (the memory
 * handler suite mocks the context module wholesale, which cannot express the
 * shapes below). The database version of the incident lives in
 * memory-session-attribution.integration.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { runWithRequestContext } from '../../utils/request-context';
import { handleRemember } from './memory-handlers';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn().mockResolvedValue({ user: { id: 'owner' }, resolvedBy: 'userId' }),
}));

const ownSession = '11111111-1111-4111-8111-111111111111';
const newerSession = '22222222-2222-4222-8222-222222222222';
const foreignUserSession = '66666666-6666-4666-8666-666666666666';
const sbId = '33333333-3333-4333-8333-333333333333';

type RememberInput = { sbSlug?: string; metadata?: { sessionId?: string } };

function fixture(opts: { owned?: object[]; throws?: boolean } = {}) {
  const live = { id: ownSession, userId: 'owner', sbSlug: 'myra', sbId };
  const newer = { id: newerSession, userId: 'owner', sbSlug: 'myra', sbId, studioId: 'elsewhere' };
  const foreign = { id: foreignUserSession, userId: 'someone-else', sbSlug: 'myra', sbId };
  const rows: Record<string, object> = {
    [ownSession]: live,
    [newerSession]: newer,
    [foreignUserSession]: foreign,
  };
  const remember = vi.fn(async (input: RememberInput) => ({
    ...input,
    id: 'memory',
    createdAt: new Date(),
  }));
  const getSession = vi.fn(async (id: string) => {
    if (opts.throws) throw new Error('db down');
    return rows[id] ?? null;
  });
  const getActiveSession = vi.fn().mockResolvedValue(newer);
  const findOwnedActiveSessions = vi.fn(async () => {
    if (opts.throws) throw new Error('db down');
    return opts.owned ?? [live, newer];
  });
  const composer = {
    repositories: { memory: { remember, getSession, getActiveSession, findOwnedActiveSessions } },
  } as unknown as DataComposer;
  return { composer, remember, getSession, getActiveSession, findOwnedActiveSessions };
}

const saved = (f: ReturnType<typeof fixture>) => f.remember.mock.calls[0]![0];

afterEach(() => vi.clearAllMocks());

describe('handleRemember — session attribution', () => {
  it('uses the signed current session and never consults newer rows', async () => {
    // The incident: a newer same-identity row exists and the old recency lookup
    // would have picked it. The signed claim names the real session.
    const f = fixture();
    await runWithRequestContext(
      {
        userId: 'owner',
        sbSlug: 'myra',
        sbId,
        agentTokenBound: true,
        tokenSlug: 'myra',
        tokenSbId: sbId,
        tokenSessionId: ownSession,
        sessionId: newerSession,
      },
      () => handleRemember({ content: 'probe' }, f.composer)
    );
    expect(saved(f).metadata?.sessionId).toBe(ownSession);
    expect(f.getActiveSession).not.toHaveBeenCalled();
    expect(f.findOwnedActiveSessions).not.toHaveBeenCalled();
  });

  it('keeps attribution on the enriched user-token call that omits sbSlug', async () => {
    // Lumen's #596 probe. The normal local auth shape: a user bearer, ctx.sbSlug
    // enriched from the ambient session, the call passing no sbSlug. The
    // effective identity is still 'myra' — the memory is attributed to it, and
    // the resolver must be handed the same identity rather than `undefined`.
    const f = fixture();
    await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: ownSession },
      () => handleRemember({ content: 'probe' }, f.composer)
    );
    expect(saved(f).sbSlug).toBe('myra');
    expect(saved(f).metadata?.sessionId).toBe(ownSession);
    expect(f.getActiveSession).not.toHaveBeenCalled();
  });

  it("still validates that the ambient session is the user's own", async () => {
    // Carrying the effective identity must not weaken the same-user floor. A
    // user-token call whose header names another user's session gets no
    // attribution from it — and, with several own sessions and no scope, no
    // guess either. The memory is saved regardless.
    const f = fixture();
    await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: foreignUserSession },
      () => handleRemember({ content: 'probe' }, f.composer)
    );
    expect(f.remember).toHaveBeenCalledTimes(1);
    expect(saved(f).metadata?.sessionId).toBeUndefined();
  });

  it('falls through to the one owned session in scope when the header is unusable', async () => {
    const f = fixture({ owned: [{ id: ownSession, userId: 'owner', sbSlug: 'myra', sbId }] });
    await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: foreignUserSession },
      () => handleRemember({ content: 'probe' }, f.composer)
    );
    expect(saved(f).metadata?.sessionId).toBe(ownSession);
  });

  it('saves the memory without a session when nothing identifies the caller', async () => {
    // No pinned identity, no explicit sbSlug: the resolver reports
    // no-agent-identity and the peers fail closed. remember does not.
    const f = fixture();
    await runWithRequestContext({ userId: 'owner', sessionId: ownSession }, () =>
      handleRemember({ content: 'probe' }, f.composer)
    );
    expect(f.remember).toHaveBeenCalledTimes(1);
    expect(saved(f).metadata?.sessionId).toBeUndefined();
    expect(f.findOwnedActiveSessions).not.toHaveBeenCalled();
  });

  it('saves the memory without a session when resolution throws', async () => {
    const f = fixture({ throws: true });
    await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: ownSession },
      () => handleRemember({ content: 'must survive' }, f.composer)
    );
    expect(f.remember).toHaveBeenCalledTimes(1);
    expect(saved(f).metadata?.sessionId).toBeUndefined();
  });

  it('lets an explicit sessionId from the caller win outright', async () => {
    const f = fixture();
    await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: newerSession },
      () => handleRemember({ content: 'probe', sessionId: ownSession }, f.composer)
    );
    expect(saved(f).metadata?.sessionId).toBe(ownSession);
    expect(f.getSession).not.toHaveBeenCalled();
  });
});
