/**
 * What a reopen actually writes, as opposed to what the predicates think.
 *
 * session-ended-at.test.ts covers shouldStampEndedAt, shouldClearEndedAt and
 * isTerminalPhaseMarker, and every one of them was already correct while the
 * handler still left `current_phase` reading 'complete' (Lumen, r2). The
 * predicates answer "should this be cleared"; nothing asked "was it".
 *
 * The gap was a guard keyed off the caller's INPUT rather than the pending
 * WRITE. `phase: 'runtime:idle'` and `runtime:generating` are lifecycle in
 * disguise — the mapping sets `lifecycle` and deliberately writes no phase —
 * but `params.phase !== undefined` read them as a phase declaration and skipped
 * the clear. The CLI picker sends exactly that path.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleUpdateSessionState } from './memory-handlers';

vi.mock('../../services/user-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn().mockResolvedValue({
    user: { id: 'reopen-test-user' },
    resolvedBy: 'userId',
  }),
}));

vi.mock('../../utils/request-context', () => ({
  getPinnedSlug: vi.fn().mockReturnValue(null),
  getSessionContext: vi.fn().mockReturnValue(undefined),
  getRequestContext: vi.fn().mockReturnValue({
    userId: 'reopen-test-user',
    agentTokenBound: true,
    tokenSlug: 'test-sb',
    sbSlug: 'test-sb',
    callerProfile: 'agent',
    timestamp: new Date(),
  }),
  setSessionContext: vi.fn(),
  pinSessionAgent: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = '54100000-0000-4000-8000-000000000001';

/** A session that ended, carrying every terminal marker attachability reads. */
function finishedSession() {
  let row: Record<string, unknown> = {
    id: SESSION_ID,
    userId: 'reopen-test-user',
    sbSlug: 'test-sb',
    status: 'completed',
    lifecycle: 'completed',
    currentPhase: 'complete',
    endedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const updateSession = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    row = { ...row, ...updates };
    return row;
  });
  const composer = {
    repositories: {
      memory: {
        getSession: vi.fn(async () => row),
        updateSession,
      },
    },
  };
  return {
    get row() {
      return row;
    },
    updateSession,
    composer,
  };
}

async function callHandler(composer: unknown, params: Record<string, unknown>) {
  const result = await handleUpdateSessionState(
    { sessionId: SESSION_ID, sbSlug: 'test-sb', ...params },
    composer as never
  );
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe('a reopen clears every terminal marker in one write', () => {
  // The three shapes the CLI and its callers actually send. 'runtime:idle' is
  // the picker's own path, and it was the broken one.
  it.each([
    ['no phase at all', {}],
    ['phase runtime:idle', { phase: 'runtime:idle' }],
    ['phase runtime:generating', { phase: 'runtime:generating' }],
  ])('normalizes the persisted row with %s', async (_label, extra) => {
    const f = finishedSession();
    const response = await callHandler(f.composer, { reopen: true, ...extra });

    expect(response.success).toBe(true);
    // One write, not two: a row that is briefly un-ended but still phased
    // complete is visible to anything reading between them.
    expect(f.updateSession).toHaveBeenCalledTimes(1);

    expect(f.row.endedAt).toBeNull();
    expect(f.row.status).toBe('active');
    expect(f.row.currentPhase).toBeNull();
    expect(response.session.currentPhase).toBeNull();
  });

  it('reports the markers back so a client can verify the transition', async () => {
    // The CLI refuses to attach unless the response states the post-state, so
    // these two fields being present — null when cleared — is a contract, not a
    // convenience.
    const f = finishedSession();
    const response = await callHandler(f.composer, { reopen: true });

    expect(response.session).toHaveProperty('endedAt');
    expect(response.session).toHaveProperty('status');
    expect(response.session.endedAt).toBeNull();
    expect(response.session.status).toBe('active');
  });
});

describe('the clear never overwrites something the caller declared', () => {
  // The control, and the reason the guard is `updates.currentPhase === undefined`
  // rather than "always clear on reopen": a real phase is the agent's statement
  // about its own work, and nulling it would report progress nobody made.
  it('keeps a real phase the caller sent alongside the reopen', async () => {
    const f = finishedSession();
    const response = await callHandler(f.composer, { reopen: true, phase: 'reviewing' });

    expect(f.row.currentPhase).toBe('reviewing');
    expect(response.session.currentPhase).toBe('reviewing');
    // The other markers still clear — the phase is the only thing deferred to.
    expect(f.row.endedAt).toBeNull();
    expect(f.row.status).toBe('active');
  });

  it('keeps an explicit status the caller sent alongside the reopen', async () => {
    const f = finishedSession();
    await callHandler(f.composer, { reopen: true, status: 'paused' });

    expect(f.row.status).toBe('paused');
    expect(f.row.endedAt).toBeNull();
  });
});

describe('without a reopen, nothing is cleared', () => {
  // The control that stops the three cases above passing for the wrong reason.
  // If the clear ran on any update, a routine phase report would silently
  // resurrect a finished session — the opposite defect, and a worse one.
  it('leaves a finished row finished when only the phase is reported', async () => {
    const f = finishedSession();
    await callHandler(f.composer, { phase: 'implementing' });

    expect(f.row.endedAt).not.toBeNull();
    expect(f.row.status).toBe('completed');
    expect(f.row.currentPhase).toBe('implementing');
  });
});
