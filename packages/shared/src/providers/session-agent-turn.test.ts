import { describe, expect, it, vi } from 'vitest';
import {
  ContextLedger,
  SbHookRegistry,
  SessionTurnCoordinator,
  buildSessionPrompt,
  computeContextOccupancy,
  type PreparedSessionTurn,
} from '../runtime/index.js';
import type { BackendRunRequest, BackendRunResult } from './backend-runner.js';
import type { BackendHost } from './types.js';
import { runSessionAgentTurn, type SessionAgentTurnPorts } from './session-agent-turn.js';
import type { SessionProviderPorts } from './session-provider.js';
import { SessionLog } from '../runtime/session-log.js';
import { createToolInvocationJournal } from '../runtime/tool-invocation-journal.js';
import type { SessionToolBatchPorts } from '../runtime/session-tool-batch.js';

const tool = (name: string, args: Record<string, unknown> = {}) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const result = (text: string, over: Partial<BackendRunResult> = {}): BackendRunResult => ({
  success: true,
  stdout: text,
  responseText: text,
  stderr: '',
  exitCode: 0,
  durationMs: 3,
  command: 'scripted provider, no process',
  childExited: true,
  usage: { backend: 'claude', source: 'json', inputTokens: 10, outputTokens: 2 },
  ...over,
});

