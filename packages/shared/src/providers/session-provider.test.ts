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
  usage: { backend: 'claude', source: 'json', inputTokens: 10, outputTokens: 2 },
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
    flush: vi.fn(async () => {}),
    buildEnvelope: (body, stamp, excludeEids) =>
      buildSessionPrompt(
        'echo',
        ports.runtime,
        ports.ledger,
        body,
        'local tools',
        stamp,
        excludeEids
      ),
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
  it.each(['success', 'failed', 'throw', 'unconfirmed-exit', 'recovery-disabled'] as const)(
    'keeps a seed containing retained steering unrecoverable until confirmed success (%s)',
    async (path) => {
      const h = harness();
      h.ports.ledger.addEntry('user', 'Retained owner correction.', 'steering', 4);
      if (path === 'recovery-disabled') h.ports.runtime.providerRecoveryDisabled = true;
      const t = h.turn();
      expect(h.events.at(-1)).toMatchObject({ type: 'backend_session', recoverable: false });
      if (path === 'throw')
        vi.mocked(h.ports.startTurn).mockImplementationOnce(() => {
          throw new Error('seed launch refused');
        });
      else
        vi.mocked(h.ports.startTurn).mockReturnValueOnce({
          result: Promise.resolve(
            result({ success: path !== 'failed', childExited: path !== 'unconfirmed-exit' })
          ),
          abort: vi.fn(),
        });
      if (path === 'throw')
        await expect(t.runTurn(t.prompt, { isContinuation: false })).rejects.toThrow(
          'seed launch refused'
        );
      else await t.runTurn(t.prompt, { isContinuation: false });
      const confirmed = h.events.filter(
        (event) => event.type === 'backend_session' && event.recoverable === true
      );
      expect(confirmed).toHaveLength(path === 'success' ? 1 : 0);
      if (path === 'success')
        expect(confirmed[0]).toMatchObject({
          id: h.ports.state.id,
          reason: 'steering-seed-confirmed',
        });
    }
  );

  it.each(['resume', 'seed', 'stateless'] as const)(
    'inserts owner text once, after its tool results, on %s continuations',
    async (mode) => {
      const h = harness(mode === 'stateless' ? 'codex' : 'claude');
      h.ports.ledger.addEntry('user', 'prior-turn correction', 'steering', 3);
      let count = 0;
      h.ports.steering = {
        assertHealthy: vi.fn(),
        drain: vi.fn(async () => {
          const text = `correction marker ${++count}`;
          const eid = 100 + count;
          h.ports.ledger.addEntry('user', text, 'steering', eid);
          return [{ messageId: `input-${count}`, text, eid }];
        }),
      };
      const t = h.turn();
      await t.runTurn(t.prompt, { isContinuation: false });
      h.ports.dialogue.push({ role: 'assistant', text: 'first request marker' });
      if (mode === 'seed') h.ports.state.id = undefined;
      await t.runTurn('first result marker', { isContinuation: true, completedToolRound: true });
      const first = vi.mocked(h.ports.startTurn).mock.calls[1][0].prompt;
      expect(first.split('correction marker 1')).toHaveLength(2);
      expect(first.indexOf('first result marker')).toBeLessThan(
        first.indexOf('correction marker 1')
      );
      expect(first).toContain('USER:\ncorrection marker 1');
      if (mode !== 'resume') expect(first).toContain('prior-turn correction');
      h.ports.dialogue.push({ role: 'assistant', text: 'second request marker' });
      if (mode === 'seed') h.ports.state.id = undefined;
      await t.runTurn('second result marker', { isContinuation: true, completedToolRound: true });
      const second = vi.mocked(h.ports.startTurn).mock.calls[2][0].prompt;
      expect(second.split('correction marker 2')).toHaveLength(2);
      if (mode === 'resume') expect(second).not.toContain('correction marker 1');
      else {
        expect(second.split('correction marker 1')).toHaveLength(2);
        expect(second.indexOf('correction marker 1')).toBeLessThan(
          second.indexOf('second request marker')
        );
        expect(second.indexOf('second request marker')).toBeLessThan(
          second.indexOf('second result marker')
        );
      }
      expect(second.indexOf('second result marker')).toBeLessThan(
        second.indexOf('correction marker 2')
      );
      expect(h.ports.ledger.listEntries().filter((e) => e.source === 'steering')).toHaveLength(3);
      // The next ordinary turn uses the retained ledger rather than inheriting
      // this turn's transient exclusion set.
      h.ports.state.id = undefined;
      const nextPrompt = h.turn().prompt;
      expect(nextPrompt).toContain('correction marker 1');
      expect(nextPrompt).toContain('correction marker 2');
    }
  );

  it('does not drain on opening, correction-only or final-relay continuations', async () => {
    const h = harness();
    h.ports.steering = { assertHealthy: vi.fn(), drain: vi.fn(async () => []) };
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    await t.runTurn('final relay', { isContinuation: true });
    expect(h.ports.steering.drain).not.toHaveBeenCalled();
  });

  it('stops before continuation dispatch when steering persistence is uncertain', async () => {
    const h = harness();
    h.ports.steering = {
      assertHealthy: vi.fn(),
      drain: vi.fn(async () => {
        throw new Error('uncertain steering write');
      }),
    };
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    await expect(
      t.runTurn('result', { isContinuation: true, completedToolRound: true })
    ).rejects.toThrow('uncertain steering write');
    expect(h.ports.startTurn).toHaveBeenCalledOnce();
  });

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

  it('asks for images against each exact opening, resume, and rolled continuation session', async () => {
    const h = harness();
    const images = [{ path: '/context/tool.png', mimeType: 'image/png' }];
    h.ports.contextImagesFor = vi.fn(() => images);
    h.ports.noteImagesDelivered = vi.fn();
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    await t.runTurn('first tool result', { isContinuation: true });
    h.ports.state.id = undefined;
    h.ports.state.shape = undefined;
    await t.runTurn('after eviction', { isContinuation: true });
    expect(vi.mocked(h.ports.contextImagesFor).mock.calls.map(([id]) => id)).toEqual([
      'session-a-seed-1',
      'session-a-seed-1',
      'session-a-seed-2',
    ]);
    for (const [request] of vi.mocked(h.ports.startTurn).mock.calls) {
      expect(request.contextImages).toBe(images);
    }
    expect(h.ports.noteImagesDelivered).toHaveBeenLastCalledWith(
      'session-a-seed-2',
      expect.objectContaining({ success: true })
    );
  });

  it('reports actual adapter delivery (including failure), and asks afresh after a missing resume', async () => {
    const h = harness();
    h.ports.state.id = 'missing';
    const offered = [{ path: '/context/offered.png', mimeType: 'image/png' }];
    const carried = [{ path: '/context/carried.png', mimeType: 'image/png' }];
    h.ports.contextImagesFor = vi.fn(() => offered);
    h.ports.noteImagesDelivered = vi.fn();
    const failed = result({ success: false, resumeFailedNoSession: true });
    const delivered = result({ contextImagesDelivered: carried });
    vi.mocked(h.ports.startTurn)
      .mockReturnValueOnce({ result: Promise.resolve(failed), abort: vi.fn() })
      .mockReturnValueOnce({ result: Promise.resolve(delivered), abort: vi.fn() });
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    expect(vi.mocked(h.ports.contextImagesFor).mock.calls.map(([id]) => id)).toEqual([
      'missing',
      'session-a-seed-1',
    ]);
    expect(h.ports.noteImagesDelivered).toHaveBeenNthCalledWith(1, 'missing', failed);
    expect(h.ports.noteImagesDelivered).toHaveBeenNthCalledWith(2, 'session-a-seed-1', delivered);
    expect(vi.mocked(h.ports.startTurn).mock.calls[1][0].contextImages).toBe(offered);
  });

  it('asks for all context images on every stateless spawn without inventing a native id', async () => {
    const h = harness('codex');
    const images = [{ path: '/context/stateless.png', mimeType: 'image/png' }];
    h.ports.contextImagesFor = vi.fn(() => images);
    h.ports.noteImagesDelivered = vi.fn();
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    await t.runTurn('tool result', { isContinuation: true });
    expect(vi.mocked(h.ports.contextImagesFor).mock.calls).toEqual([[undefined], [undefined]]);
    for (const [request] of vi.mocked(h.ports.startTurn).mock.calls) {
      expect(request.contextImages).toBe(images);
      expect(request.backendSessionId).toBeUndefined();
      expect(request.backendSessionSeedId).toBeUndefined();
    }
  });

  it('carries the per-host provider-tool restriction on opening, reseed and continuation', async () => {
    const h = harness();
    h.ports.state.id = 'missing';
    const spawnContext = h.ports.spawnContext;
    h.ports.spawnContext = () => ({ ...spawnContext(), withholdProviderTools: true });
    vi.mocked(h.ports.startTurn).mockReturnValueOnce({
      result: Promise.resolve(result({ success: false, resumeFailedNoSession: true })),
      abort: vi.fn(),
    });
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    await t.runTurn('tool result', { isContinuation: true });
    expect(h.ports.startTurn).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(h.ports.startTurn).mock.calls) {
      expect(request.withholdProviderTools).toBe(true);
    }
    const ordinary = harness('claude', 'ordinary');
    const ordinaryTurn = ordinary.turn();
    await ordinaryTurn.runTurn(ordinaryTurn.prompt, { isContinuation: false });
    expect(
      vi.mocked(ordinary.ports.startTurn).mock.calls[0][0].withholdProviderTools
    ).toBeUndefined();
  });

  it('records both failed-resume and reseed usage and delivers media to the replacement', async () => {
    const h = harness();
    h.ports.state.id = 'missing';
    vi.mocked(h.ports.startTurn)
      .mockReturnValueOnce({
        result: Promise.resolve(
          result({
            success: false,
            stderr: 'Session not found',
            usage: { backend: 'claude', source: 'json', inputTokens: 4 },
          })
        ),
        abort: vi.fn(),
      })
      .mockReturnValueOnce({
        result: Promise.resolve(
          result({ usage: { backend: 'claude', source: 'json', inputTokens: 8 } })
        ),
        abort: vi.fn(),
      });
    const t = h.turn();
    await t.runTurn(t.prompt, { isContinuation: false });
    expect(h.ports.recordUsage).toHaveBeenNthCalledWith(1, {
      backend: 'claude',
      source: 'json',
      inputTokens: 4,
    });
    expect(h.ports.recordUsage).toHaveBeenNthCalledWith(2, {
      backend: 'claude',
      source: 'json',
      inputTokens: 8,
    });
    expect(h.ports.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ backendSessionSeedId: 'session-a-seed-1', deliverMedia: true })
    );
    expect(vi.mocked(h.ports.startTurn).mock.calls[1][0].prompt).toContain('identity bootstrap');
    expect(h.ports.notice).toHaveBeenCalledWith('resume-missing');
    expect(t.lastRunResult.usage).toEqual({ backend: 'claude', source: 'json', inputTokens: 8 });
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
    expect(h.ports.recordUsage).toHaveBeenCalledWith({
      backend: 'claude',
      source: 'json',
      inputTokens: 10,
      outputTokens: 2,
    });
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

