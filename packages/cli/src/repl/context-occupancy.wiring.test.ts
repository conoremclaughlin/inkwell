import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPromptEnvelope } from '../commands/chat';
import { ContextLedger } from './context-ledger';
import { ProviderSampleTracker } from './provider-sample';
import {
  computeContextOccupancy,
  formatContextStamp,
  handleClientLocalTool,
} from './context-tools';
import {
  createSessionProviderTurn,
  type SessionProviderPorts,
  type BackendRunResult,
} from '@inklabs/shared/providers';
import { envelopeShapeKey, turnContextOccupancy } from '@inklabs/shared/runtime';

// The old regression sliced chat.ts and executed its source text. The real
// composition is now importable: exercise it directly with a fake launch port,
// retaining the original continuation/reseed stamp and ordering assertions.
// No provider, shell, DB or transcript writer runs.
function providerHarness(backend = 'claude') {
  const ledger = new ContextLedger();
  ledger.addEntry('user', 'synthetic user input', 'repl');
  const tracker = new ProviderSampleTracker();
  const ok: BackendRunResult = {
    success: true,
    stdout: 'reply',
    responseText: 'reply',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    command: 'synthetic',
    childExited: true,
  };
  const ports: SessionProviderPorts = {
    runtime: {
      backend,
      model: 'synthetic-model',
      verbose: false,
      maxContextTokens: 2000,
      bootstrapContext: 'x'.repeat(400),
      toolMode: 'off',
      toolRouting: 'local',
      strictTools: false,
      activeSkills: [],
    },
    state: { id: 'stale-native-session' },
    ledger,
    sbSlug: 'echo',
    cliAttached: false,
    passthroughArgs: [],
    dialogue: [],
    mintId: () => 'reseeded-native-session',
    append: () => 0,
    buildEnvelope: (body, stamp) => buildPromptEnvelope('echo', ports.runtime, ledger, body, stamp),
    measurement: () =>
      tracker.measurement({
        backend,
        model: ports.runtime.model,
        backendSessionId: ports.state.id,
        envelopeShape: envelopeShapeKey(ports.runtime),
      }),
    spawnContext: () => ({ workingDirectory: '/synthetic/studio' }),
    attachmentDirs: () => [],
    startTurn: vi.fn(() => ({ result: Promise.resolve(ok), abort: () => {} })),
    onEvent: () => {},
    beginSpawn: () => {},
    endSpawn: () => {},
    onAbortHandle: () => {},
    onInitialSettled: () => {},
    onInitialResult: () => {},
    recordUsage: () => {},
    sampleContext: () => {},
    contextGeneration: () => 0,
    mutationsInFlight: () => 0,
    notice: () => {},
  };
  const measure = () =>
    tracker.record(
      { contextTokens: 1500 },
      {
        backend,
        model: ports.runtime.model,
        backendSessionId: ports.state.id,
        envelopeShape: envelopeShapeKey(ports.runtime),
      }
    );
  const turn = () =>
    createSessionProviderTurn(ports, 'synthetic user input', [], {
      input: { raw: 'synthetic user input', source: 'user' },
      occupancy: turnContextOccupancy(ledger, ports.runtime, ports.measurement()),
      promptHooks: { injected: 0, injectedEntries: [], evicted: 0, blocked: false },
    });
  return { ports, measure, turn, ok };
}

