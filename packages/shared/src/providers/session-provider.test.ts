import { describe, expect, it, vi } from 'vitest';
import { createSessionProviderTurn, type SessionProviderPorts } from './session-provider.js';
import type { BackendHost } from './types.js';
import type { BackendRunResult } from './backend-runner.js';
import {
  ContextLedger,
  buildSessionPrompt,
  computeContextOccupancy,
  ledgerEntryPromptBytes,
  runAgentLoop,
  SbHookRegistry,
  SessionTurnCoordinator,
  type PreparedSessionTurn,
} from '../runtime/index.js';

const result = (over: Partial<BackendRunResult> = {}): BackendRunResult => ({
  success: true,
  stdout: 'hello',
  responseText: 'hello',
  stderr: '',
  exitCode: 0,
  durationMs: 3,
  command: 'fake provider',
  childExited: true,
  usage: { inputTokens: 10, outputTokens: 2 },
  ...over,
});
function harness(backend = 'claude', session = 'session-a') {
  const events: Record<string, unknown>[] = [];
  let mint = 0;
  let generation = 0;
  let mutating = 0;
  const ports: SessionProviderPorts = {
    runtime: {
      backend,
      toolRouting: 'local',
      toolMode: 'safe',
      strictTools: true,
      verbose: false,
      maxContextTokens: 100_000,
      activeSkills: [],
      bootstrapContext: 'identity bootstrap',
    },
    state: {},
    ledger: new ContextLedger(),
    sbSlug: 'echo',
    cliAttached: false,
    passthroughArgs: ['--tools', ''],
    dialogue: [],
    mintId: () => `${session}-seed-${++mint}`,
    append: (entry) => events.push(entry),
    buildEnvelope: (body, stamp) =>
      buildSessionPrompt('echo', ports.runtime, ports.ledger, body, 'local tools', stamp),
    measurement: () => undefined,
    spawnContext: () => ({
      inkSessionId: session,
      studioId: `studio-${session}`,
      workingDirectory: `/studios/${session}`,
      host: {} as BackendHost,
    }),
    attachmentDirs: () => ['/attachments'],
    startTurn: vi.fn(() => ({ result: Promise.resolve(result()), abort: vi.fn() })),
    onEvent: vi.fn(),
    beginSpawn: vi.fn(),
    endSpawn: vi.fn(),
    onAbortHandle: vi.fn(),
    onInitialSettled: vi.fn(),
    onInitialResult: vi.fn(),
    recordUsage: vi.fn(),
    sampleContext: vi.fn(),
    contextGeneration: () => generation,
    mutationsInFlight: () => mutating,
    notice: vi.fn(),
  };
  const prepared: PreparedSessionTurn = {
    input: { raw: 'question', source: 'user' },
    occupancy: computeContextOccupancy(0, 0, 100_000, undefined),
    promptHooks: { injected: 0, injectedEntries: [], evicted: 0, blocked: false },
  };
  const turn = () =>
    createSessionProviderTurn(
      ports,
      'question',
      [{ path: '/attachments/a.png', mimeType: 'image/png' }],
      prepared
    );
  return {
    ports,
    events,
    prepared,
    turn,
    mutate: () => {
      generation++;
    },
    setMutating: (n: number) => {
      mutating = n;
    },
  };
}

