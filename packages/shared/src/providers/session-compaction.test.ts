import { describe, expect, it, vi } from 'vitest';
import { createSessionCompaction, type SessionCompactionPorts } from './session-compaction.js';
import {
  ContextLedger,
  SessionContextState,
  entryRefHash,
  EVICTED_DISPLAY_MAX,
} from '../runtime/index.js';
import type { BackendRunResult } from './backend-runner.js';

function fixture(n = 20) {
  const ledger = new ContextLedger();
  for (let i = 0; i < n; i++) ledger.addEntry('user', `entry ${i} ${'x'.repeat(400)}`, 'repl');
  const runtime: SessionCompactionPorts['runtime'] = {
    backend: 'claude',
    model: 'test-model',
    effort: 'high',
    verbose: false,
    maxContextTokens: 10000,
    toolMode: 'off',
    toolRouting: 'local',
    strictTools: false,
    activeSkills: [],
    systemPromptOverride: 'synthetic identity',
    backendTurnTimeoutMs: 1000,
    backendIdleTimeoutMs: 2000,
  };
  const events: Record<string, unknown>[] = [];
  const append = vi.fn((e: Record<string, unknown>) => events.push(e));
  const state = new SessionContextState({ runtime: () => runtime, append, rolled: vi.fn() });
  state.provider.id = 'native-test';
  const ok: BackendRunResult = {
    success: true,
    stdout: 'raw stream',
    responseText: 'short summary',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    command: 'synthetic',
    childExited: true,
    usage: { backend: 'claude', source: 'json', inputTokens: 42 },
  };
  const startTurn = vi.fn<SessionCompactionPorts['startTurn']>(() => ({
    result: Promise.resolve(ok),
    abort: vi.fn(),
  }));
  const unusedHostPort = () => {
    throw new Error('fake launch must not access host I/O');
  };
  const ports: SessionCompactionPorts = {
    runtime,
    ledger,
    sessionContext: state,
    sessionEvictedEntries: [],
    sbSlug: 'echo',
    cliAttached: false,
    contextBudgetAuto: () => true,
    append,
    flush: vi.fn(async () => {}),
    spawnContext: () => ({
      workingDirectory: '/synthetic/studio',
      inkSessionId: 'test-session',
      studioId: 'test-studio',
      withholdProviderTools: true,
      host: {
        paths: {
          inkFiles: '/synthetic/files',
          studiosRoot: '/synthetic/studios',
          tempDir: '/synthetic/tmp',
        },
        inkwellMcpUrl: 'https://example.test/mcp',
        ambientSession: unusedHostPort,
        claudeSupportsPartialMessages: unusedHostPort,
        skillMcpServers: unusedHostPort,
        sessionEnv: unusedHostPort,
        baseEnv: unusedHostPort,
        resolveBinary: unusedHostPort,
        warn: unusedHostPort,
      },
    }),
    startTurn,
    recordUsage: vi.fn(),
    formatTokens: String,
    trimmed: vi.fn(),
    progress: vi.fn(),
    deferred: vi.fn(),
    compacted: vi.fn(),
  };
  return {
    ledger,
    runtime,
    state,
    events,
    append,
    ok,
    startTurn,
    ports,
    compaction: createSessionCompaction(ports),
  };
}