describe('PR 639 recovery advice', () => {
  it('does not advertise the immutable bootstrap as evictable ledger tokens', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'x'.repeat(400), 'repl');
    const occ = computeContextOccupancy(ledger.totalTokens(), 900, 2000, { contextTokens: 1000 });
    const result = handleClientLocalTool('evict_context', { source: 'repl' }, ledger)!;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.tokensFreed).toBe(100);
    expect(ledger.totalTokens()).toBe(0);
    expect(occ.ledgerTokens).toBeLessThanOrEqual(payload.tokensFreed);
  });

  it('control: production eviction resets a native session even for a tiny stub', () => {
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
    const writer = source.slice(
      source.indexOf('  const recordEviction = ('),
      source.indexOf('  const trimContextToPercent = async (')
    );
    // Pin the production mutation, not a mock of what we think it does.
    expect(writer).toContain('activeBackendSessionId = undefined;');
    expect(writer).toContain('activeBackendSessionShape = undefined;');
    expect(writer).toContain('providerSample.clear();');
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'stub', 'ink');
    let notified = false;
    handleClientLocalTool('evict_context', { source: 'ink' }, ledger, undefined, {
      onEvict: ({ refs }) => {
        notified = refs.length === 1;
      },
    });
    expect(notified).toBe(true);
  });

  it('does not claim compaction is the exclusive way to clear provider excess', () => {
    const occ = computeContextOccupancy(100, 0, 2000, { contextTokens: 1500 });
    expect(formatContextStamp(occ)).not.toContain('only by compact_context');
  });

  it.each(['resume', 'seed', 'stateless'])(
    'refreshes the stamp before a %s tool-loop continuation',
    async (mode) => {
      const h = providerHarness(mode === 'stateless' ? 'codex' : 'claude');
      const turn = h.turn();
      expect(turn.prompt).not.toContain('1,500');
      await turn.runTurn(turn.prompt, { isContinuation: false });
      if (mode === 'seed') {
        h.ports.state.id = undefined;
        h.ports.state.shape = undefined;
        // Reproduce the old probe's constant measurement independently of id;
        // recovery tests below cover the real scoped tracker invalidation.
        h.ports.measurement = () => ({ contextTokens: 1500 });
      } else h.measure();
      await turn.runTurn('synthetic tool result', { isContinuation: true });
      const request = vi.mocked(h.ports.startTurn).mock.calls[1][0];
      expect(request.prompt).toContain('[context]');
      expect(request.prompt).toContain('1,500');
      expect(request.prompt).toContain('synthetic tool result');
      if (mode === 'seed') expect(request.backendSessionSeedId).toBe('reseeded-native-session');
      if (mode === 'resume') expect(request.backendSessionId).toBe('stale-native-session');
      if (mode === 'stateless') {
        expect(request.backendSessionId).toBeUndefined();
        expect(request.backendSessionSeedId).toBeUndefined();
      }
    }
  );
});

describe('PR 639 resume-not-found recovery seed', () => {
  async function recover(mintedId = 'reseeded-native-session') {
    const h = providerHarness();
    h.ports.mintId = () => mintedId;
    h.measure();
    vi.mocked(h.ports.startTurn).mockReturnValueOnce({
      result: Promise.resolve({
        ...h.ok,
        success: false,
        exitCode: 1,
        resumeFailedNoSession: true,
      }),
      abort: () => {},
    });
    const turn = h.turn();
    expect(turn.prompt).toContain('1,500');
    await turn.runTurn(turn.prompt, { isContinuation: false });
    expect(h.ports.startTurn).toHaveBeenCalledTimes(2);
    return vi.mocked(h.ports.startTurn).mock.calls[1][0];
  }

  it('stamps the recovery retry envelope', async () => {
    const request = await recover();
    expect(request.backendSessionSeedId).toBe('reseeded-native-session');
    expect(request.prompt).toContain('[context]');
    expect(request.prompt).toContain('x'.repeat(400));
  });

  it('builds that stamp after the new native id lands, so the dead session is not quoted', async () => {
    const request = await recover();
    expect(request.prompt).not.toContain('1,500');
    expect(request.prompt).toContain('the provider has not reported this session');
  });

  it('control: a measurement whose scope still matches is reported', async () => {
    const request = await recover('stale-native-session');
    expect(request.prompt).toContain('1,500');
    expect(request.prompt).not.toContain('the provider has not reported this session');
    expect(request.prompt).toContain('identity envelope 100');
  });
});

it('the CLI supplies live native state and measurement to the tested shared composition', () => {
  const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const providerTurn = createSessionProviderTurn(');
  const end = source.indexOf('startTurn: startBackendTurn,', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  expect(block).toContain('return activeBackendSessionId;');
  expect(block).toContain('activeBackendSessionId = value;');
  expect(block).toContain('measurement: providerContextMeasurement,');
  expect(block).toContain('buildPromptEnvelope(sbSlug, runtime, ledger, body, stamp)');
});