describe('shared session provider composition', () => {
  it('seeds once, resumes with recall delta, and carries explicit host routing and streams', async () => {
    const h = harness();
    const first = h.turn();
    expect(first.prompt).toContain('identity bootstrap');
    await first.runTurn(first.prompt, { isContinuation: false });
    expect(h.ports.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inkSessionId: 'session-a',
        studioId: 'studio-session-a',
        workingDirectory: '/studios/session-a',
        backendSessionSeedId: 'session-a-seed-1',
        deliverMedia: true,
        stream: true,
        onEvent: h.ports.onEvent,
      })
    );
    h.prepared.promptHooks.injectedEntries.push({
      role: 'system',
      content: 'recall me',
      source: 'passive-recall',
    });
    const second = h.turn();
    expect(second.prompt).toContain('recall me');
    expect(second.prompt).not.toContain('identity bootstrap');
    await second.runTurn(second.prompt, { isContinuation: false });
    expect(h.ports.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ backendSessionId: 'session-a-seed-1', deliverMedia: true })
    );
    expect(h.events).toHaveLength(1);
  });

  it('reseeds when shape changes, but adopts a recovered id with no in-process baseline', () => {
    const h = harness();
    h.ports.state.id = 'recovered';
    expect(h.turn().prompt).not.toContain('identity bootstrap');
    h.ports.runtime.activeSkills = [
      { name: 'review', source: 'task', content: 'review carefully' },
    ];
    const next = h.turn();
    expect(next.prompt).toContain('review carefully');
    expect(h.ports.state.id).toBe('session-a-seed-1');
  });

  it('records both failed-resume and reseed usage and delivers media to the replacement', async () => {
    const h = harness();
    h.ports.state.id = 'missing';
    vi.mocked(h.ports.startTurn)
      .mockReturnValueOnce({
        result: Promise.resolve(
          result({ success: false, stderr: 'Session not found', usage: { inputTokens: 4 } })
        ),
        abort: vi.fn(),
      })
      .mockReturnValueOnce({
        result: Promise.resolve(result({ usage: { inputTokens: 8 } })),
        abort: vi.fn(),
      });
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    expect(h.ports.recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 4 });
    expect(h.ports.recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 8 });
    expect(h.ports.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ backendSessionSeedId: 'session-a-seed-1', deliverMedia: true })
    );
    expect(vi.mocked(h.ports.startTurn).mock.calls[1][0].prompt).toContain('identity bootstrap');
    expect(h.ports.notice).toHaveBeenCalledWith('resume-missing');
    expect(t.lastRunResult.usage).toEqual({ inputTokens: 8 });
  });

  it.each([
    ['initial', 'throw'],
    ['initial', 'reject'],
    ['reseed', 'throw'],
    ['reseed', 'reject'],
    ['continuation', 'throw'],
    ['continuation', 'reject'],
  ] as const)('closes the %s spawn bracket when the provider %s fails', async (phase, failure) => {
    const h = harness();
    const error = new Error('host refused or provider failed');
    const fail = () => {
      if (failure === 'throw') throw error;
      return { result: Promise.reject(error), abort: vi.fn() };
    };
    if (phase === 'reseed') {
      h.ports.state.id = 'missing';
      vi.mocked(h.ports.startTurn).mockReturnValueOnce({
        result: Promise.resolve(result({ success: false, resumeFailedNoSession: true })),
        abort: vi.fn(),
      });
    }
    const t = h.turn();
    if (phase === 'continuation') {
      await t.runTurn(t.prompt, { isContinuation: false });
    }
    vi.mocked(h.ports.startTurn).mockImplementationOnce(fail);
    await expect(t.runTurn('body', { isContinuation: phase === 'continuation' })).rejects.toBe(
      error
    );
    const count = phase === 'initial' ? 1 : 2;
    expect(h.ports.startTurn).toHaveBeenCalledTimes(count);
    expect(h.ports.beginSpawn).toHaveBeenCalledTimes(count);
    expect(h.ports.endSpawn).toHaveBeenCalledTimes(count);
    expect(h.ports.onAbortHandle).toHaveBeenLastCalledWith(null);
    expect(h.ports.onInitialSettled).toHaveBeenCalledTimes(1);
    // Only completed attempts can contribute a result/usage sample.
    expect(h.ports.recordUsage).toHaveBeenCalledTimes(count - 1);
  });

  it('still closes the spawn bracket if the initial-settled observer throws', async () => {
    const h = harness();
    const error = new Error('observer failed');
    vi.mocked(h.ports.onInitialSettled).mockImplementationOnce(() => {
      throw error;
    });
    const t = h.turn();
    await expect(t.runTurn(t.prompt, { isContinuation: false })).rejects.toBe(error);
    expect(h.ports.endSpawn).toHaveBeenCalledTimes(1);
    expect(h.ports.onAbortHandle).toHaveBeenLastCalledWith(null);
  });

  it('does not reseed a missing resume after Stop, while retaining the first attempt usage', async () => {
    const h = harness();
    h.ports.state.id = 'missing';
    const stop = new AbortController();
    vi.mocked(h.ports.startTurn).mockImplementationOnce(() => {
      stop.abort();
      return {
        result: Promise.resolve(result({ success: false, resumeFailedNoSession: true })),
        abort: vi.fn(),
      };
    });
    const t = h.turn();
    const outcome = await t.runTurn(t.prompt, { isContinuation: false, signal: stop.signal });
    expect(outcome.success).toBe(false);
    expect(h.ports.startTurn).toHaveBeenCalledTimes(1);
    expect(h.ports.endSpawn).toHaveBeenCalledTimes(1);
    expect(h.ports.recordUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 2 });
    expect(h.ports.state.id).toBe('missing');
    expect(h.events).toEqual([]);
    expect(h.ports.notice).not.toHaveBeenCalled();
  });

  it('mid-turn eviction reseeds with the dialogue, then resumes without redelivering media', async () => {
    const h = harness();
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    h.ports.dialogue.push({ role: 'assistant', text: 'I will inspect it' });
    h.ports.state.id = undefined;
    h.ports.state.shape = undefined;
    await t.runTurn('tool result', { isContinuation: true });
    const seed = vi.mocked(h.ports.startTurn).mock.calls[1][0];
    expect(seed.backendSessionSeedId).toBe('session-a-seed-2');
    expect(seed.backendSessionId).toBeUndefined();
    expect(seed.deliverMedia).toBe(true);
    expect(seed.prompt).toContain('I will inspect it');
    expect(seed.prompt).toContain('tool result');
    await t.runTurn('another result', { isContinuation: true });
    const resumed = vi.mocked(h.ports.startTurn).mock.calls[2][0];
    expect(resumed.backendSessionId).toBe('session-a-seed-2');
    expect(resumed.deliverMedia).toBeUndefined();
    expect(h.events[1]).toMatchObject({ reason: 'mid-turn-roll', routing: 'local' });
  });

  it('stateless relay counts arrivals by id and invalidates on mutations, not net ledger size', async () => {
    const h = harness('codex');
    h.ports.ledger.addEntry('system', 'old context');
    let resolve!: (r: BackendRunResult) => void;
    vi.mocked(h.ports.startTurn).mockReturnValueOnce({
      result: new Promise((r) => {
        resolve = r;
      }),
      abort: vi.fn(),
    });
    const t = h.turn();
    const pending = t.runTurn(t.prompt, { isContinuation: false });
    h.ports.ledger.addEntry('system', 'new inbox arrival', 'inbox');
    resolve(result());
    await pending;
    const addition = h.ports.ledger.listEntries()[1];
    expect(t.relayOccupancy()).toBe(10 + ledgerEntryPromptBytes(addition));
    h.ports.ledger.evictEntries([h.ports.ledger.listEntries()[0].id]);
    expect(t.relayOccupancy()).toBe(10 + ledgerEntryPromptBytes(addition));
    h.setMutating(1);
    expect(t.relayOccupancy()).toBeUndefined();
    h.setMutating(0);
    h.mutate();
    expect(t.relayOccupancy()).toBeUndefined();
    expect(h.events).toHaveLength(0);
  });

  it('keeps concurrent sessions separate and exposes each current abort handle', async () => {
    const a = harness('claude', 'a');
    const b = harness('claude', 'b');
    const at = a.turn(),
      bt = b.turn();
    await Promise.all([
      at.runTurn(at.prompt, { isContinuation: false }),
      bt.runTurn(bt.prompt, { isContinuation: false }),
    ]);
    expect(a.ports.state.id).toBe('a-seed-1');
    expect(b.ports.state.id).toBe('b-seed-1');
    expect(a.ports.onAbortHandle).toHaveBeenNthCalledWith(1, expect.any(Function));
    expect(a.ports.onAbortHandle).toHaveBeenLastCalledWith(null);
    expect(a.ports.onInitialResult).toHaveBeenCalledTimes(1);
    expect(b.ports.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ inkSessionId: 'b', workingDirectory: '/studios/b' })
    );
  });

  it('composes the actual coordinator and loop through an injected read tool, without a CLI wrapper', async () => {
    const h = harness();
    const read = vi.fn(async () => [{ tool: 'read', result: 'file contents', status: 'executed' }]);
    vi.mocked(h.ports.startTurn)
      .mockReturnValueOnce({
        result: Promise.resolve(
          result({ responseText: '```ink-tool\n{"tool":"read","args":{"path":"sample.txt"}}\n```' })
        ),
        abort: vi.fn(),
      })
      .mockReturnValueOnce({
        result: Promise.resolve(result({ responseText: 'The file says hello.' })),
        abort: vi.fn(),
      });
    const coordinator = new SessionTurnCoordinator({
      ledger: h.ports.ledger,
      hooks: new SbHookRegistry(),
      log: { append: h.ports.append, flush: async () => {} },
      state: () => ({
        sbSlug: 'echo',
        backend: 'claude',
        maxContextTokens: 100_000,
        compactionInFlight: false,
      }),
      occupancy: () => h.prepared.occupancy,
      compact: async () => {},
      recordEviction: () => {},
    });
    const final = await coordinator.run(
      { raw: 'read sample.txt', source: 'user' },
      async (prepared) => {
        const provider = createSessionProviderTurn(h.ports, prepared.input.raw, [], prepared);
        const loop = await runAgentLoop(
          { prompt: provider.prompt, toolRouting: 'local' },
          {
            backend: { runTurn: provider.runTurn },
            tools: { execute: read },
            ui: { printLine: () => {}, printEvent: () => {}, startWaiting: () => () => {} },
          }
        );
        return { loop, backend: provider.lastRunResult, value: undefined };
      }
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(final?.execution.loop.assistantDisplayText).toBe('The file says hello.');
    expect(h.events.at(-1)).toMatchObject({ type: 'assistant', content: 'The file says hello.' });
  });
});
