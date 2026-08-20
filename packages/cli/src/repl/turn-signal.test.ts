import { describe, it, expect, vi } from 'vitest';
import { createTurnSignal, type TurnSignalDeps } from './turn-signal.js';

/**
 * PR #506 P1 (Lumen): interactive Ink REPL turns never wrote the hook-owned
 * `cli_turn_at` marker, so `isSessionMidTurn` read false during a live turn
 * and the sweep completed a `pendingRelease` under a running REPL. These
 * tests pin the client half of the fix: what the REPL posts, on which
 * boundary, and that failures never break a turn.
 */

function makeDeps(overrides: Partial<TurnSignalDeps> = {}) {
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  const deps: TurnSignalDeps = {
    getSessionId: () => 'sess-1',
    agentId: 'wren',
    getServerUrl: () => 'http://localhost:3001/',
    getToken: async () => 'tok-abc',
    workingDir: '/work/tree',
    fetchImpl,
    ...overrides,
  };
  return { deps, fetchImpl: (overrides.fetchImpl as ReturnType<typeof vi.fn>) ?? fetchImpl };
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('createTurnSignal', () => {
  it('open() posts the prompt event that sets cli_turn_at and renews the lease', async () => {
    const { deps, fetchImpl } = makeDeps();
    await createTurnSignal(deps).open();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/hooks/lifecycle');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
    expect(bodyOf(fetchImpl)).toEqual({
      sessionId: 'sess-1',
      lifecycle: 'running',
      event: 'prompt',
      agentId: 'wren',
      workingDir: '/work/tree',
    });
  });

  it('close() posts the real stop event — the only boundary that clears the marker', async () => {
    const { deps, fetchImpl } = makeDeps();
    await createTurnSignal(deps).close();

    const body = bodyOf(fetchImpl);
    expect(body.event).toBe('stop');
    expect(body.lifecycle).toBe('idle');
  });

  it('does not post at all before a PCP session is attached', async () => {
    const { deps, fetchImpl } = makeDeps({ getSessionId: () => undefined });
    const signal = createTurnSignal(deps);
    await signal.open();
    await signal.close();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the session id live — a session attached after construction is used', async () => {
    let session: string | undefined;
    const { deps, fetchImpl } = makeDeps({ getSessionId: () => session });
    const signal = createTurnSignal(deps);
    await signal.open();
    expect(fetchImpl).not.toHaveBeenCalled();

    session = 'sess-late';
    await signal.open();
    expect(bodyOf(fetchImpl).sessionId).toBe('sess-late');
  });

  it('a rejected fetch never breaks the turn (non-fatal, hooks.ts posture)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const onDebug = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, onDebug });

    await expect(createTurnSignal(deps).open()).resolves.toBeUndefined();
    expect(onDebug).toHaveBeenCalledWith(
      'turn_signal_post_error',
      expect.objectContaining({ event: 'prompt', sessionId: 'sess-1' })
    );
  });

  it('a non-ok response resolves and is surfaced to debug, not thrown', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    const onDebug = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, onDebug });

    await expect(createTurnSignal(deps).close()).resolves.toBeUndefined();
    expect(onDebug).toHaveBeenCalledWith(
      'turn_signal_post_failed',
      expect.objectContaining({ event: 'stop', status: 403 })
    );
  });

  it('omits the Authorization header when no token resolves', async () => {
    const { deps, fetchImpl } = makeDeps({ getToken: async () => undefined });
    await createTurnSignal(deps).open();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