function harness(results: BackendRunResult[], session = 'one') {
  const events: Record<string, unknown>[] = [];
  const order: string[] = [];
  let seed = 0;
  const provider: SessionProviderPorts = {
    runtime: {
      backend: 'claude',
      toolRouting: 'local',
      toolMode: 'safe',
      strictTools: true,
      verbose: false,
      maxContextTokens: 100_000,
      activeSkills: [{ name: 'review', source: 'task', content: 'Review the test fixtures.' }],
      bootstrapContext: `identity ${session}`,
    },
    state: {},
    ledger: new ContextLedger(),
    sbSlug: 'echo',
    cliAttached: false,
    passthroughArgs: ['--tools', ''],
    dialogue: [],
    mintId: () => `${session}-seed-${++seed}`,
    append: (event) => events.push(event),
    flush: vi.fn(async () => {}),
    buildEnvelope: (body, stamp) =>
      buildSessionPrompt('echo', provider.runtime, provider.ledger, body, 'local tools', stamp),
    measurement: () => undefined,
    spawnContext: () => ({
      inkSessionId: session,
      studioId: `studio-${session}`,
      workingDirectory: `/synthetic/${session}`,
      host: {} as BackendHost,
    }),
    attachmentDirs: () => undefined,
    startTurn: vi.fn((request: BackendRunRequest) => {
      order.push('provider');
      const next = results.shift();
      if (!next) throw new Error('Unscripted provider launch');
      request.onEvent?.({ kind: 'text-delta', text: next.responseText ?? '' });
      return { result: Promise.resolve(next), abort: vi.fn() };
    }),
    onEvent: vi.fn(),
    beginSpawn: vi.fn(),
    endSpawn: vi.fn(),
    onAbortHandle: vi.fn(),
    onInitialSettled: vi.fn(),
    onInitialResult: vi.fn(),
    recordUsage: vi.fn(),
    sampleContext: vi.fn(),
    contextGeneration: () => 0,
    mutationsInFlight: () => 0,
    notice: vi.fn(),
  };
  const ports: SessionAgentTurnPorts = {
    provider,
    ui: { printLine: vi.fn(), printEvent: vi.fn(), startWaiting: () => vi.fn() },
    tools: {
      screen: vi.fn((calls) => ({ calls })),
      execute: vi.fn<SessionAgentTurnPorts['tools']['execute']>(async (calls) => {
        order.push('tool');
        return calls.map((call) => ({ ...call, status: 'executed', result: 'fixture contents' }));
      }),
    },
    observe: { recordToolCall: vi.fn(), recordProtocolViolation: vi.fn() },
    rollProviderSession: vi.fn(() => {
      provider.state.id = undefined;
      provider.state.shape = undefined;
    }),
  };
  const occupancy = () => computeContextOccupancy(0, 0, 100_000, undefined);
  const prepared: PreparedSessionTurn = {
    input: { raw: 'read the fixture', source: 'user' },
    occupancy: occupancy(),
    promptHooks: { injected: 0, injectedEntries: [], evicted: 0, blocked: false },
  };
  const run = (signal?: AbortSignal, continueOnFailure = true, turn = prepared) =>
    runSessionAgentTurn(
      { raw: turn.input.raw, turnMedia: [], prepared: turn, signal, continueOnFailure },
      ports
    );
  return { provider, ports, run, events, order, prepared, occupancy };
}

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** No provider process, network, database or real tool dispatcher. */
function streamHarness(results: BackendRunResult[] = []) {
  const h = harness(results, 'synthetic-stream-session');
  const lines: string[] = [];
  const log = new SessionLog({
    path: '/synthetic/stream-turn.jsonl',
    sink: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  let invocation = 0;
  const journal = createToolInvocationJournal({
    sessionId: 'synthetic-stream-session',
    log,
    mintInvocationId: () => `synthetic-invocation-${++invocation}`,
  });
  const dispatched = gate<void>();
  const release = vi.fn();
  const batch: SessionToolBatchPorts = {
    sessionId: journal.sessionId,
    ledger: h.provider.ledger,
    log,
    policy: { canCallInkTool: vi.fn(() => ({ allowed: true, reason: 'fixture' })) },
    mintInvocationId: () => {
      throw new Error('Expected reserved invocation identity');
    },
    impossibleCallRefusal: () => null,
    callTool: vi.fn(async () => {
      dispatched.resolve();
      return { success: true };
    }),
    promptForApproval: vi.fn(async () => false),
    beginContextMutation: vi.fn(() => release),
    isHandoffTool: () => false,
    takeImages: vi.fn(() => []),
    onResult: vi.fn(),
  };
  const reportFailure = vi.fn(async () => {});
  h.ports.streamTools = { journal, ports: batch, turnId: 'synthetic-user-turn', reportFailure };
  let userTurns = 0;
  const run = (signal?: AbortSignal) => {
    userTurns++;
    return h.run(signal);
  };
  const events = () => lines.map((line) => JSON.parse(line));
  return {
    ...h,
    run,
    batch,
    log,
    journal,
    dispatched,
    release,
    reportFailure,
    events,
    counts: () => ({
      userTurns,
      providerRequests: vi.mocked(h.provider.startTurn).mock.calls.length,
    }),
  };
}

describe('opt-in provider-attempt stream composition', () => {
  it('dispatches before generation ends, dedupes completed text, and never batch-executes final extraction', async () => {
    const h = streamHarness([result('Done.')]);
    const providerEnd = gate<BackendRunResult>();
    const text = tool('send_response', { content: 'Synthetic progress.' }) + '\n';
    vi.mocked(h.provider.startTurn).mockImplementationOnce((request) => {
      request.onEvent?.({ kind: 'text-delta', text: text.slice(0, 17) });
      request.onEvent?.({ kind: 'text-delta', text: text.slice(17) });
      request.onEvent?.({ kind: 'text', text });
      request.onEvent?.({ kind: 'result', text });
      return { result: providerEnd.promise, abort: vi.fn() };
    });
    const running = h.run();
    await h.dispatched.promise;
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
    expect(h.events().some((event) => event.type === 'tool_intent')).toBe(true);
    providerEnd.resolve(result(text));
    const done = await running;
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 2 });
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
    expect(h.ports.tools.screen).not.toHaveBeenCalled();
    expect(done.loop.toolResults).toMatchObject([
      { tool: 'send_response', invocationId: 'synthetic-invocation-1', dispatchState: 'returned' },
    ]);
    expect(
      h.provider.ledger.listEntries().filter((entry) => entry.source === 'local-tool')
    ).toHaveLength(1);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(['exit', 'reject', 'missing-session'] as const)(
    'retains the committed prefix after provider %s without a retry',
    async (mode) => {
      const h = streamHarness();
      h.provider.state.id = 'synthetic-recovered-native';
      const providerEnd = gate<BackendRunResult>();
      const text = tool('send_response') + '\n';
      vi.mocked(h.provider.startTurn).mockImplementationOnce((request) => {
        request.onEvent?.({ kind: 'text-delta', text });
        return { result: providerEnd.promise, abort: vi.fn() };
      });
      const running = h.run();
      await h.dispatched.promise;
      if (mode === 'reject') providerEnd.reject(new Error('Synthetic provider rejection'));
      else
        providerEnd.resolve(
          result(text, { success: false, resumeFailedNoSession: mode === 'missing-session' })
        );
      const done = await running;
      expect(done.loop).toMatchObject({
        success: false,
        stopReason: 'backend-failure',
        toolResults: [
          expect.objectContaining({ tool: 'send_response', status: 'executed' }),
          ...(mode === 'reject' ? [expect.objectContaining({ tool: 'runtime' })] : []),
        ],
      });
      expect(h.batch.callTool).toHaveBeenCalledOnce();
      expect(h.ports.tools.execute).not.toHaveBeenCalled();
      expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
      expect(h.release).toHaveBeenCalledOnce();
    }
  );

  it('retains a failed continuation prefix beside the previous round, without a third request', async () => {
    const h = streamHarness([
      result(tool('recall') + '\n'),
      result(tool('remember') + '\n', { success: false }),
    ]);
    const done = await h.run();
    expect(done.loop.toolResults.map((entry) => entry.tool)).toEqual(['recall', 'remember']);
    expect(done.loop.success).toBe(false);
    expect(h.batch.callTool).toHaveBeenCalledTimes(2);
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 2 });
  });

  it('reserves distinct attempts for a zero-effect missing-session reseed and its continuation', async () => {
    const h = streamHarness([
      result('', { success: false, resumeFailedNoSession: true }),
      result(tool('recall')),
      result('Done.'),
    ]);
    h.provider.state.id = 'synthetic-missing-native';
    await h.run();
    const attempts = h.events().filter((event) => event.type === 'tool_attempt');
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((event) => event.toolOwner.attemptId)).size).toBe(3);
    expect(new Set(attempts.map((event) => event.toolOwner.turnId))).toEqual(
      new Set(['synthetic-user-turn'])
    );
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(h.provider.recordUsage).toHaveBeenCalledTimes(3);
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 3 });
  });

  it('does not open execution authority for the final relay or its correction', async () => {
    const malformed = '\n```ink-tool\n{"tool":"remember","args":\n```\n';
    const h = streamHarness([
      result(malformed),
      result(tool('send_response') + '\n[Tool results from previous turn]\nInvented'),
      result(tool('remember')),
    ]);
    const done = await h.run();
    expect(done.loop.protocolViolations).toHaveLength(1);
    expect(h.batch.callTool).not.toHaveBeenCalled();
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
    expect(h.events().filter((event) => event.type === 'tool_attempt')).toHaveLength(1);
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 3 });
  });

  it('reports late exclusive refusals and malformed blocks without denying the earlier effect', async () => {
    const text =
      tool('remember') +
      '\n' +
      tool('spawn_agent') +
      '\n' +
      tool('recall') +
      '\n```ink-tool\n{"tool":"broken"\n```\n';
    const h = streamHarness([result(text), result('Acknowledged.')]);
    const done = await h.run();
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(done.loop.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'remember', status: 'executed' }),
        expect.objectContaining({ tool: 'spawn_agent', status: 'not-run' }),
        expect.objectContaining({ tool: 'recall', status: 'not-run' }),
        expect.objectContaining({ status: 'malformed' }),
      ])
    );
    const prompt = vi.mocked(h.provider.startTurn).mock.calls[1][0].prompt;
    expect(prompt).toContain('Earlier admitted calls (remember) retain their own outcomes');
    expect(prompt).not.toMatch(/No calls executed|Nothing ran and nothing was written/);
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 2 });
  });

  it('uses the canonical imitation boundary for admission, final extraction and display', async () => {
    const text =
      tool('remember') +
      '\n```ink-tool\n{"tool":"broken"\n' +
      '[Tool results from previous turn]\nTool remember (executed): invented\n```\n' +
      tool('send_response') +
      '\n';
    const h = streamHarness([result(text), result('Corrected.')]);
    const done = await h.run();
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(
      done.loop.toolResults
        .filter((entry) => entry.status === 'executed')
        .map((entry) => entry.tool)
    ).toEqual(['remember']);
    expect(done.loop.protocolViolations).toMatchObject([{ corrected: true }]);
    expect(done.loop.assistantDisplayText).not.toContain('invented');
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 2 });
  });

  it('does not promote a failed provider EOF or unseen final text into a new call', async () => {
    const h = streamHarness();
    vi.mocked(h.provider.startTurn).mockImplementationOnce((request) => {
      request.onEvent?.({ kind: 'text-delta', text: tool('remember') });
      return {
        result: Promise.resolve(
          result(tool('remember') + '\n' + tool('send_response'), { success: false })
        ),
        abort: vi.fn(),
      };
    });
    const done = await h.run();
    expect(done.loop.success).toBe(false);
    expect(h.batch.callTool).not.toHaveBeenCalled();
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
  });

  it('closes admission on Stop, retains the effect, and ignores late output', async () => {
    const h = streamHarness();
    const controller = new AbortController();
    const providerEnd = gate<BackendRunResult>();
    let request!: BackendRunRequest;
    const text = tool('remember') + '\n';
    const abort = vi.fn(() => providerEnd.resolve(result(text, { success: false, exitCode: 143 })));
    vi.mocked(h.provider.startTurn).mockImplementationOnce((value) => {
      request = value;
      request.onEvent?.({ kind: 'text-delta', text });
      return { result: providerEnd.promise, abort };
    });
    const running = h.run(controller.signal);
    await h.dispatched.promise;
    controller.abort();
    request.onEvent?.({ kind: 'text-delta', text: tool('send_response') + '\n' });
    const done = await running;
    expect(done.loop).toMatchObject({
      stopReason: 'aborted',
      toolResults: [expect.objectContaining({ tool: 'remember' })],
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('alerts and refuses the turn when its journal cannot open, with no batch fallback', async () => {
    const h = streamHarness([result(tool('remember'))]);
    vi.spyOn(h.log, 'flush').mockRejectedValueOnce(
      new Error('Synthetic journal read/write failure')
    );
    await expect(h.run()).rejects.toThrow('Synthetic journal');
    expect(h.reportFailure).toHaveBeenCalledWith(expect.stringContaining('without batch fallback'));
    expect(h.provider.startTurn).not.toHaveBeenCalled();
    expect(h.batch.callTool).not.toHaveBeenCalled();
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
  });

  it('refuses a journal from another session before provider or tool work', async () => {
    const h = streamHarness();
    h.provider.spawnContext = () => ({
      host: {} as BackendHost,
      inkSessionId: 'synthetic-other-session',
    });
    await expect(h.run()).rejects.toThrow('same session');
    expect(h.reportFailure).toHaveBeenCalledOnce();
    expect(h.provider.startTurn).not.toHaveBeenCalled();
    expect(h.batch.callTool).not.toHaveBeenCalled();
  });

  it('refuses an already recovered attempt rather than replaying its text through batch execution', async () => {
    const h = streamHarness([result(tool('remember')), result('Done.')]);
    await h.run();
    const firstAttempt = h.events().find((event) => event.type === 'tool_attempt')
      .toolOwner.attemptId;
    h.ports.streamTools!.journal = createToolInvocationJournal({
      sessionId: h.journal.sessionId,
      log: h.log,
      mintInvocationId: () => 'synthetic-not-issued',
      recoveredEvents: h.events(),
    });
    h.provider.mintId = () => firstAttempt;
    await expect(h.run()).rejects.toThrow('never redispatch');
    expect(h.counts()).toEqual({ userTurns: 2, providerRequests: 2 });
    expect(h.batch.callTool).toHaveBeenCalledOnce();
    expect(h.reportFailure).toHaveBeenCalledOnce();
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
  });

  it('retains the known outcome and releases mutation ownership if outcome persistence throws', async () => {
    const h = streamHarness([result(tool('remember') + '\n')]);
    const append = h.log.append.bind(h.log);
    vi.spyOn(h.log, 'append').mockImplementation((event) => {
      if (event.type === 'local_tool_call') throw new Error('Synthetic outcome write failure');
      return append(event);
    });
    const done = await h.run();
    expect(done.loop.success).toBe(false);
    expect(done.loop.toolResults[0]).toMatchObject({ tool: 'remember', status: 'executed' });
    expect(h.reportFailure).toHaveBeenCalledWith(expect.stringContaining('outcome write failure'));
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
  });

  it.each(['initial-result', 'usage', 'images', 'abort-clear', 'spawn-end'] as const)(
    'retains the stream outcomes when provider settlement fails at %s',
    async (stage) => {
      const h = streamHarness([result(tool('remember') + '\n')]);
      const fail = () => {
        throw new Error('Synthetic provider settlement failure');
      };
      if (stage === 'initial-result') h.provider.onInitialResult = fail;
      else if (stage === 'usage') h.provider.recordUsage = fail;
      else if (stage === 'images') h.provider.noteImagesDelivered = fail;
      else if (stage === 'spawn-end') h.provider.endSpawn = fail;
      else
        h.provider.onAbortHandle = (abort) => {
          if (abort === null) fail();
        };
      const done = await h.run();
      expect(done.loop.success).toBe(false);
      expect(done.loop.toolResults[0]).toMatchObject({ tool: 'remember', status: 'executed' });
      expect(h.reportFailure).toHaveBeenCalledWith(expect.stringContaining('settlement failure'));
      expect(h.batch.callTool).toHaveBeenCalledOnce();
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
    }
  );

  it.each(['opening-flush', 'intent-flush', 'approval'] as const)(
    'Stop at %s never dispatches and retains the owner until settlement',
    async (stage) => {
      const h = streamHarness();
      const controller = new AbortController();
      const reached = gate<void>();
      const resume = gate<void>();
      const providerEnd = gate<BackendRunResult>();
      const text = tool('remember') + '\n';
      const flush = h.log.flush.bind(h.log);
      let flushes = 0;
      vi.spyOn(h.log, 'flush').mockImplementation(async () => {
        if (++flushes === (stage === 'opening-flush' ? 1 : stage === 'intent-flush' ? 2 : -1)) {
          reached.resolve();
          await resume.promise;
        }
        return flush();
      });
      if (stage === 'approval') {
        vi.mocked(h.batch.policy.canCallInkTool).mockReturnValue({
          allowed: false,
          promptable: true,
          reason: 'fixture approval',
        });
        vi.mocked(h.batch.promptForApproval).mockImplementation(async () => {
          reached.resolve();
          await resume.promise;
          return true;
        });
      }
      vi.mocked(h.provider.startTurn).mockImplementationOnce((request) => {
        request.onEvent?.({ kind: 'text-delta', text });
        return {
          result: providerEnd.promise,
          abort: () => providerEnd.resolve(result(text, { success: false })),
        };
      });
      const running = h.run(controller.signal);
      await reached.promise;
      controller.abort();
      expect(h.batch.callTool).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      resume.resolve();
      const done = await running;
      expect(done.loop.stopReason).toBe('aborted');
      expect(h.batch.callTool).not.toHaveBeenCalled();
      expect(h.counts()).toEqual({
        userTurns: 1,
        providerRequests: stage === 'opening-flush' ? 0 : 1,
      });
      expect(h.release).toHaveBeenCalledTimes(stage === 'opening-flush' ? 0 : 1);
    }
  );

  it('joins the launched provider after a host abort-registration callback throws', async () => {
    const h = streamHarness();
    const end = gate<BackendRunResult>();
    const abort = vi.fn(() => end.resolve(result('Stopped.')));
    vi.mocked(h.provider.startTurn).mockReturnValueOnce({ result: end.promise, abort });
    vi.mocked(h.provider.onAbortHandle).mockImplementationOnce(() => {
      throw new Error('Synthetic callback failure');
    });
    const done = await h.run();
    expect(done.loop.success).toBe(false);
    expect(done.backend.childExited).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(h.reportFailure).toHaveBeenCalledOnce();
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
  });

  it('never retries an unknown tool effect, even when ordinary failure continuation is enabled', async () => {
    const h = streamHarness([result(tool('send_response') + '\n')]);
    vi.mocked(h.batch.callTool).mockRejectedValueOnce(new Error('Synthetic lost receipt'));
    const done = await h.run();
    expect(done.loop.success).toBe(false);
    expect(done.loop.toolResults[0]).toMatchObject({
      tool: 'send_response',
      dispatchState: 'unknown',
    });
    expect(h.reportFailure).toHaveBeenCalledWith(expect.stringContaining('unknown outcome'));
    expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
  });

  it.each(['changed-final', 'changed-frame', 'second-message'] as const)(
    'fails closed on %s while retaining the effect already admitted',
    async (mode) => {
      const h = streamHarness();
      const end = gate<BackendRunResult>();
      const prefix = tool('remember') + '\n';
      let request!: BackendRunRequest;
      vi.mocked(h.provider.startTurn).mockImplementationOnce((value) => {
        request = value;
        request.onEvent?.({ kind: 'text-delta', text: prefix });
        return { result: end.promise, abort: vi.fn(() => end.resolve(result(prefix))) };
      });
      const running = h.run();
      await h.dispatched.promise;
      if (mode === 'changed-final') end.resolve(result(tool('send_response')));
      else {
        if (mode === 'second-message') request.onEvent?.({ kind: 'text', text: prefix });
        request.onEvent?.({ kind: 'text', text: tool('send_response') + '\n' });
      }
      const done = await running;
      expect(done.loop.success).toBe(false);
      expect(done.loop.toolResults[0]).toMatchObject({ tool: 'remember', status: 'executed' });
      expect(h.batch.callTool).toHaveBeenCalledOnce();
      expect(h.reportFailure).toHaveBeenCalledOnce();
      expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 1 });
    }
  );

  it('dedupes continued content blocks and accepts a successful buffered provider snapshot', async () => {
    for (const streamed of [true, false]) {
      const text = 'Checking.\n' + tool('recall') + '\n';
      const h = streamHarness([result('Done.')]);
      vi.mocked(h.provider.startTurn).mockImplementationOnce((request) => {
        if (streamed) {
          request.onEvent?.({ kind: 'text', text: 'Checking.\n' });
          request.onEvent?.({ kind: 'text-delta', text: tool('recall') + '\n' });
          request.onEvent?.({ kind: 'text', text: tool('recall') + '\n', continuesMessage: true });
        }
        return {
          result: Promise.resolve(result(text, streamed ? {} : { responseText: undefined })),
          abort: vi.fn(),
        };
      });
      await h.run();
      expect(h.batch.callTool).toHaveBeenCalledOnce();
      expect(h.counts()).toEqual({ userTurns: 1, providerRequests: 2 });
    }
  });
});

