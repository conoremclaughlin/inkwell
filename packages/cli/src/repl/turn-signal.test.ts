import { describe, it, expect, vi } from 'vitest';
import { createTurnSignal, turnMustFailClosed, type TurnSignalDeps } from './turn-signal.js';

/**
 * PR #506 P1 (Lumen, rounds 1–2): interactive Ink REPL turns never wrote the
 * hook-owned `cli_turn_at` marker, so `isSessionMidTurn` read false during a
 * live turn and the sweep completed a `pendingRelease` under a running REPL.
 * These tests pin the client half of the fix — what the REPL posts, on which
 * boundary — and its DIRECTIONAL failure semantics: an unacknowledged
 * turn-open must be reported (the caller fails closed for studio-backed
 * work); a failed stop is retried and backstopped by the exit detach.
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
    retryDelayMs: 0,
    ...overrides,
  };
  return { deps, fetchImpl: (overrides.fetchImpl as ReturnType<typeof vi.fn>) ?? fetchImpl };
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('createTurnSignal', () => {
  it('open() posts the prompt event and reports acknowledgement', async () => {
    const { deps, fetchImpl } = makeDeps();
    await expect(createTurnSignal(deps).open()).resolves.toBe(true);

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
    await expect(createTurnSignal(deps).close()).resolves.toBe(true);

    const body = bodyOf(fetchImpl);
    expect(body.event).toBe('stop');
    expect(body.lifecycle).toBe('idle');
  });

  it('detach() posts the process-proof cliAttached:false with no lifecycle value', async () => {
    const { deps, fetchImpl } = makeDeps();
    await expect(createTurnSignal(deps).detach()).resolves.toBe(true);

    const body = bodyOf(fetchImpl);
    expect(body).toEqual({ sessionId: 'sess-1', cliAttached: false, agentId: 'wren' });
  });

  it('does not post at all before a PCP session is attached — and reports safe', async () => {
    const { deps, fetchImpl } = makeDeps({ getSessionId: () => undefined });
    const signal = createTurnSignal(deps);
    await expect(signal.open()).resolves.toBe(true);
    await expect(signal.close()).resolves.toBe(true);
    await expect(signal.detach()).resolves.toBe(true);
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

  it('an unacknowledged open RETRIES once, then reports false — never silently unprotected', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const onDebug = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, onDebug });

    await expect(createTurnSignal(deps).open()).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDebug).toHaveBeenCalledWith(
      'turn_signal_post_error',
      expect.objectContaining({ label: 'open', attempt: 2 })
    );
  });

  it('a non-2xx open (auth/5xx while the sweep stays healthy) reports false', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    const onDebug = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, onDebug });

    await expect(createTurnSignal(deps).open()).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDebug).toHaveBeenCalledWith(
      'turn_signal_post_failed',
      expect.objectContaining({ label: 'open', attempt: 1 })
    );
  });

  it('a transient failure recovered by the retry still acknowledges', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return { ok: true, status: 200 } as Response;
    });
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(createTurnSignal(deps).open()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failed close resolves false without throwing — exit detach is the backstop', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(createTurnSignal(deps).close()).resolves.toBe(false);
  });

  it('omits the Authorization header when no token resolves', async () => {
    const { deps, fetchImpl } = makeDeps({ getToken: async () => undefined });
    await createTurnSignal(deps).open();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('turnMustFailClosed', () => {
  it('refuses a studio-backed turn whose open was not acknowledged', () => {
    expect(turnMustFailClosed(false, true)).toBe(true);
  });

  it('lets an acknowledged turn run', () => {
    expect(turnMustFailClosed(true, true)).toBe(false);
  });

  it('lets a studioless turn run best-effort — no lease to endanger', () => {
    expect(turnMustFailClosed(false, false)).toBe(false);
  });
});
