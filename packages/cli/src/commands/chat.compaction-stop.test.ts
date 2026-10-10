/** Actual runChat cancellation, with inert providers/Ink and owned transcripts only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  BackendRunRequest,
  BackendRunResult,
  BackendTurnHandle,
} from '@inklabs/shared/providers';
import { SessionLog } from '../session/session-log.js';

const fixture = vi.hoisted(() => ({
  inputs: [] as Array<string | (() => Promise<string>)>,
  start: vi.fn<(request: BackendRunRequest) => BackendTurnHandle>(),
  abortHandler: null as (() => void) | null,
  closedTurn: vi.fn<() => void>(),
  printSystem: vi.fn(),
  cleanup: vi.fn(),
  recall: vi.fn<() => Promise<{ success: boolean; memories: Record<string, unknown>[] }>>(),
}));
vi.mock('./init.js', () => ({
  detectWorktree: (cwd: string) => ({ linked: false, toplevel: cwd }),
}));
vi.mock('../lib/launch-studio.js', () => ({
  completeStudioAtLaunch: async () => ({ ran: false }),
}));
vi.mock('../backends/identity.js', async (original) => ({
  ...(await original<typeof import('../backends/identity.js')>()),
  resolveSlug: () => 'echo',
  readIdentityJson: () => ({ studioId: 'fixture-studio' }),
}));
vi.mock('../lib/ink-client.js', () => ({
  InkClient: class {
    async callTool(name: string) {
      if (name === 'bootstrap')
        return { identityFiles: { soul: 'Fixture' }, user: { timezone: 'America/Los_Angeles' } };
      if (name === 'get_inbox') return { messages: [] };
      if (name === 'recall') return fixture.recall();
      if (name === 'list_sessions') return { sessions: [] };
      return { success: true };
    }
  },
}));
vi.mock('../repl/backend-runner.js', () => ({
  withholdProviderToolsForThisProcess: () => {},
  startBackendTurn: (request: BackendRunRequest) => fixture.start(request),
  runBackendTurn: (request: BackendRunRequest) => fixture.start(request).result,
}));
vi.mock('../repl/credential-resolver.js', async (original) => ({
  ...(await original<typeof import('../repl/credential-resolver.js')>()),
  loadKeychainCredentials: async () => {
    throw new Error('Fixture must not load credentials');
  },
}));
vi.mock('../auth/tokens.js', () => ({ getValidAccessToken: async () => null }));
vi.mock('../lib/ink-mcp.js', () => ({ getInkServerUrl: () => 'https://fixture.invalid' }));
vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
  loadSkillInstruction: () => undefined,
}));
vi.mock('../repl/turn-signal.js', async (original) => ({
  ...(await original<typeof import('../repl/turn-signal.js')>()),
  createTurnSignal: () => ({
    open: async () => true,
    close: async () => {
      fixture.closedTurn();
      return true;
    },
    detach: async () => true,
  }),
}));
vi.mock('../repl/ink/index.js', () => ({
  InkExitSignal: class extends Error {},
  renderInkChat: () => ({
    waitForInput: async () => {
      const next = fixture.inputs.shift();
      if (next === undefined) throw new Error('No scripted input');
      return typeof next === 'string' ? next : next();
    },
    setAbortHandler: (handler: (() => void) | null) => {
      fixture.abortHandler = handler;
    },
    addMessage: vi.fn(),
    printSystem: fixture.printSystem,
    printEvent: vi.fn(),
    setStatus: vi.fn(),
    setWaiting: vi.fn(),
    setInfoItems: vi.fn(),
    setCommandOutput: vi.fn(),
    setSurfacedMemories: vi.fn(),
    showContextView: vi.fn(),
    requestExit: vi.fn(),
    cleanup: fixture.cleanup,
    handle: { setCtrlOHandler: vi.fn(), setCtrlTHandler: vi.fn() },
  }),
}));
import { runChat } from './chat.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const outcome = (text: string): BackendRunResult => ({
  success: true,
  stdout: text,
  responseText: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'inert fixture, no provider process',
  childExited: true,
});
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CLI Stop includes pre-turn automatic compaction', () => {
  const originalCwd = process.cwd();
  let root: string;
  let transcript: string;
  let baseline: NodeJS.SignalsListener[];
  let stdoutTty: PropertyDescriptor | undefined;
  const turnListeners = () => process.listeners('SIGINT').filter((fn) => !baseline.includes(fn));
  const events = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(transcript, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  beforeEach(async () => {
    baseline = process.listeners('SIGINT');
    stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    root = await realpath(await mkdtemp(join(tmpdir(), 'ink-cli-compaction-stop-')));
    process.chdir(root);
    vi.stubEnv('INK_TOOL_POLICY_PATH', join(root, 'policy.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected real network');
      })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.inputs = [];
    fixture.start.mockReset();
    fixture.closedTurn.mockReset();
    fixture.printSystem.mockClear();
    fixture.cleanup.mockClear();
    fixture.recall.mockReset().mockResolvedValue({ success: true, memories: [] });
    fixture.abortHandler = null;
    const dir = join(root, '.ink/runtime/repl');
    await mkdir(dir, { recursive: true });
    transcript = join(dir, 'fixture-session-history.jsonl');
    // Enough old history to exercise the real automatic summarizer, not a
    // compact_context tool call or a mocked coordinator.
    const history = [
      ...Array.from({ length: 20 }, (_, i) => ({
        eid: i + 1,
        type: i % 2 ? 'assistant' : 'user',
        content: `old fixture detail ${i}: ${'x'.repeat(400)}`,
        backend: 'claude',
      })),
      { eid: 21, type: 'backend_session', id: 'fixture-native', routing: 'local' },
    ];
    await writeFile(transcript, history.map((event) => JSON.stringify(event) + '\n').join(''));
  });
  afterEach(async () => {
    // Only clean this test worker's newly registered listeners on a failing
    // assertion; normal-path assertions below require production to remove them.
    for (const listener of turnListeners()) process.off('SIGINT', listener);
    if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const run = (maxContextTokens = '1800') =>
    runChat({
      agent: 'echo',
      backend: 'claude',
      model: 'fixture-model',
      sessionId: 'fixture-session',
      maxContextTokens,
      pollSeconds: '999',
      profile: 'tools',
    });

  it.each(['SIGINT', 'TUI'] as const)(
    '%s aborts the summarizer, waits for settlement and leaves a fresh next turn',
    async (source) => {
      const started = deferred<void>();
      const summary = deferred<BackendRunResult>();
      const nextInput = deferred<string>();
      const firstClosed = deferred<void>();
      const secondClosed = deferred<void>();
      const abort = vi.fn();
      fixture.closedTurn
        .mockImplementationOnce(() => firstClosed.resolve())
        .mockImplementationOnce(() => secondClosed.resolve());
      fixture.inputs = [
        'First request',
        () => nextInput.promise,
        () => secondClosed.promise.then(() => '/quit'),
      ];
      fixture.start
        .mockImplementationOnce(() => {
          started.resolve();
          return { result: summary.promise, abort };
        })
        .mockImplementationOnce(() => ({
          result: Promise.resolve(outcome('Retained fixture summary.')),
          abort: vi.fn(),
        }))
        .mockImplementationOnce(() => ({
          result: Promise.resolve(outcome('Next turn works.')),
          abort: vi.fn(),
        }));
      const running = run();
      try {
        await started.promise;
        expect(fixture.start.mock.calls[0][0].prompt).toContain('old fixture detail 0:');
        expect(fixture.start.mock.calls[0][0].backendSessionSeedId).toBeUndefined();
        expect(turnListeners()).toHaveLength(1);
        expect(fixture.abortHandler).toEqual(expect.any(Function));
        const firstHandler = fixture.abortHandler;
        // Invoke only our own listener, not a process-wide emit or an OS signal.
        if (source === 'SIGINT') turnListeners()[0]('SIGINT');
        else fixture.abortHandler!();
        expect(abort).toHaveBeenCalledOnce();
        await checkpoint();
        expect(fixture.closedTurn).not.toHaveBeenCalled();
        expect(fixture.start).toHaveBeenCalledOnce();
        expect(fixture.abortHandler).toBe(firstHandler);

        summary.resolve(outcome('Too late: cancelled summary.'));
        await firstClosed.promise;
        expect(turnListeners()).toEqual([]);
        expect(fixture.abortHandler).toBeNull();
        const stopped = await events();
        expect(stopped.at(-1)).toMatchObject({
          type: 'input_cancelled',
          stage: 'before_ordinary_dispatch',
        });
        expect(
          stopped.some((event) =>
            ['compaction', 'context_trim', 'context_evict'].includes(String(event.type))
          )
        ).toBe(false);
        expect(stopped.filter((event) => event.type === 'assistant')).toHaveLength(10); // only replayed history
        expect(fixture.start).toHaveBeenCalledOnce();

        nextInput.resolve('Next request');
        await running;
        expect(fixture.start).toHaveBeenCalledTimes(3); // cancelled summary, new summary, ordinary
        expect(
          (await events()).find(
            (event) => event.type === 'assistant' && event.content === 'Next turn works.'
          )
        ).toMatchObject({ success: true });
        expect(turnListeners()).toEqual([]);
        expect(fixture.abortHandler).toBeNull();
        expect(fixture.cleanup).toHaveBeenCalledOnce();
      } finally {
        summary.resolve(outcome('fixture cleanup'));
        nextInput.resolve('/quit');
        secondClosed.resolve();
        await running;
      }
    }
  );

  it.each(['Stop', 'write failure'] as const)(
    'cleans up after %s at the pre-summarizer flush without dispatch',
    async (cause) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const quit = deferred<string>();
      const closed = deferred<void>();
      fixture.inputs = ['First request', () => quit.promise];
      fixture.closedTurn.mockImplementationOnce(() => closed.resolve());
      const flush = SessionLog.prototype.flush;
      let held = false;
      vi.spyOn(SessionLog.prototype, 'flush').mockImplementation(async function (this: SessionLog) {
        await flush.call(this);
        // Like a real failed async SessionLog sink, uncertainty stays sticky:
        // a fallback trim cannot make later dispatch safe by flushing again.
        if (held && cause === 'write failure') throw new Error('fixture flush failure');
        if (
          !held &&
          (await events()).some(
            (event) => event.type === 'user' && event.content === 'First request'
          )
        ) {
          held = true;
          entered.resolve();
          await release.promise;
          if (cause === 'write failure') throw new Error('fixture flush failure');
        }
      });
      const running = run();
      try {
        await entered.promise;
        expect(turnListeners()).toHaveLength(1);
        expect(fixture.abortHandler).toEqual(expect.any(Function));
        if (cause === 'Stop') fixture.abortHandler!();
        release.resolve();
        await closed.promise;
        expect(fixture.start).not.toHaveBeenCalled();
        expect(turnListeners()).toEqual([]);
        expect(fixture.abortHandler).toBeNull();
        if (cause === 'Stop') expect((await events()).at(-1)?.type).toBe('input_cancelled');
      } finally {
        release.resolve();
        quit.resolve('/quit');
        await running;
      }
    }
  );

  it('keeps double Ctrl+C exit-after-settlement behavior during compaction', async () => {
    const started = deferred<void>();
    const summary = deferred<BackendRunResult>();
    const input = deferred<string>();
    const abort = vi.fn();
    fixture.inputs = ['First request', () => input.promise, '/quit'];
    fixture.start.mockImplementationOnce(() => {
      started.resolve();
      return { result: summary.promise, abort };
    });
    let settled = false;
    const running = run().finally(() => {
      settled = true;
    });
    try {
      await started.promise;
      expect(turnListeners()).toHaveLength(1);
      const onSigint = turnListeners()[0];
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      onSigint('SIGINT');
      onSigint('SIGINT');
      expect(abort).toHaveBeenCalledOnce();
      expect(fixture.printSystem).toHaveBeenCalledWith(
        'Will exit after current backend turn completes.'
      );
      input.resolve(''); // return to the loop so it observes exit-after-turn
      await checkpoint();
      expect(settled).toBe(false);
      expect(fixture.cleanup).not.toHaveBeenCalled();
      summary.resolve(outcome('Late summary'));
      await running;
      expect(fixture.start).toHaveBeenCalledOnce();
      expect(fixture.inputs).toEqual(['/quit']); // exit flag, not /quit, ended the loop
      expect(turnListeners()).toEqual([]);
      expect(fixture.abortHandler).toBeNull();
    } finally {
      input.resolve('/quit');
      summary.resolve(outcome('fixture cleanup'));
      await running;
    }
  });

  it('still aborts the ordinary child after a successful automatic compaction', async () => {
    const started = deferred<void>();
    const child = deferred<BackendRunResult>();
    const quit = deferred<string>();
    const closed = deferred<void>();
    const abortSummary = vi.fn();
    const abortChild = vi.fn();
    fixture.closedTurn.mockImplementationOnce(() => closed.resolve());
    fixture.inputs = ['First request', () => quit.promise];
    fixture.start
      .mockImplementationOnce(() => ({
        result: Promise.resolve(outcome('Retained fixture summary.')),
        abort: abortSummary,
      }))
      .mockImplementationOnce(() => {
        started.resolve();
        return { result: child.promise, abort: abortChild };
      });
    const running = run();
    try {
      await started.promise;
      fixture.abortHandler!();
      expect(abortChild).toHaveBeenCalledOnce();
      expect(abortSummary).not.toHaveBeenCalled();
      await checkpoint();
      expect(fixture.closedTurn).not.toHaveBeenCalled();
      child.resolve(outcome('Late ordinary answer'));
      await closed.promise;
      expect((await events()).at(-1)).toMatchObject({
        type: 'assistant',
        cancelled: true,
        content: null,
      });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(turnListeners()).toEqual([]);
      expect(fixture.abortHandler).toBeNull();
    } finally {
      child.resolve(outcome('fixture cleanup'));
      quit.resolve('/quit');
      await running;
    }
  });

  it('cancels a pre-dispatch recall wait and fences its late result', async () => {
    const entered = deferred<void>();
    const recall = deferred<{ success: boolean; memories: Record<string, unknown>[] }>();
    const quit = deferred<string>();
    const closed = deferred<void>();
    fixture.closedTurn.mockImplementationOnce(() => closed.resolve());
    fixture.inputs = ['Recall the fixture design decisions', () => quit.promise];
    fixture.recall.mockImplementationOnce(() => {
      entered.resolve();
      return recall.promise;
    });
    const running = run('100000'); // no compaction: reach the actual prompt_build hook
    try {
      await entered.promise;
      expect(turnListeners()).toHaveLength(1);
      fixture.abortHandler!();
      await closed.promise; // must not wait for the unresolved recall or its timeout
      expect(fixture.start).not.toHaveBeenCalled();
      expect(turnListeners()).toEqual([]);
      expect(fixture.abortHandler).toBeNull();
      recall.resolve({
        success: true,
        memories: [{ id: 'late-fixture', content: 'LATE_RECALL_MUST_NOT_ENTER' }],
      });
      await checkpoint();
      expect(JSON.stringify(await events())).not.toContain('LATE_RECALL_MUST_NOT_ENTER');
      expect((await events()).at(-1)?.type).toBe('input_cancelled');
    } finally {
      recall.resolve({ success: true, memories: [] });
      quit.resolve('/quit');
      await running;
    }
  });
});
