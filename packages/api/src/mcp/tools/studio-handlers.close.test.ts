/**
 * Behavioural probes for close_studio's identity boundary (PR #673, task
 * e7752d29), written by Lumen during the review of b1c70a7a and kept here
 * with attribution. They drive the real handler with the real caller-identity
 * and ambient-session helpers under a request context, and stub only the
 * lease service: every close is metadata-only, with no database, worktree
 * mutation, subprocess, or server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { runWithRequestContext, type RequestContextData } from '../../utils/request-context';

const { release, residual, claim, finalize, getSession, findStudio } = vi.hoisted(() => ({
  release: vi.fn(),
  residual: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(),
  getSession: vi.fn(),
  findStudio: vi.fn(),
}));
vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv },
  isDevelopment: () => false,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: 'user-1' } })),
}));
vi.mock('../../services/studio-settings', () => ({ ensureStudioSettings: vi.fn() }));
vi.mock('./inbox-handlers', () => ({ findOrCreateThread: vi.fn() }));
vi.mock('../../services/sessions/thread-assignment', () => ({ assignThreadParticipant: vi.fn() }));
// Mirror the production memory-handler wrapper; keep the actual shared
// identity resolver, ambient loader, and request context under test.
vi.mock('./memory-handlers', async () => {
  const { resolveCallerIdentity } = await import('./caller-identity');
  return {
    resolveCaller: async (_dc: unknown, _user: string, slug?: string) =>
      resolveCallerIdentity(slug),
    resolveImplicitSession: vi.fn(),
  };
});
vi.mock('../../services/studio-lease.service', async (original) => ({
  ...(await original<typeof import('../../services/studio-lease.service')>()),
  StudioLeaseService: class {
    releaseByStudio = release;
    getLease = residual;
    claimForTeardown = claim;
    finalizeTeardown = finalize;
  },
}));
// All probes are metadata-only and the lease class is stubbed: no real
// database, worktree mutation, subprocess, or application server is used.
import { handleCloseStudio } from './studio-handlers';

const STUDIO = '11111111-1111-4111-8111-111111111111';
const ownSession = { id: 'session-own', userId: 'user-1', sbSlug: 'lumen', sbId: 'sb-lumen' };
const ctx = {
  userId: 'user-1',
  agentTokenBound: true,
  tokenSlug: 'lumen',
  tokenSbId: 'sb-lumen',
  sessionId: 'session-own',
};
const dc = {
  getClient: () => ({}),
  repositories: { studios: { findById: findStudio }, memory: { getSession } },
} as unknown as DataComposer;
const close = (context?: Omit<RequestContextData, 'timestamp'>) => {
  const run = () =>
    handleCloseStudio(
      {
        studioId: STUDIO,
        sbSlug: 'typed-not-authority',
        removeWorktree: false,
        deleteBranch: false,
        sessionId: 'typed-not-ambient',
      },
      dc
    );
  return context ? runWithRequestContext(context, run) : run();
};

beforeEach(() => {
  vi.clearAllMocks();
  findStudio.mockResolvedValue({ id: STUDIO, userId: 'user-1' });
  getSession.mockImplementation(async (id: string) => ({ ...ownSession, id }));
  release.mockResolvedValue('deferred');
  residual.mockResolvedValue({ lease: null });
  claim.mockResolvedValue({ sessionId: 'claim-token' });
  finalize.mockResolvedValue(true);
});

describe('review: close handler identity boundary', () => {
  it('passes an authorized ambient holder, ignoring typed identity and session', async () => {
    release.mockResolvedValue('released');
    const result = await close(ctx);
    expect(release).toHaveBeenCalledWith(STUDIO, {
      userId: 'user-1',
      reason: 'studio-closed',
      callerSessionId: 'session-own',
    });
    expect(finalize).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });

  it('prefers the signed session over a conflicting header', async () => {
    await close({ ...ctx, tokenSessionId: 'signed-session', sessionId: 'header-session' });
    expect(getSession).toHaveBeenCalledWith('signed-session');
    expect(release.mock.calls[0][1].callerSessionId).toBe('signed-session');
  });

  it.each([
    ['different user', { userId: 'user-2' }],
    ['same slug but different canonical identity', { sbId: 'sb-other' }],
    ['different contact', { contactId: 'contact-other' }],
  ])('does not pass unauthorized ambient session: %s', async (_label, changes) => {
    getSession.mockResolvedValue({ ...ownSession, ...changes });
    await close(ctx);
    expect(release.mock.calls[0][1]).not.toHaveProperty('callerSessionId');
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not treat a canonical session as owned by a slug-only credential', async () => {
    await close({ ...ctx, tokenSbId: undefined });
    expect(release.mock.calls[0][1]).not.toHaveProperty('callerSessionId');
  });

  it('does not pass a nonexistent ambient session', async () => {
    getSession.mockResolvedValue(null);
    await close(ctx);
    expect(release.mock.calls[0][1]).not.toHaveProperty('callerSessionId');
  });

  it('falls back to old deferral on session lookup failure', async () => {
    getSession.mockRejectedValue(new Error('lookup unavailable'));
    await close(ctx);
    expect(release.mock.calls[0][1]).not.toHaveProperty('callerSessionId');
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not promote a typed sessionId without ambient context', async () => {
    await close();
    expect(getSession).not.toHaveBeenCalled();
    expect(release.mock.calls[0][1]).not.toHaveProperty('callerSessionId');
  });

  it('refuses cross-user studio before any session or lease lookup', async () => {
    findStudio.mockResolvedValue({ id: STUDIO, userId: 'user-2' });
    const result = await close(ctx);
    expect(JSON.parse(result.content[0].text).success).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('documents the legacy same-identity header assertion still accepted', async () => {
    await close({ ...ctx, sessionId: 'another-session-of-same-identity' });
    expect(release.mock.calls[0][1].callerSessionId).toBe('another-session-of-same-identity');
  });
});
