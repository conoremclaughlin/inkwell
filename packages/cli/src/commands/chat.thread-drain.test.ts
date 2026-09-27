/**
 * An attached `ink chat` REPL reads the threads stamped to its session.
 *
 * Once the REPL's session is attached, the trigger handler delivers inline
 * and spawns nothing, so the REPL is the only reader of those threads. Its
 * poller read the legacy inbox alone and never fetched a thread; the channel
 * plugin's per-step detach had hidden that by letting the server spawn a
 * separate run between turns (Lumen, PR #685). The REPL now drains threads
 * under the plugin's own contract (shared/src/inkmail/drain.ts).
 *
 * These run the real runChat against a thread-shaped get_inbox
 * (`threadsWithUnread`) and get_thread_messages. Unlike
 * chat.integration.test.ts, this file is in the CI include list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testState = vi.hoisted(() => ({
  // A deferred input holds the prompt until it resolves. Scripted strings
  // arrive at once, and the REPL does not wait on a turn before reading the
  // next line, so a bare '/quit' would stop polling before any turn ran.
  inputs: [] as Array<string | (() => Promise<string>)>,
  inkCalls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  callToolImpl: vi.fn(),
  runBackendImpl: vi.fn(),
}));

vi.mock('../backends/identity.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backends/identity.js')>();
  return {
    ...original,
    resolveSlug: (agent?: string) => agent || 'myra',
    readIdentityJson: () => ({ studioId: 'studio-test' }),
  };
});

vi.mock('../lib/ink-client.js', () => ({
  InkClient: class MockInkClient {
    public async callTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
      testState.inkCalls.push({ tool, args });
      return testState.callToolImpl(tool, args);
    }
  },
}));

vi.mock('../repl/backend-runner.js', () => ({
  runBackendTurn: (request: Record<string, unknown>) => testState.runBackendImpl(request),
  startBackendTurn: (request: Record<string, unknown>) => ({
    result: testState.runBackendImpl(request),
    abort: () => {},
  }),
}));

vi.mock('../repl/skills.js', () => ({
  discoverSkills: () => [],
  loadSkillInstruction: (skill: Record<string, unknown>) => ({ ...skill, content: '' }),
}));

// The turn marker is a direct fetch outside InkClient; unmocked it would post
// to whatever server this machine's config names. The gate decision stays real.
vi.mock('../repl/turn-signal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../repl/turn-signal.js')>();
  return {
    ...original,
    createTurnSignal: () => ({
      open: async () => true,
      close: async () => true,
      detach: async () => true,
    }),
  };
});

vi.mock('../repl/ink/index.js', () => ({
  renderInkChat: async () => null,
  InkExitSignal: class InkExitSignal extends Error {},
}));

vi.mock('readline/promises', () => ({
  createInterface: () => ({
    question: async () => {
      const next = testState.inputs.shift();
      if (next === undefined) throw new Error('No scripted input left for readline question');
      return typeof next === 'function' ? next() : next;
    },
    on: () => undefined,
    close: () => undefined,
  }),
}));

import { runChat } from './chat.js';

const THREAD = 'pr:9';

function threadRow(id: string, content: string) {
  return {
    id,
    senderSlug: 'lumen',
    content,
    messageType: 'message',
    createdAt: '2026-02-26T23:59:00.000Z',
    metadata: {},
  };
}

/**
 * A server double for the thread half of get_inbox: `threadsWithUnread`
 * lists THREAD while any served row is unacked, and mark_thread_read acks
 * through an exact id. `visible()` gates when the row exists at all.
 */
function threadServer(row: ReturnType<typeof threadRow>, visible: () => boolean = () => true) {
  let ackedThrough: string | undefined;
  const acks: Array<Record<string, unknown>> = [];
  const pending = () => visible() && ackedThrough !== row.id;
  testState.callToolImpl.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    switch (tool) {
      case 'bootstrap':
        return { user: { timezone: 'America/Los_Angeles' } };
      case 'start_session':
        return { session: { id: 'sess-1' } };
      case 'get_inbox':
        // The legacy poll (no channelPoll) sees no legacy mail.
        if (!args.channelPoll) return { success: true, messages: [] };
        return {
          success: true,
          messages: [],
          ...(pending() ? { threadsWithUnread: [{ threadKey: THREAD, unreadCount: 1 }] } : {}),
        };
      case 'get_thread_messages':
        return { success: true, messages: pending() ? [row] : [] };
      case 'mark_thread_read':
        acks.push(args);
        ackedThrough = args.throughMessageId as string;
        return { success: true };
      default:
        return { success: true };
    }
  });
  return { acks };
}