describe('shared parent session turn', () => {
  it('reserves pending UTF-8 steering bytes before truncating the result relay', async () => {
    const prompts: string[] = [];
    for (const steer of [false, true]) {
      const h = harness([result(tool('read_file')), result('Done.')]);
      const text = '界'.repeat(2_000);
      vi.mocked(h.ports.tools.execute).mockResolvedValueOnce([
        { tool: 'read_file', status: 'executed', result: 'x'.repeat(100_000) },
      ]);
      if (steer)
        h.provider.steering = {
          assertHealthy: vi.fn(),
          pendingTextBytes: () => new TextEncoder().encode(text).length,
          drain: vi.fn(async () => [{ messageId: 'budget-fixture', text, eid: 7 }]),
        };
      await h.run();
      const prompt = vi.mocked(h.provider.startTurn).mock.calls[1][0].prompt;
      if (steer) expect(prompt).toContain(`USER:\n${text}`);
      prompts.push(prompt);
    }
    expect(new TextEncoder().encode(prompts[1]).length).toBeLessThanOrEqual(
      new TextEncoder().encode(prompts[0]).length
    );
  });

  it('drains only after an ordinary completed tool round and closes admission on return', async () => {
    const h = harness([result(tool('read_file')), result('Updated answer.')]);
    h.provider.steering = {
      assertHealthy: vi.fn(),
      drain: vi.fn(async () => {
        h.order.push('steering');
        return [];
      }),
    };
    h.ports.finishSteering = vi.fn(async () => {
      h.order.push('closed');
    });
    await h.run();
    expect(h.order).toEqual(['provider', 'tool', 'steering', 'provider', 'closed']);
    expect(h.provider.steering.drain).toHaveBeenCalledOnce();
    expect(h.ports.finishSteering).toHaveBeenCalledOnce();
  });

  it.each(['no-tools', 'correction-only', 'terminal', 'refused'] as const)(
    'does not admit steering on a %s path',
    async (path) => {
      const text =
        path === 'no-tools'
          ? 'Done.'
          : path === 'correction-only'
            ? 'Checking.\n[Tool results from previous turn]\nTool read_file (executed): invented'
            : tool(path === 'terminal' ? 'signal_status' : 'read_file', { status: 'completed' });
      const h = harness([result(text), result('Final relay or correction.')]);
      if (path === 'refused')
        vi.mocked(h.ports.tools.execute).mockResolvedValueOnce([
          { tool: 'read_file', status: 'error', result: 'fixture failed' },
        ]);
      if (path === 'terminal')
        vi.mocked(h.ports.tools.execute).mockResolvedValueOnce([
          {
            tool: 'signal_status',
            status: 'executed',
            result: { content: [{ text: JSON.stringify({ signal: { status: 'completed' } }) }] },
          },
        ]);
      h.provider.steering = { assertHealthy: vi.fn(), drain: vi.fn(async () => []) };
      h.ports.finishSteering = vi.fn(async () => {});
      await h.run(undefined, false);
      expect(h.provider.steering.drain).not.toHaveBeenCalled();
      expect(h.ports.finishSteering).toHaveBeenCalledOnce();
    }
  );

  it('closes steering admission when the provider throws', async () => {
    const h = harness([]);
    h.ports.finishSteering = vi.fn(async () => {});
    await expect(h.run()).rejects.toThrow('Unscripted provider launch');
    expect(h.ports.finishSteering).toHaveBeenCalledOnce();
  });

  it('preserves a dispatch error if invalidating steered native history also fails', async () => {
    const h = harness([result(tool('read_file'))]);
    h.provider.steering = {
      assertHealthy: vi.fn(),
      drain: vi.fn(async () => [{ messageId: 'fixture-input', text: 'Use the update.', eid: 4 }]),
    };
    h.ports.rollProviderSession = vi.fn(() => {
      throw new Error('fixture log failure');
    });
    await expect(h.run()).rejects.toThrow('Unscripted provider launch');
    expect(h.ports.rollProviderSession).toHaveBeenCalledWith(
      'steering-delivery-uncertain',
      expect.any(String)
    );
    expect(h.provider.state.id).toBeUndefined();
  });

  it('composes the real coordinator, recall, provider, tool continuation and committed reply', async () => {
    const h = harness([result(tool('read_file')), result('Read the fixture.')]);
    const hooks = new SbHookRegistry();
    hooks.register({
      name: 'fixture recall',
      event: 'prompt_build',
      handler: async () => ({
        inject: [{ role: 'system', source: 'passive-recall', content: 'Recall fixture evidence.' }],
      }),
    });
    const log = {
      append: (event: Record<string, unknown>) => {
        h.order.push(`append:${event.type}`);
        return h.events.push(event);
      },
      flush: async () => {
        h.order.push('flush');
      },
    };
    const coordinator = new SessionTurnCoordinator({
      ledger: h.provider.ledger,
      hooks,
      log,
      occupancy: h.occupancy,
      state: () => ({
        sessionId: 'one',
        sbSlug: 'echo',
        backend: 'claude',
        maxContextTokens: 100_000,
        compactionInFlight: false,
      }),
      compact: async () => {
        h.order.push('compact');
      },
      recordEviction: vi.fn(),
    });
    const completed = await coordinator.run(
      h.prepared.input,
      async (turn) => ({ ...(await h.run(undefined, true, turn)), value: undefined }),
      () => {
        h.order.push('reply');
      }
    );
    expect(completed?.execution.loop.assistantDisplayText).toBe('Read the fixture.');
    const requests = vi.mocked(h.provider.startTurn).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[0].prompt).toContain('Recall fixture evidence.');
    expect(requests[0].prompt).toContain('Review the test fixtures.');
    expect(requests[0].prompt).toContain('identity one');
    expect(requests[1].prompt).toContain('fixture contents');
    expect(requests[1].backendSessionId).toBe(requests[0].backendSessionSeedId);
    expect(h.order.indexOf('flush')).toBeLessThan(h.order.indexOf('provider'));
    expect(
      h.order.slice(h.order.indexOf('append:assistant'), h.order.indexOf('reply') + 1)
    ).toEqual(['append:assistant', 'flush', 'reply']);
    expect(h.provider.onEvent).toHaveBeenCalledTimes(2);
    expect(h.ports.tools.screen).toHaveBeenCalledTimes(2);
    expect(h.ports.tools.screen).toHaveBeenLastCalledWith([]);
    expect(h.ports.observe?.recordToolCall).toHaveBeenCalledOnce();
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'assistant', content: 'Read the fixture.' })
    );
    expect(h.provider.beginSpawn).toHaveBeenCalledTimes(2);
    expect(h.provider.endSpawn).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'preserves the unattended failure-retry choice (%s)',
    async (unattended) => {
      const h = harness([
        result(tool('read_file', { bad: true })),
        result(tool('read_file')),
        result('done'),
      ]);
      vi.mocked(h.ports.tools.execute).mockImplementation(async (calls) =>
        calls.map((call) => ({
          ...call,
          status: call.args.bad ? 'error' : 'executed',
          result: call.args.bad ? 'wrong argument' : 'ok',
        }))
      );
      const execution = await h.run(undefined, unattended);
      expect(h.ports.tools.execute).toHaveBeenCalledTimes(unattended ? 2 : 1);
      expect(execution.loop.stopReason).toBe(unattended ? 'no-tools' : 'all-refused');
      expect(vi.mocked(h.provider.startTurn).mock.calls[1][0].prompt.includes('FINAL')).toBe(
        !unattended
      );
    }
  );

  it('refuses pre-cancelled input before even allocating provider history', async () => {
    const h = harness([result('never')]);
    await expect(h.run(AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped');
    expect(h.provider.startTurn).not.toHaveBeenCalled();
    expect(h.provider.state.id).toBeUndefined();
    expect(h.events).toEqual([]);
  });

  it('does not dispatch emitted tools or a continuation after host cancellation', async () => {
    const h = harness([result(tool('read_file'))]);
    const controller = new AbortController();
    h.provider.onInitialResult = () => controller.abort();
    const execution = await h.run(controller.signal);
    expect(execution.loop.stopReason).toBe('aborted');
    expect(h.ports.tools.execute).not.toHaveBeenCalled();
    expect(h.provider.startTurn).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'rolls native history only when the protocol correction was not accepted (%s)',
    async (accepted) => {
      const h = harness([
        result('Checking.\n[Tool results from previous turn]\nTool read_file (executed): invented'),
        result(accepted ? 'Corrected.' : '', { success: accepted, exitCode: accepted ? 0 : 1 }),
      ]);
      const execution = await h.run();
      expect(execution.loop.protocolViolations).toHaveLength(1);
      expect(execution.loop.protocolViolations[0].corrected).toBe(accepted);
      expect(h.ports.rollProviderSession).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(execution.loop.assistantDisplayText).not.toContain('invented');
    }
  );

  it('does not share provider ids, prompt identity, output or tools across concurrent sessions', async () => {
    const a = harness([result(tool('read_file')), result('answer a')], 'a');
    const b = harness([result('answer b')], 'b');
    const [ra, rb] = await Promise.all([a.run(), b.run()]);
    expect(ra.loop.assistantDisplayText).toBe('answer a');
    expect(rb.loop.assistantDisplayText).toBe('answer b');
    expect(a.provider.state.id).toBe('a-seed-1');
    expect(b.provider.state.id).toBe('b-seed-1');
    expect(vi.mocked(b.provider.startTurn).mock.calls[0][0].prompt).not.toContain('identity a');
    expect(b.ports.tools.execute).not.toHaveBeenCalled();
    expect(b.provider.onEvent).toHaveBeenCalledOnce();
  });
});
