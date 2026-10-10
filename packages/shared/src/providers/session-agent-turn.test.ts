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