const reply = (text: string) => ({
  success: true,
  stdout: text,
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  command: 'mock',
});

describe('attached REPL thread delivery', () => {
  const originalCwd = process.cwd();
  let testCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-27T00:00:00.000Z'));
    testState.inputs = [];
    testState.inkCalls = [];
    testState.callToolImpl.mockReset();
    testState.runBackendImpl.mockReset();
    testState.runBackendImpl.mockResolvedValue(reply('backend reply'));
    testCwd = mkdtempSync(join(tmpdir(), 'ink-chat-threads-'));
    process.chdir(testCwd);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(testCwd, { recursive: true, force: true });
  });

  const threadPolls = () =>
    testState.inkCalls.filter((c) => c.tool === 'get_inbox' && c.args.channelPoll === true);

  it('between turns: takes the thread in, acks that exact id, and the next turn carries it', async () => {
    const { acks } = threadServer(threadRow('tm-1', 'the review is ready'));
    testState.inputs = ['hello', '/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999' });

    expect(threadPolls()[0]?.args).toMatchObject({ markRead: false, status: 'unread' });
    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-1' }),
    ]);
    expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
    const prompt = (testState.runBackendImpl.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('the review is ready');
  });

  it('during a provider turn: a thread that arrives mid-turn is taken in and acked, and reaches the next turn', async () => {
    let turnInFlight = false;
    let firstTurnDone!: () => void;
    const firstTurn = new Promise<void>((resolve) => (firstTurnDone = resolve));
    const { acks } = threadServer(threadRow('tm-2', 'arrived mid-turn'), () => turnInFlight);
    testState.inputs = ['hello', () => firstTurn.then(() => 'next'), '/quit'];
    testState.runBackendImpl.mockImplementationOnce(async () => {
      turnInFlight = true;
      // The REPL's poll interval fires while this provider turn is running.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(acks).toHaveLength(1));
      firstTurnDone();
      return reply('first reply');
    });

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '5' });

    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-2' }),
    ]);
    const prompts = testState.runBackendImpl.mock.calls.map(
      (c) => (c[0] as { prompt: string }).prompt
    );
    expect(prompts[0]).not.toContain('arrived mid-turn');
    expect(prompts[1]).toContain('arrived mid-turn');
  });

  it('with auto-run on, a delivered thread message queues a turn of its own', async () => {
    const { acks } = threadServer(threadRow('tm-3', 'please rebase'));
    testState.inputs = ['/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999', autoRun: true });

    expect(acks).toHaveLength(1);
    expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
    const prompt = (testState.runBackendImpl.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('please rebase');
  });

  it('never acks a message whose intake failed', async () => {
    const { acks } = threadServer(threadRow('tm-4', 'RENDER-FAILS-HERE'));
    logSpy.mockImplementation((...args: unknown[]) => {
      if (args.some((a) => String(a).includes('RENDER-FAILS-HERE'))) {
        throw new Error('terminal write failed');
      }
    });
    testState.inputs = ['/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999' });

    expect(threadPolls().length).toBeGreaterThan(0);
    expect(testState.inkCalls.some((c) => c.tool === 'get_thread_messages')).toBe(true);
    expect(acks).toEqual([]);
  });

  it('a headless run does not drain: its message comes through --message', async () => {
    threadServer(threadRow('tm-5', 'already delivered as --message'));

    await runChat({
      agent: 'myra',
      backend: 'claude',
      nonInteractive: true,
      message: 'already delivered as --message',
      pollSeconds: '999',
    });

    expect(threadPolls()).toEqual([]);
    expect(testState.inkCalls.some((c) => c.tool === 'mark_thread_read')).toBe(false);
  });
});
