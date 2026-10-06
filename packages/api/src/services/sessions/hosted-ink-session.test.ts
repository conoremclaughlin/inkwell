/**
 * The in-process ink runner's side of the boundary (hosted-ink-session.ts):
 * what it refuses, what it hands the composition, and what it reports, with a
 * fake composition and fake provider launches. This is contract evidence, not
 * parity or a live run: the real composition is bound separately (pr:701).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_INK_REFUSALS,
  HostedInkSessionRunner,
  HostedLaunchRefused,
  HostedTurnRetired,
  parseHostedInkSbIds,
  selectInkRunner,
  type ExecuteHostedInkSession,
  type HostedInkSessionInput,
  type HostedInkSessionPorts,
  type HostedInkTurnDependencies,
  type ProviderTurnHandle,
} from './hosted-ink-session';
import type { ClaudeRunnerConfig, IRunner } from './types';

const SB_A = '5f2a9c4e-0d6b-4c1a-9f3e-7a8b1c2d3e4f';
const SB_B = '0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b';

function config(over: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
  return {
    workingDirectory: '/studio',
    inkSessionId: 'ink-session-1',
    turnEpoch: 'epoch-1',
    sbSlug: 'echo',
    ...over,
  } as ClaudeRunnerConfig;
}

class RefusedByHost extends Error {}

/** A launch whose settlement the test decides. */
function launch() {
  let settle!: (value: { childExited: boolean }) => void;
  let fail!: (error: unknown) => void;
  const result = new Promise<{ childExited: boolean }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  result.catch(() => undefined);
  const handle: ProviderTurnHandle & { abort: ReturnType<typeof vi.fn> } = {
    result,
    abort: vi.fn(),
  };
  return { handle, settle, fail };
}

function dependencies(over: Partial<HostedInkTurnDependencies> = {}): HostedInkTurnDependencies {
  return {
    inkwell: { callTool: vi.fn(async () => ({})) },
    startProviderTurn: vi.fn(() => {
      const l = launch();
      l.settle({ childExited: true });
      return l.handle;
    }),
    isHostedRefusal: (error) => error instanceof RefusedByHost,
    // SessionLog's shape: append returns the entry's eid synchronously.
    sessionLog: {
      append: vi.fn(() => 7),
      flush: vi.fn(async () => {}),
      read: vi.fn(async () => []),
    },
    deadlineAt: Date.now() + 60_000,
    ...over,
  };
}

function runner(
  execute: ExecuteHostedInkSession | undefined,
  deps = dependencies(),
  settleMs = 50
) {
  return new HostedInkSessionRunner({ execute, forTurn: () => deps, settleMs });
}

const succeed: ExecuteHostedInkSession = async (_input, ports) => {
  const handle = ports.provider.startTurn({ inkSessionId: 'ink-session-1' });
  await handle.result;
  return {
    success: true,
    responses: [{ channel: 'telegram', conversationId: 'c1', content: 'hi' } as never],
    finalTextResponse: 'hi',
    usage: { inputTokens: 3, outputTokens: 2 } as never,
    servedModel: 'claude-test-model',
    toolCalls: [],
  };
};

describe('parseHostedInkSbIds', () => {
  it('selects no one when unset or empty', () => {
    expect(parseHostedInkSbIds(undefined).size).toBe(0);
    expect(parseHostedInkSbIds(' , ').size).toBe(0);
  });

  it('takes canonical ids, trimmed and lowercased', () => {
    expect([...parseHostedInkSbIds(` ${SB_A.toUpperCase()} ,${SB_B}`)]).toEqual([SB_A, SB_B]);
  });

  it('refuses anything that is not a UUID, without echoing it', () => {
    expect(() => parseHostedInkSbIds(`${SB_A},echo`)).toThrow(/canonical sbIds/);
    expect(() => parseHostedInkSbIds(`${SB_A},echo`)).not.toThrow(/echo/);
  });
});

describe('selectInkRunner', () => {
  const hosted = { run: vi.fn() } as unknown as IRunner;
  const subprocess = { run: vi.fn() } as unknown as IRunner;

  it('runs a listed agent in process, by id in any case', () => {
    const selection = { runner: hosted, sbIds: parseHostedInkSbIds(SB_A) };
    expect(selectInkRunner(selection, subprocess, SB_A.toUpperCase())).toBe(hosted);
  });

  it('leaves everyone else, and the unconfigured server, on ink chat', () => {
    const selection = { runner: hosted, sbIds: parseHostedInkSbIds(SB_A) };
    expect(selectInkRunner(selection, subprocess, SB_B)).toBe(subprocess);
    expect(selectInkRunner(selection, subprocess, null)).toBe(subprocess);
    expect(selectInkRunner(undefined, subprocess, SB_A)).toBe(subprocess);
  });
});