describe('queued session log before provider dispatch', () => {
  const paths = [
    'seed',
    'resume',
    'stateless',
    'continuation',
    'rolled',
    'missing-resume',
  ] as const;
  it.each(paths)('%s waits for queued writes, then launches', async (path) => {
    await checkBarrier(path, 'release');
  });
  it.each(paths)('%s never launches after a write failure', async (path) => {
    await checkBarrier(path, 'reject');
  });
  it.each(paths)('%s observes Stop after its flush wait', async (path) => {
    await checkBarrier(path, 'abort');
  });
  async function checkBarrier(
    path: (typeof paths)[number],
    action: 'release' | 'reject' | 'abort'
  ) {
    const h = harness(path === 'stateless' ? 'codex' : 'claude');
    if (path === 'resume' || path === 'missing-resume') h.ports.state.id = 'recovered';
    const t = h.turn();
    const continuation = path === 'continuation' || path === 'rolled';
    if (continuation) await t.runTurn(t.prompt, { isContinuation: false });
    if (path === 'rolled') h.ports.state.id = undefined;
    if (path === 'missing-resume') {
      vi.mocked(h.ports.startTurn).mockReturnValueOnce({
        result: Promise.resolve(result({ success: false, resumeFailedNoSession: true })),
        abort: vi.fn(),
      });
    }
    const priorLaunches = continuation || path === 'missing-resume' ? 1 : 0;
    let release!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let atFlush!: () => void;
    const reachedFlush = new Promise<void>((resolve) => {
      atFlush = resolve;
    });
    vi.mocked(h.ports.flush).mockImplementation(() => {
      atFlush();
      return gate;
    });
    if (path === 'missing-resume') vi.mocked(h.ports.flush).mockResolvedValueOnce();
    const stop = new AbortController();
    const running = t.runTurn(t.prompt, { isContinuation: continuation, signal: stop.signal });
    expect(
      await Promise.race([reachedFlush.then(() => 'flush'), running.then(() => 'returned')])
    ).toBe('flush');
    expect(h.ports.startTurn).toHaveBeenCalledTimes(priorLaunches);
    expect(h.ports.beginSpawn).toHaveBeenCalledTimes(priorLaunches);
    if (path === 'seed' || path === 'rolled' || path === 'missing-resume') {
      expect(h.events.at(-1)).toMatchObject({ type: 'backend_session', id: h.ports.state.id });
    }
    if (action === 'reject') {
      const failed = expect(running).rejects.toThrow('synthetic queued write failure');
      reject(new Error('synthetic queued write failure'));
      await failed;
    } else if (action === 'abort') {
      const failed = expect(running).rejects.toThrow('synthetic stop');
      stop.abort(new Error('synthetic stop'));
      release();
      await failed;
    } else {
      release();
      await running;
    }
    const launched = priorLaunches + (action === 'release' ? 1 : 0);
    expect(h.ports.startTurn).toHaveBeenCalledTimes(launched);
    expect(h.ports.beginSpawn).toHaveBeenCalledTimes(launched);
    expect(h.ports.endSpawn).toHaveBeenCalledTimes(launched);
  }
});