describe('createSessionCompaction', () => {
  it('records bounded eviction display entries and clears a stateless sample only after append', () => {
    const f = fixture();
    f.runtime.backend = 'codex';
    f.state.provider.id = undefined;
    f.state.sampleUsage({ backend: 'codex', source: 'json', contextTokens: 500 });
    f.events.length = 0;
    f.compaction.recordEviction('user', 'none', 0, []);
    expect(f.events).toEqual([]);
    expect(f.state.measurement()).toBeDefined();
    f.compaction.recordEviction(
      'user',
      'test',
      100,
      Array.from({ length: EVICTED_DISPLAY_MAX + 1 }, (_, i) => ({
        eid: i,
        hash: `ref-${i}`,
        role: 'user' as const,
        preview: `entry-${i}`,
      }))
    );
    expect(f.events[0]).toMatchObject({
      type: 'context_evict',
      actor: 'user',
      reason: 'test',
      removedTokens: 100,
    });
    expect(f.ports.sessionEvictedEntries).toHaveLength(EVICTED_DISPLAY_MAX);
    expect(f.ports.sessionEvictedEntries[0].content).toBe('entry-1');
    expect(f.state.measurement()).toBeUndefined();
    expect(f.events.some((e) => e.type === 'backend_session_invalidated')).toBe(false);
  });
  it('does not invalidate continuity or add display entries when an eviction append fails', () => {
    const f = fixture();
    f.append.mockImplementation(() => {
      throw new Error('log closed');
    });
    expect(() =>
      f.compaction.recordEviction('sb', 'test', 1, [{ hash: 'ref', role: 'user', preview: 'x' }])
    ).toThrow('log closed');
    expect(f.state.provider.id).toBe('native-test');
    expect(f.ports.sessionEvictedEntries).toEqual([]);
  });

  it('persists the agent summary before replacing entries, then clears provider continuity', async () => {
    const f = fixture();
    const before = f.ledger.listEntries();
    f.state.sampleUsage({ backend: 'claude', source: 'json', contextTokens: 500 });
    f.append.mockImplementation((e) => {
      if (e.type === 'compaction') expect(f.ledger.listEntries()).toEqual(before);
      return f.events.push(e);
    });
    const out = await f.compaction.runSbCompaction({ summary: 'retain decisions', keepRecent: 2 });
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      success: true,
      compacted: 18,
      keptRecent: 2,
    });
    expect(f.ledger.listEntries()).toHaveLength(3);
    expect(f.ledger.listEntries()[0].content).toContain('retain decisions');
    expect(f.state.provider.id).toBeUndefined();
    expect(f.state.measurement()).toBeUndefined();
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.ports.compacted).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), false);
  });
  it('resolves selected refs at call time and preserves the unselected entries in place', async () => {
    const f = fixture(4);
    const entries = f.ledger.listEntries();
    const ref = entryRefHash(entries[1].role, entries[1].content);
    const out = await f.compaction.runSbCompaction({ summary: 'brief', refs: [ref] });
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      success: true,
      matchedEntries: 1,
      summaryIndex: 1,
    });
    expect(
      f.ledger
        .listEntries()
        .filter((e) => e.id !== entries[1].id)
        .map((e) => e.content)
    ).toEqual([
      entries[0].content,
      expect.stringContaining('brief'),
      entries[2].content,
      entries[3].content,
    ]);
    const stale = await f.compaction.runSbCompaction({ summary: 'brief', refs: [ref] });
    expect(stale.isError).toBe(true);
    expect(f.startTurn).not.toHaveBeenCalled();
  });
  it('inherits model, effort, identity, timeout policy, attachment and scoped spawn ports', async () => {
    const f = fixture();
    expect((await f.compaction.compactContextNow({ actor: 'system', reason: 'test' })).ok).toBe(
      true
    );
    expect(f.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'claude',
        sbSlug: 'echo',
        model: 'test-model',
        effort: 'high',
        systemPromptOverride: 'synthetic identity',
        timeoutMs: 300000,
        idleTimeoutMs: 2000,
        stream: true,
        cliAttached: false,
        workingDirectory: '/synthetic/studio',
        inkSessionId: 'test-session',
        studioId: 'test-studio',
        withholdProviderTools: true,
      })
    );
    expect(f.ports.recordUsage).toHaveBeenCalledWith(f.ok.usage);
  });
  it.each(['during-launch', 'after-launch'] as const)(
    'aborts %s and records failed usage without compacting',
    async (when) => {
      const f = fixture();
      const controller = new AbortController();
      let resolve!: (r: BackendRunResult) => void;
      const result = new Promise<BackendRunResult>((r) => {
        resolve = r;
      });
      const abort = vi.fn(() =>
        resolve({ ...f.ok, success: false, exitCode: 143, stderr: 'aborted' })
      );
      let launched!: () => void;
      const didLaunch = new Promise<void>((resolve) => {
        launched = resolve;
      });
      f.startTurn.mockImplementation(() => {
        launched();
        if (when === 'during-launch') controller.abort();
        return { result, abort };
      });
      const running = f.compaction.compactContextNow({
        actor: 'sb',
        reason: 'test',
        signal: controller.signal,
      });
      expect(f.compaction.isInFlight()).toBe(true);
      await didLaunch;
      if (when === 'after-launch') controller.abort();
      expect(await running).toMatchObject({
        ok: false,
        error: expect.stringContaining('cancelled'),
      });
      expect(abort).toHaveBeenCalledTimes(1);
      expect(f.ports.recordUsage).toHaveBeenCalledWith(f.ok.usage);
      expect(f.events).toEqual([]);
      expect(f.ledger.listEntries()).toHaveLength(20);
      expect(f.compaction.isInFlight()).toBe(false);
    }
  );
  it('rejects overlap only in the same session and releases the flag after completion', async () => {
    const a = fixture();
    const b = fixture();
    let resolve!: (r: BackendRunResult) => void;
    a.startTurn.mockReturnValue({
      result: new Promise((r) => {
        resolve = r;
      }),
      abort: vi.fn(),
    });
    const running = a.compaction.compactContextNow({ actor: 'sb', reason: 'test' });
    expect(await a.compaction.compactContextNow({ actor: 'sb', reason: 'overlap' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already in progress'),
    });
    expect((await b.compaction.compactContextNow({ actor: 'sb', reason: 'other' })).ok).toBe(true);
    resolve(a.ok);
    await running;
    expect(a.compaction.isInFlight()).toBe(false);
  });
  it('does not clear native continuity or mutate the ledger when the compaction marker fails', async () => {
    const f = fixture();
    f.append.mockImplementation(() => {
      throw new Error('log closed');
    });
    const out = await f.compaction.compactContextNow({
      actor: 'sb',
      reason: 'test',
      summaryText: 'brief',
    });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('log closed') });
    expect(f.ledger.listEntries()).toHaveLength(20);
    expect(f.state.provider.id).toBe('native-test');
    expect(f.compaction.isInFlight()).toBe(false);
    expect(f.ports.compacted).not.toHaveBeenCalled();
  });
  it.each(['sb', 'system'] as const)(
    'on failed summarization, %s retains its existing trim policy',
    async (actor) => {
      const f = fixture();
      f.runtime.maxContextTokens = 500;
      f.startTurn.mockReturnValue({
        result: Promise.resolve({ ...f.ok, success: false, stderr: 'failure', exitCode: 1 }),
        abort: vi.fn(),
      });
      const out = await f.compaction.compactContextNow({ actor, reason: 'test' });
      expect(out.ok).toBe(false);
      expect(f.ports.recordUsage).toHaveBeenCalledWith(f.ok.usage);
      expect(f.ledger.listEntries()).toHaveLength(actor === 'sb' ? 20 : 6);
      expect(f.events.some((e) => e.type === 'context_evict')).toBe(actor === 'system');
      expect(f.state.provider.id).toBe(actor === 'sb' ? 'native-test' : undefined);
    }
  );
  it('rolls provider-only excess without summarizing or removing ledger history', async () => {
    const f = fixture(2);
    f.state.sampleUsage({ backend: 'claude', source: 'json', contextTokens: 9000 });
    await f.compaction.maybeCompactContext('test');
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.ledger.listEntries()).toHaveLength(2);
    expect(f.events.at(-1)).toMatchObject({
      type: 'backend_session_invalidated',
      reason: 'provider-context-over-budget',
    });
    expect(f.state.provider.id).toBeUndefined();
  });
  it('defers unknown Claude model under auto budget, but honors an explicit budget', async () => {
    const f = fixture();
    f.runtime.model = undefined;
    f.runtime.maxContextTokens = 500;
    await f.compaction.maybeCompactContext('test');
    expect(f.ports.deferred).toHaveBeenCalledOnce();
    expect(f.startTurn).not.toHaveBeenCalled();
    f.ports.contextBudgetAuto = () => false;
    await f.compaction.maybeCompactContext('test');
    expect(f.startTurn).toHaveBeenCalledOnce();
  });
  it('rolls an oversized provider even when the protected tail prevents compaction', async () => {
    const f = fixture(2);
    f.runtime.maxContextTokens = 100;
    f.state.sampleUsage({ backend: 'claude', source: 'json', contextTokens: 1000 });
    await f.compaction.maybeCompactContext('test');
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.ledger.listEntries()).toHaveLength(2);
    expect(f.state.provider.id).toBeUndefined();
  });
});

describe('summarizer queued history barrier', () => {
  it.each(['release', 'reject', 'abort'] as const)('honors %s before launching', async (action) => {
    const f = fixture();
    let release!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let atFlush!: () => void;
    const reached = new Promise<void>((resolve) => {
      atFlush = resolve;
    });
    vi.mocked(f.ports.flush).mockImplementation(() => {
      atFlush();
      return gate;
    });
    const stop = new AbortController();
    const running = f.compaction.compactContextNow({
      actor: 'sb',
      reason: 'test',
      signal: stop.signal,
    });
    expect(await Promise.race([reached.then(() => 'flush'), running.then(() => 'returned')])).toBe(
      'flush'
    );
    expect(f.startTurn).not.toHaveBeenCalled();
    if (action === 'reject') reject(new Error('synthetic queued write failure'));
    else {
      if (action === 'abort') stop.abort();
      release();
    }
    const out = await running;
    expect(out.ok).toBe(action === 'release');
    expect(f.startTurn).toHaveBeenCalledTimes(action === 'release' ? 1 : 0);
    if (action !== 'release') {
      expect(f.events).toEqual([]);
      expect(f.ledger.listEntries()).toHaveLength(20);
      expect(f.state.provider.id).toBe('native-test');
    }
  });
});