describe('HostedInkSessionRunner', () => {
  it('refuses, starting nothing, while no composition or dependencies are bound', async () => {
    const forTurn = vi.fn(() => dependencies());
    for (const options of [{}, { forTurn }, { execute: succeed }]) {
      const result = await new HostedInkSessionRunner(options).run('hello', { config: config() });
      expect(result).toMatchObject({
        success: false,
        refusedBeforeSpawn: true,
        error: HOSTED_INK_REFUSALS.noExecutor,
      });
    }
    expect(forTurn).not.toHaveBeenCalled();
  });

  it('refuses a turn without its session or its admitted generation', async () => {
    const execute = vi.fn(succeed);
    for (const over of [{ inkSessionId: undefined }, { turnEpoch: undefined }]) {
      const result = await runner(execute).run('hello', { config: config(over) });
      expect(result).toMatchObject({
        refusedBeforeSpawn: true,
        error: HOSTED_INK_REFUSALS.unadmitted,
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks the caller’s admission first, and starts nothing when it refuses', async () => {
    const execute = vi.fn(succeed);
    const result = await runner(execute).run('hello', {
      config: config({ admitSpawn: () => 'held: a survivor may still be running' }),
    });
    expect(result).toMatchObject({
      refusedBeforeSpawn: true,
      error: 'held: a survivor may still be running',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses when the turn cannot be prepared', async () => {
    const execute = vi.fn(succeed);
    const result = await new HostedInkSessionRunner({
      execute,
      forTurn: () => {
        throw new Error('no token');
      },
    }).run('hello', { config: config() });
    expect(result.refusedBeforeSpawn).toBe(true);
    expect(result.error).toContain('no token');
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands the composition a frozen turn, and reports what it ran', async () => {
    const before = JSON.stringify(process.env);
    const cwd = process.cwd();
    let seen: { input: HostedInkSessionInput; ports: HostedInkSessionPorts } | undefined;
    const onTurnReply = vi.fn(async () => {});
    const result = await runner(async (input, ports) => {
      seen = { input, ports };
      return succeed(input, ports);
    }).run('hello', {
      config: config({ model: 'opus', channel: 'telegram', maxTurns: 3, onTurnReply }),
      mediaAttachments: [{ type: 'image', path: '/files/a.png', mimeType: 'image/png' }],
    });

    expect(result).toEqual({
      success: true,
      backendSessionId: 'ink-session-1',
      responses: [{ channel: 'telegram', conversationId: 'c1', content: 'hi' }],
      usage: { inputTokens: 3, outputTokens: 2 },
      servedModel: 'claude-test-model',
      finalTextResponse: 'hi',
      toolCalls: [],
    });
    expect(seen!.input).toEqual({
      sessionId: 'ink-session-1',
      turnEpoch: 'epoch-1',
      sbSlug: 'echo',
      workingDirectory: '/studio',
      message: 'hello',
      attachments: [{ path: '/files/a.png', mimeType: 'image/png' }],
      options: {
        model: 'opus',
        maxTurns: 3,
        toolRouting: 'local',
        profile: 'safe',
        away: true,
        messageLabel: 'telegram',
      },
    });
    expect(Object.isFrozen(seen!.input)).toBe(true);
    expect(Object.isFrozen(seen!.input.options)).toBe(true);
    expect(Object.isFrozen(seen!.ports)).toBe(true);
    // The reply port observes; the runner itself sends nothing.
    expect(typeof seen!.ports.output.onReply).toBe('function');
    expect(onTurnReply).not.toHaveBeenCalled();
    expect(JSON.stringify(process.env)).toBe(before);
    expect(process.cwd()).toBe(cwd);
  });

  it('asks the caller’s admission before each launch', async () => {
    let allowed = true;
    const deps = dependencies();
    const result = await runner(async (_input, ports) => {
      await ports.provider.startTurn({ inkSessionId: 'ink-session-1' }).result;
      allowed = false;
      expect(() => ports.provider.startTurn({ inkSessionId: 'ink-session-1' })).toThrow(
        HostedLaunchRefused
      );
      return { success: true, responses: [] };
    }, deps).run('hello', {
      config: config({ admitSpawn: () => (allowed ? undefined : 'fenced') }),
    });
    expect(deps.startProviderTurn).toHaveBeenCalledTimes(1);
    // The first launch was accepted: a later refusal does not erase it.
    expect(result.refusedBeforeSpawn).toBeUndefined();
  });

  it('reports refusedBeforeSpawn only when no launch was ever accepted', async () => {
    const refusingHost = dependencies({
      startProviderTurn: vi.fn(() => {
        const l = launch();
        l.fail(new RefusedByHost('no credential was minted'));
        return l.handle;
      }),
    });
    const tryOnce: ExecuteHostedInkSession = async (_input, ports) => {
      await ports.provider
        .startTurn({ inkSessionId: 'ink-session-1' })
        .result.catch(() => undefined);
      return { success: false, responses: [], error: 'the provider never started' };
    };
    const refused = await runner(tryOnce, refusingHost).run('hello', { config: config() });
    expect(refused).toMatchObject({
      success: false,
      refusedBeforeSpawn: true,
      error: 'no credential was minted',
    });

    const throwingHost = dependencies({
      startProviderTurn: vi.fn(() => {
        throw new Error('not admitted');
      }),
    });
    const thrown = await runner(async (_input, ports) => {
      ports.provider.startTurn({ inkSessionId: 'ink-session-1' });
      return { success: true, responses: [] };
    }, throwingHost).run('hello', { config: config() });
    expect(thrown).toMatchObject({ refusedBeforeSpawn: true, error: 'not admitted' });

    let first = true;
    const thenRefused = dependencies({
      startProviderTurn: vi.fn(() => {
        const l = launch();
        if (first) l.settle({ childExited: true });
        else l.fail(new RefusedByHost('deadline passed'));
        first = false;
        return l.handle;
      }),
    });
    const dispatched = await runner(async (_input, ports) => {
      await ports.provider.startTurn({ inkSessionId: 'ink-session-1' }).result;
      await ports.provider
        .startTurn({ inkSessionId: 'ink-session-1' })
        .result.catch(() => undefined);
      return { success: false, responses: [], error: 'continuation refused' };
    }, thenRefused).run('hello', { config: config() });
    expect(dispatched.refusedBeforeSpawn).toBeUndefined();
    expect(dispatched).toMatchObject({ success: false, error: 'continuation refused' });
  });

  it('stops every open launch on Stop, and waits for its real exit', async () => {
    const stop = new AbortController();
    const l = launch();
    l.handle.abort.mockImplementation(() => l.settle({ childExited: true }));
    const deps = dependencies({ startProviderTurn: vi.fn(() => l.handle) });
    const result = await runner(async (_input, ports) => {
      ports.provider.startTurn({ inkSessionId: 'ink-session-1' });
      stop.abort();
      expect(ports.signal.aborted).toBe(true);
      await l.handle.result;
      return { success: true, responses: [], finalTextResponse: 'partial' };
    }, deps).run('hello', { config: config({ signal: stop.signal }) });

    expect(l.handle.abort).toHaveBeenCalled();
    // A stopped turn keeps what it reported, and is never a success.
    expect(result).toMatchObject({
      success: false,
      finalTextResponse: 'partial',
      error: HOSTED_INK_REFUSALS.stopped,
    });
    expect(result.stopUnconfirmed).toBeUndefined();
  });

  it('is stopUnconfirmed when an exit is not proven: no result, a rejection, or no child exit', async () => {
    // [how the launch settles, whether it is still open when the turn returns]
    const cases: Array<[(l: ReturnType<typeof launch>) => void, boolean]> = [
      [() => undefined, true], // never settles within the bound
      [(l) => l.fail(new Error('stream broke')), false],
      [(l) => l.settle({ childExited: false }), false],
    ];
    for (const [settleWith, stillOpen] of cases) {
      const l = launch();
      settleWith(l);
      const result = await runner(
        async (_input, ports) => {
          ports.provider.startTurn({ inkSessionId: 'ink-session-1' });
          return { success: true, responses: [] };
        },
        dependencies({ startProviderTurn: vi.fn(() => l.handle) })
      ).run('hello', { config: config() });
      expect(result.stopUnconfirmed).toEqual({ leaderExited: false });
      expect(result.refusedBeforeSpawn).toBeUndefined();
      // Only a launch still open is stopped; a settled one has nothing left to stop.
      expect(l.handle.abort).toHaveBeenCalledTimes(stillOpen ? 1 : 0);
    }
  });

  it('reports a thrown composition as a failure, and stops what it left open', async () => {
    const l = launch();
    l.handle.abort.mockImplementation(() => l.settle({ childExited: true }));
    const result = await runner(
      async (_input, ports) => {
        ports.provider.startTurn({ inkSessionId: 'ink-session-1' });
        throw new Error('composition broke');
      },
      dependencies({ startProviderTurn: vi.fn(() => l.handle) })
    ).run('hello', { config: config() });
    expect(result).toEqual({
      success: false,
      backendSessionId: 'ink-session-1',
      responses: [],
      error: 'composition broke',
    });
    expect(l.handle.abort).toHaveBeenCalled();
  });

  it('reports nothing but the error for a failed turn that was not stopped', async () => {
    const result = await runner(async (input, ports) => {
      await succeed(input, ports);
      return {
        success: false,
        responses: [{ content: 'x' } as never],
        finalTextResponse: 'x',
        error: 'bad',
      };
    }).run('hello', { config: config() });
    expect(result).toEqual({
      success: false,
      backendSessionId: 'ink-session-1',
      responses: [],
      error: 'bad',
    });
  });
});

describe('HostedInkSessionRunner: the turn’s lifetime (Lumen’s #757 review)', () => {
  const request = { inkSessionId: 'ink-session-1' };
  const ok = { success: true, responses: [] };
  /** A composition that never returns until released. */
  function hanging() {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { pending, release };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts nothing for a turn already stopped when it arrives (R1)', async () => {
    const stop = new AbortController();
    stop.abort();
    const deps = dependencies();
    const forTurn = vi.fn(() => deps);
    const result = await new HostedInkSessionRunner({ forTurn, execute: succeed }).run('hi', {
      config: config({ signal: stop.signal }),
    });
    expect(result).toMatchObject({ success: false, refusedBeforeSpawn: true });
    expect(forTurn).not.toHaveBeenCalled();
    expect(deps.startProviderTurn).not.toHaveBeenCalled();
  });

  it('shuts launch admission on Stop, before stopping what is open (R1)', async () => {
    const stop = new AbortController();
    const deps = dependencies();
    let refusal: unknown;
    const result = await runner(async (_input, ports) => {
      stop.abort();
      try {
        ports.provider.startTurn(request);
      } catch (error) {
        refusal = error;
      }
      return ok;
    }, deps).run('hi', { config: config({ signal: stop.signal }) });
    expect(refusal).toBeInstanceOf(HostedLaunchRefused);
    expect(deps.startProviderTurn).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('retires every port when the turn returns (R2)', async () => {
    const deps = dependencies();
    const onTurnReply = vi.fn(async () => {});
    let kept!: HostedInkSessionPorts;
    await runner(async (_input, ports) => {
      kept = ports;
      return ok;
    }, deps).run('hi', { config: config({ onTurnReply }) });

    expect(() => kept.provider.startTurn(request)).toThrow(HostedLaunchRefused);
    await expect(kept.inkwell.callTool('recall', {}, { signal: kept.signal })).rejects.toThrow(
      HostedTurnRetired
    );
    expect(() => kept.sessionLog.append({ type: 'late' })).toThrow(HostedTurnRetired);
    await expect(kept.sessionLog.flush()).rejects.toThrow(HostedTurnRetired);
    await expect(kept.output.onReply!({ content: 'late' } as never)).rejects.toThrow(
      HostedTurnRetired
    );
    expect(kept.signal.aborted).toBe(true);
    expect(deps.startProviderTurn).not.toHaveBeenCalled();
    expect(deps.inkwell.callTool).not.toHaveBeenCalled();
    expect(deps.sessionLog.append).not.toHaveBeenCalled();
    expect(onTurnReply).not.toHaveBeenCalled();
  });

  it('forwards to the ports while the turn is open', async () => {
    const deps = dependencies();
    const onTurnReply = vi.fn(async () => {});
    await runner(async (_input, ports) => {
      await ports.inkwell.callTool('bootstrap', {}, { signal: ports.signal });
      expect(ports.sessionLog.append({ type: 'user' })).toBe(7);
      await ports.sessionLog.flush();
      await ports.output.onReply!({ content: 'hi' } as never);
      return ok;
    }, deps).run('hi', { config: config({ onTurnReply }) });
    expect(deps.inkwell.callTool).toHaveBeenCalledWith('bootstrap', {}, expect.anything());
    expect(deps.sessionLog.append).toHaveBeenCalledWith({ type: 'user' });
    expect(onTurnReply).toHaveBeenCalledTimes(1);
  });

  it('aborts the turn at its deadline (R3)', async () => {
    vi.useFakeTimers();
    const { pending, release } = hanging();
    let kept!: HostedInkSessionPorts;
    const deps = dependencies({ deadlineAt: Date.now() + 100 });
    const run = runner(
      async (_input, ports) => {
        kept = ports;
        await pending;
        return ok;
      },
      deps,
      10
    ).run('hi', { config: config() });
    await vi.advanceTimersByTimeAsync(150);
    expect(kept.signal.aborted).toBe(true);
    expect(() => kept.provider.startTurn(request)).toThrow(HostedLaunchRefused);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;
    release();
    expect(result).toMatchObject({ success: false, stopUnconfirmed: { leaderExited: false } });
    expect(result.error).toContain(HOSTED_INK_REFUSALS.deadline);
  });

  it('settles a stopped turn within its bound though the composition never returns (R3)', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const { pending, release } = hanging();
    let kept!: HostedInkSessionPorts;
    let completed = false;
    const run = runner(
      async (_input, ports) => {
        kept = ports;
        await pending;
        return ok;
      },
      dependencies(),
      10
    )
      .run('hi', { config: config({ signal: stop.signal }) })
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await vi.advanceTimersByTimeAsync(30);
    expect(completed).toBe(true);
    const result = await run;
    // Abandoned, not settled: unconfirmed, and every port already refuses.
    expect(result).toMatchObject({ success: false, stopUnconfirmed: { leaderExited: false } });
    expect(result.error).toContain(HOSTED_INK_REFUSALS.unsettled);
    expect(() => kept.provider.startTurn(request)).toThrow(HostedLaunchRefused);
    release();
  });

  it('abandons a preparation that a Stop or its own budget overtakes, starting nothing (R3)', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(succeed);
    const neverPrepared = () => new Promise<HostedInkTurnDependencies>(() => undefined);

    const stop = new AbortController();
    const stopped = new HostedInkSessionRunner({ execute, forTurn: neverPrepared }).run('hi', {
      config: config({ signal: stop.signal }),
    });
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stopped).toMatchObject({
      refusedBeforeSpawn: true,
      error: HOSTED_INK_REFUSALS.stopped,
    });

    const slow = new HostedInkSessionRunner({
      execute,
      forTurn: neverPrepared,
      prepareMs: 20,
    }).run('hi', { config: config() });
    await vi.advanceTimersByTimeAsync(25);
    expect(await slow).toMatchObject({ refusedBeforeSpawn: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs nothing for a turn stopped as its preparation resolves (R5)', async () => {
    const stop = new AbortController();
    const deps = dependencies();
    const execute = vi.fn(succeed);
    const result = await new HostedInkSessionRunner({
      execute,
      forTurn: async () => {
        stop.abort();
        return deps;
      },
    }).run('hi', { config: config({ signal: stop.signal }) });
    expect(result).toMatchObject({
      success: false,
      refusedBeforeSpawn: true,
      error: HOSTED_INK_REFUSALS.stopped,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(deps.inkwell.callTool).not.toHaveBeenCalled();
    expect(deps.startProviderTurn).not.toHaveBeenCalled();
  });

  it('runs nothing for a turn stopped after preparation but before the start (R5)', async () => {
    const stop = new AbortController();
    const deps = dependencies();
    const deadlineAt = deps.deadlineAt;
    // The deadline is first read after preparation and before the start, so
    // this Stop lands in that window, as any late close might.
    Object.defineProperty(deps, 'deadlineAt', {
      get: () => {
        stop.abort();
        return deadlineAt;
      },
    });
    const execute = vi.fn(succeed);
    const result = await runner(execute, deps).run('hi', {
      config: config({ signal: stop.signal }),
    });
    expect(stop.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      refusedBeforeSpawn: true,
      error: HOSTED_INK_REFUSALS.stopped,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a run whose deadline has already passed, or is not finite', async () => {
    const execute = vi.fn(succeed);
    for (const deadlineAt of [Date.now() - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await runner(execute, dependencies({ deadlineAt })).run('hi', {
        config: config(),
      });
      expect(result.refusedBeforeSpawn).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses budgets that are not finite and positive', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new HostedInkSessionRunner({ settleMs: value })).toThrow(RangeError);
      expect(() => new HostedInkSessionRunner({ prepareMs: value })).toThrow(RangeError);
    }
  });

  it('never reports success while a provider exit is unproven (R4)', async () => {
    const l = launch();
    l.settle({ childExited: false });
    const result = await runner(
      async (_input, ports) => {
        await ports.provider.startTurn(request).result;
        return { success: true, responses: [], finalTextResponse: 'done' };
      },
      dependencies({ startProviderTurn: vi.fn(() => l.handle) })
    ).run('hi', { config: config() });
    expect(result).toMatchObject({
      success: false,
      finalTextResponse: 'done',
      error: HOSTED_INK_REFUSALS.exitUnconfirmed,
      stopUnconfirmed: { leaderExited: false },
    });
  });
});
