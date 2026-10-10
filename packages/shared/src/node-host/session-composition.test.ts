import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { composeInkSession, type SessionCompositionPorts } from './session-composition.js';
import { createSessionToolHost } from './session-tool-host.js';
import type { CodingTool } from './coding-tools.js';
import { SessionLog, ToolPolicyState } from '../runtime/index.js';
import type { BackendHost } from '../providers/types.js';
import type { BackendRunRequest, BackendRunResult } from '../providers/backend-runner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const tool = (name: string, args: Record<string, unknown> = {}) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const outcome = (text: string): BackendRunResult => ({
  success: true,
  stdout: text,
  responseText: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'fixture provider, no process',
  childExited: true,
  usage: { backend: 'claude', source: 'json', inputTokens: 10, outputTokens: 3 },
});

async function fixture(name: string, replies: string[], history: Record<string, unknown>[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-composition-')));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'fixture.txt'), `${name} harmless fixture contents`);
  const pi = await import('@mariozechner/pi-coding-agent');
  const toolHost = createSessionToolHost({
    cwd,
    home: root,
    imageRoots: [cwd],
    tempDir: root,
    credentials: { FIXTURE_KEY: name },
    coding: {
      load: async (path) => new Map([['read', pi.createReadTool(path) as unknown as CodingTool]]),
      readDocument: async () => null,
    },
  });
  cleanups.push(async () => {
    await toolHost.close();
    await rm(root, { recursive: true, force: true });
  });
  const events: Record<string, unknown>[] = [];
  const order: string[] = [];
  const path = join(root, 'fixture.jsonl');
  await writeFile(path, history.map((event) => JSON.stringify(event) + '\n').join(''));
  const log = new SessionLog({
    path,
    sink: {
      write: async (line) => {
        await appendFile(path, line);
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        order.push(`committed:${event.type}`);
      },
    },
  });
  const policy = new ToolPolicyState('backend');
  policy.allowTool('read');
  policy.allowTool('spawn_agent');
  const start = vi.fn((request: BackendRunRequest) => {
    order.push('provider');
    const next = replies.shift();
    if (next === undefined) throw new Error('unscripted provider');
    const result = Promise.resolve().then(() => {
      request.onEvent?.({ kind: 'text-delta', text: next });
      request.onEvent?.({ kind: 'text', text: next });
      return outcome(next);
    });
    return { result, abort: vi.fn() };
  });
  let id = 0;
  const ports: SessionCompositionPorts = {
    sbSlug: 'echo',
    cwd,
    cliAttached: false,
    contextBudgetAuto: false,
    history,
    log,
    policy,
    toolHost,
    runtime: {
      sessionId: name,
      backend: 'claude',
      model: 'fixture-model',
      backendTokenWindow: 200_000,
      maxContextTokens: 100_000,
      verbose: false,
      strictTools: true,
      toolMode: 'backend',
      toolRouting: 'local',
      activeSkills: [
        { name: 'fixture-review', source: 'task', content: 'Review the harmless fixture' },
      ],
      userTimezone: 'UTC',
    },
    callInk: vi.fn(async (name) =>
      name === 'bootstrap'
        ? {
            identityFiles: { soul: 'Echo fixture identity' },
            memoryIds: ['bootstrap-memory'],
            user: { timezone: 'America/Los_Angeles' },
          }
        : { success: true, memories: [] }
    ),
    logActivity: vi.fn(async () => {}),
    prepareHost: vi.fn(async () => {}),
    unavailable: (reason) => {
      throw new Error(reason);
    },
    mintId: () => `${name}-${++id}`,
    startTurn: start,
    spawnContext: () => ({
      workingDirectory: cwd,
      inkSessionId: name,
      studioId: undefined,
      host: {} as BackendHost,
    }),
    cloneLog: (path) => new SessionLog({ path, sink: { write: async () => {} } }),
    approveClone: vi.fn(async () => false),
    approve: vi.fn(async () => false),
    presentation: {
      ui: { printLine: vi.fn(), printEvent: vi.fn(), startWaiting: () => vi.fn() },
      render: vi.fn(),
      progress: vi.fn(),
      toolStarted: vi.fn(),
      modelReported: vi.fn(),
      toolResult: vi.fn(),
      compacted: vi.fn(),
      notice: vi.fn(),
    },
  };
  return { ports, events, order, start, compose: () => composeInkSession(ports) };
}

function pressuredHistory() {
  return [
    ...Array.from({ length: 20 }, (_, i) => ({
      eid: i + 1,
      type: i % 2 ? 'assistant' : 'user',
      content: `discardable old detail ${i}: ${'x'.repeat(400)}`,
      backend: 'claude',
    })),
    { eid: 21, type: 'backend_session', id: 'old-native', routing: 'local' },
  ];
}

describe('the full shared session composition (scripted provider, real read)', () => {
  it('bootstraps, reads a harmless file, streams and saves the final before publishing the outcome', async () => {
    const h = await fixture('one', [
      tool('read', { path: 'fixture.txt' }),
      'The fixture is readable.',
    ]);
    const session = await h.compose();
    const replied = vi.fn(() => {
      h.order.push('reply');
    });
    const result = await session.run(
      { raw: 'Please inspect the fixture', source: 'user' },
      { continueOnFailure: true, onOutcome: replied }
    );
    expect(result?.execution.loop.success).toBe(true);
    expect(h.start).toHaveBeenCalledTimes(2);
    const [first, second] = h.start.mock.calls.map(([request]) => request);
    expect(first.prompt).toContain('Echo fixture identity');
    expect(first.prompt).toContain('Review the harmless fixture');
    expect(second.prompt).toContain('one harmless fixture contents');
    expect(second.backendSessionId).toBe(first.backendSessionSeedId);
    expect(first.workingDirectory).toBe(h.ports.cwd);
    expect(h.order.indexOf('committed:backend_session')).toBeLessThan(h.order.indexOf('provider'));
    expect(h.order.indexOf('committed:assistant')).toBeLessThan(h.order.indexOf('reply'));
    expect(h.events.find((e) => e.type === 'assistant')).toMatchObject({
      content: 'The fixture is readable.',
      success: true,
    });
    expect(h.ports.presentation.render).toHaveBeenCalled();
    expect(session.runtime.userTimezone).toBe('America/Los_Angeles');
    expect(session.usage.totals).toMatchObject({ inputTokens: 20, outputTokens: 6 });
    expect(replied).toHaveBeenCalledOnce();
  });

  it('keeps two overlapping sessions and their actual coding-tool directories independent', async () => {
    const a = await fixture('alpha', [tool('read', { path: 'fixture.txt' }), 'Alpha done']);
    const b = await fixture('beta', [tool('read', { path: 'fixture.txt' }), 'Beta done']);
    const [one, two] = await Promise.all([a.compose(), b.compose()]);
    await Promise.all(
      [one, two].map((s) =>
        s.run({ raw: 'Read fixture', source: 'user' }, { continueOnFailure: true })
      )
    );
    expect(a.start.mock.calls[1][0].prompt).toContain('alpha harmless fixture contents');
    expect(a.start.mock.calls[1][0].prompt).not.toContain('beta harmless fixture contents');
    expect(b.start.mock.calls[1][0].prompt).toContain('beta harmless fixture contents');
    expect(a.events.every((event, i) => event.eid === i + 1)).toBe(true);
    expect(b.events.every((event, i) => event.eid === i + 1)).toBe(true);
    expect(one.context.provider.id).not.toBe(two.context.provider.id);
  });

  it('rehydrates history and resumes its matching native session without resetting event ids', async () => {
    const h = await fixture(
      'replay',
      ['continued'],
      [
        { eid: 31, type: 'user', content: 'earlier fixture question' },
        { eid: 32, type: 'assistant', content: 'earlier fixture answer', backend: 'claude' },
        { eid: 33, type: 'backend_session', id: 'previous-native', routing: 'local' },
      ]
    );
    const session = await h.compose();
    expect(
      session.ledger.listEntries().some((entry) => entry.content === 'earlier fixture answer')
    ).toBe(true);
    await session.run({ raw: 'Continue', source: 'user' }, { continueOnFailure: true });
    expect(h.start.mock.calls[0][0].backendSessionId).toBe('previous-native');
    expect(h.events[0].eid).toBe(34);
    expect(h.events.at(-1)?.type).toBe('assistant');
  });

  it('eviction rolls the provider before continuation, without reintroducing the removed result', async () => {
    const h = await fixture('evict', [
      tool('read', { path: 'fixture.txt' }),
      tool('evict_context', { source: 'local-tool' }),
      'Context removed.',
    ]);
    const session = await h.compose();
    await session.run({ raw: 'Read and evict', source: 'user' }, { continueOnFailure: true });
    const [first, , afterEviction] = h.start.mock.calls.map(([request]) => request);
    expect(afterEviction.backendSessionSeedId).toBeDefined();
    expect(afterEviction.backendSessionSeedId).not.toBe(first.backendSessionSeedId);
    expect(session.ledger.listEntries().some((e) => e.source === 'local-tool')).toBe(false);
    expect(h.events.some((e) => e.type === 'context_evict')).toBe(true);
  });

  it('keeps caller-supplied clone capabilities behind the same policy and forwards their signal', async () => {
    const h = await fixture('clone', [
      tool('spawn_agent', { tasks: [{ prompt: 'inspect', label: 'read' }] }),
      `Clone inspected${tool('signal_status', { status: 'completed' })}`,
      'Received clone',
    ]);
    const session = await h.compose();
    const stop = new AbortController();
    await session.run(
      { raw: 'Delegate inspection', source: 'user' },
      { signal: stop.signal, continueOnFailure: true }
    );
    await session.clones.drain();
    expect(session.cloneRegistry.get('clone-1')).toMatchObject({
      status: 'completed',
      summary: 'Clone inspected',
    });
    expect(h.start).toHaveBeenCalledTimes(3);
    expect(h.start.mock.calls[2][0].prompt).toContain('Clone inspected');
    expect(h.events.some((e) => e.type === 'tool_intent' && e.tool === 'spawn_agent')).toBe(true);
  });

  it('refuses missing identity before provider dispatch', async () => {
    const h = await fixture('missing', []);
    vi.mocked(h.ports.callInk).mockResolvedValue({ error: 'fixture unavailable' });
    await expect(h.compose()).rejects.toThrow('fixture unavailable');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('compacts through the tool loop, commits before reseeding and replays the summary without old entries', async () => {
    const h = await fixture(
      'compact',
      [
        tool('compact_context', { summary: 'Keep the chosen design.', keepRecent: 2 }),
        'Continuing from the design.',
      ],
      pressuredHistory()
    );
    const session = await h.compose();
    await session.run(
      { raw: 'Consolidate our earlier discussion', source: 'user' },
      { continueOnFailure: true }
    );
    const [first, continuation] = h.start.mock.calls.map(([request]) => request);
    expect(first.backendSessionId).toBe('old-native');
    expect(continuation.backendSessionId).toBeUndefined();
    expect(continuation.backendSessionSeedId).toBeDefined();
    expect(continuation.prompt).toContain('Keep the chosen design.');
    expect(continuation.prompt).toContain('Review the harmless fixture');
    expect(continuation.prompt).not.toContain('discardable old detail 0:');
    expect(h.order.indexOf('committed:compaction')).toBeLessThan(h.order.lastIndexOf('provider'));
    const history = (await readFile(h.ports.log.path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const fresh = await fixture('compact-reattached', ['Reattached.'], history);
    const reattached = await fresh.compose();
    // A fresh bootstrap adds its local status entry; hydration labels replayed
    // summaries compaction-history. Compare the retained conversation itself.
    const contents = (s: typeof session) =>
      s.ledger
        .listEntries()
        .filter((entry) => entry.source !== 'bootstrap')
        .map(({ role, content }) => ({ role, content }));
    expect(contents(reattached)).toEqual(contents(session));
    await reattached.run(
      { raw: 'Continue the design', source: 'user' },
      { continueOnFailure: true }
    );
    expect(fresh.start.mock.calls[0][0].backendSessionId).toBe(continuation.backendSessionSeedId);
    expect(fresh.events[0].eid).toBe(Number(history.at(-1)?.eid) + 1);
    expect(fresh.ports.callInk).toHaveBeenCalledWith('recall', expect.anything());
  });

  it('Stop during automatic compaction aborts and awaits the summarizer, without trimming or ordinary dispatch', async () => {
    const h = await fixture('compact-stop', [], pressuredHistory());
    h.ports.runtime.maxContextTokens = 1000;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (result: BackendRunResult) => void;
    const result = new Promise<BackendRunResult>((resolve) => {
      finish = resolve;
    });
    const abort = vi.fn();
    h.start.mockImplementation(() => {
      entered();
      return { result, abort };
    });
    const session = await h.compose();
    session.context.sampleUsage({ backend: 'claude', source: 'json', contextTokens: 2500 });
    const stop = new AbortController();
    let settled = false;
    const running = session
      .run(
        { raw: 'Continue with a full window', source: 'user' },
        { signal: stop.signal, continueOnFailure: true }
      )
      .then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
    try {
      await started;
      stop.abort(new Error('fixture Stop'));
      expect(abort).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      finish(outcome('This result arrived after Stop.'));
      await running;
    }
    expect(await running).toEqual(new Error('fixture Stop'));
    expect(h.start).toHaveBeenCalledOnce();
    expect(
      h.events.some((e) =>
        ['compaction', 'context_trim', 'context_evict', 'assistant'].includes(String(e.type))
      )
    ).toBe(false);
    expect(h.events.at(-1)).toMatchObject({
      type: 'input_cancelled',
      stage: 'before_ordinary_dispatch',
    });
    expect(session.context.provider.id).toBe('old-native');
    expect(
      session.ledger.listEntries().some((e) => e.content.includes('discardable old detail 0:'))
    ).toBe(true);
  });

  it('Stop during the automatic summarizer flush prevents that provider launch', async () => {
    const h = await fixture(
      'compact-stop-flush',
      ['summary that must not be requested'],
      pressuredHistory()
    );
    h.ports.runtime.maxContextTokens = 1000;
    const stop = new AbortController();
    const flush = h.ports.log.flush.bind(h.ports.log);
    vi.spyOn(h.ports.log, 'flush').mockImplementation(async () => {
      await flush();
      stop.abort(new Error('Stop at flush'));
    });
    const session = await h.compose();
    await expect(
      session.run(
        { raw: 'Continue', source: 'user' },
        { signal: stop.signal, continueOnFailure: true }
      )
    ).rejects.toThrow('Stop at flush');
    expect(h.start).not.toHaveBeenCalled();
    expect(
      h.events.some((e) => ['compaction', 'context_trim', 'context_evict'].includes(String(e.type)))
    ).toBe(false);
    expect(h.events.at(-1)?.type).toBe('input_cancelled');
  });

  it('automatic compaction still summarizes and commits before the ordinary turn when not stopped', async () => {
    const h = await fixture(
      'compact-auto',
      ['Preserve the design.', 'Ordinary answer.'],
      pressuredHistory()
    );
    // Trigger at 80% before compaction while leaving room for the protected
    // twelve-entry tail AND the new summary in the ordinary packed prompt.
    h.ports.runtime.maxContextTokens = 1800;
    const session = await h.compose();
    const result = await session.run(
      { raw: 'Continue after compaction', source: 'user' },
      { continueOnFailure: true }
    );
    expect(result?.execution.loop.success).toBe(true);
    expect(h.start).toHaveBeenCalledTimes(2);
    const [summarizer, ordinary] = h.start.mock.calls.map(([request]) => request);
    expect(summarizer.prompt).toContain('discardable old detail 0:');
    expect(summarizer.prompt).not.toContain('discardable old detail 19:');
    expect(ordinary.prompt).toContain('Preserve the design.');
    expect(ordinary.prompt).toContain('discardable old detail 19:');
    expect(ordinary.prompt).not.toContain('discardable old detail 0:');
    expect(ordinary.backendSessionId).toBeUndefined();
    expect(ordinary.backendSessionSeedId).toBeDefined();
    expect(h.events.find((e) => e.type === 'compaction')).toMatchObject({ actor: 'system' });
    expect(h.order.indexOf('committed:compaction')).toBeLessThan(h.order.lastIndexOf('provider'));
    expect(h.events.at(-1)).toMatchObject({ type: 'assistant', content: 'Ordinary answer.' });
  });
});
