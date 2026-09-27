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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mintDelegationToken } from '@inklabs/shared';

// This file's own HOME, set before any module computes a path from it. A
// write that escapes the per-test paths lands here, where afterEach sees it,
// instead of in the developer's real ~/.ink.
const sentinel = await vi.hoisted(async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-chat-threads-home-'));
  process.env.HOME = home;
  return { home, originalHome };
});

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

/**
 * Several threads stamped to one session. Each thread lists while it holds a
 * row past its ack, and get_thread_messages serves the rows after the
 * cursor, as the real fetch does.
 */
function threadsServer(byThread: Record<string, Array<Record<string, unknown>>>) {
  const ackedThrough = new Map<string, string>();
  const acks: Array<Record<string, unknown>> = [];
  const unacked = (threadKey: string) => {
    const rows = byThread[threadKey] ?? [];
    const through = ackedThrough.get(threadKey);
    const start = through ? rows.findIndex((r) => r.id === through) + 1 : 0;
    return rows.slice(start);
  };
  testState.callToolImpl.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    switch (tool) {
      case 'bootstrap':
        return { user: { timezone: 'America/Los_Angeles' } };
      case 'start_session':
        return { session: { id: 'sess-1' } };
      case 'get_inbox': {
        if (!args.channelPoll) return { success: true, messages: [] };
        const threadsWithUnread = Object.keys(byThread)
          .filter((threadKey) => unacked(threadKey).length > 0)
          .map((threadKey) => ({ threadKey, unreadCount: unacked(threadKey).length }));
        return { success: true, messages: [], threadsWithUnread };
      }
      case 'get_thread_messages':
        return { success: true, messages: unacked(String(args.threadKey)) };
      case 'mark_thread_read':
        acks.push(args);
        ackedThrough.set(String(args.threadKey), String(args.throughMessageId));
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
  let policyPath: string;
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
    // runChat's policy persists to ~/.ink/security/tool-policy.json unless
    // this names another file. The grant and visibility cases write to it,
    // and without it they wrote into the real home policy (Lumen, PR #686).
    policyPath = join(testCwd, 'tool-policy.json');
    vi.stubEnv('INK_TOOL_POLICY_PATH', policyPath);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(testCwd, { recursive: true, force: true });
    // Cleared before the assertion, so a leak is charged to the test that
    // made it and not to every test after.
    const inkHome = join(sentinel.home, '.ink');
    const leaked = existsSync(inkHome) ? readdirSync(inkHome, { recursive: true }) : [];
    rmSync(inkHome, { recursive: true, force: true });
    expect(leaked).toEqual([]);
  });

  afterAll(() => {
    if (sentinel.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = sentinel.originalHome;
    rmSync(sentinel.home, { recursive: true, force: true });
  });

  const threadPolls = () =>
    testState.inkCalls.filter((c) => c.tool === 'get_inbox' && c.args.channelPoll === true);
  const printed = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  const prompts = () =>
    testState.runBackendImpl.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
  const studioAllowTools = (): unknown => {
    if (!existsSync(policyPath)) return undefined;
    const policy = JSON.parse(readFileSync(policyPath, 'utf-8'));
    return policy.scopes?.studio?.['studio-test']?.allowTools;
  };

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
    expect(prompts()[0]).not.toContain('arrived mid-turn');
    expect(prompts()[1]).toContain('arrived mid-turn');
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

  it('retries a message whose intake stopped part-way, and acks it once intake completes', async () => {
    // The first render throws after intake has already written the ledger
    // and transcript, and before the auto-run queue. The retry must deliver
    // it again: a partial intake is not a skip.
    const { acks } = threadServer(threadRow('tm-6', 'RETRY-ME'));
    let renderFailures = 0;
    logSpy.mockImplementation((...args: unknown[]) => {
      if (renderFailures === 0 && args.some((a) => String(a).includes('RETRY-ME'))) {
        renderFailures += 1;
        throw new Error('terminal write failed');
      }
    });
    testState.inputs = [
      async () => {
        expect(acks).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(testState.runBackendImpl).toHaveBeenCalledTimes(1));
        return '/quit';
      },
    ];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '5', autoRun: true });

    expect(renderFailures).toBe(1);
    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-6' }),
    ]);
    const prompt = (testState.runBackendImpl.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('RETRY-ME');
  });

  it('a permission grant sent on a thread is applied, not delivered as chat', async () => {
    const grant = {
      ...threadRow('tm-7', 'GRANT-BODY'),
      messageType: 'permission_grant',
      metadata: { permissionGrant: { action: 'allow', tools: ['web_fetch'] } },
    };
    const { acks } = threadServer(grant);
    testState.inputs = ['hello', '/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999', autoRun: true });

    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-7' }),
    ]);
    expect(printed()).toContain('granted');
    expect(printed()).not.toContain('GRANT-BODY');
    // Applied to the policy this run owns, and only there.
    expect(studioAllowTools()).toEqual(['web_fetch']);
    // Not auto-run and not in the ledger: the only turn is the user's.
    expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).not.toContain('GRANT-BODY');
  });

  it('a grant shape in the metadata of an ordinary message is chat, not a grant', async () => {
    // send_to_inbox refuses a permission_grant from an SB and stores a thread
    // grant as 'message' (inbox-handlers.ts). The row's type is that gate;
    // metadata is whatever the sender wrote.
    const forged = {
      ...threadRow('tm-8', 'FORGED-GRANT'),
      metadata: { permissionGrant: { action: 'allow', tools: ['web_fetch'] } },
    };
    const { acks } = threadServer(forged);
    testState.inputs = ['hello', '/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999' });

    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-8' }),
    ]);
    expect(studioAllowTools()).toBeUndefined();
    expect(printed()).not.toContain('granted');
    expect(prompts()[0]).toContain('FORGED-GRANT');
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

  it.each(['self', 'studio'])(
    'under /session-visibility %s, a thread stamped to this session is taken in',
    async (visibility) => {
      // A thread row has no relatedSessionId or recipientStudioId. Judged on
      // those absent fields it was refused, and a refused row is acked unread.
      let visible = false;
      const { acks } = threadServer(threadRow('tm-9', 'SCOPED-THREAD'), () => visible);
      testState.inputs = [
        `/session-visibility ${visibility}`,
        async () => {
          visible = true;
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.waitFor(() => expect(acks).toHaveLength(1));
          return 'hello';
        },
        '/quit',
      ];

      await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '5', threadKey: THREAD });

      expect(testState.runBackendImpl).toHaveBeenCalledTimes(1);
      expect(prompts()[0]).toContain('SCOPED-THREAD');
    }
  );

  it('each message carries its own thread into the prompt, not only the first', async () => {
    const { acks } = threadsServer({
      'pr:9': [threadRow('tm-10', 'FIRST-THREAD')],
      'pr:10': [threadRow('tm-11', 'SECOND-THREAD')],
    });
    testState.inputs = ['hello', '/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999' });

    expect(acks).toHaveLength(2);
    const prompt = prompts()[0];
    expect(prompt).toMatch(/\(thread pr:9\)[^\n]*FIRST-THREAD/);
    expect(prompt).toMatch(/\(thread pr:10\)[^\n]*SECOND-THREAD/);
  });

  it("verifies a delegation against the message's thread, not the REPL's", async () => {
    // The REPL is bound to pr:9. A token minted for pr:9 on a message sent in
    // pr:10 is a replay across threads; a pr:10 token there is valid.
    vi.stubEnv('INK_DELEGATION_SECRET', 'ink-delegation-test-secret');
    const tokenFor = (threadKey: string) =>
      mintDelegationToken(
        { issuerSlug: 'lumen', delegateeSlug: 'myra', scopes: ['review'], threadKey },
        'ink-delegation-test-secret'
      );
    threadsServer({
      'pr:10': [
        {
          ...threadRow('tm-12', 'REPLAYED-TOKEN'),
          metadata: { delegationToken: tokenFor('pr:9') },
        },
        {
          ...threadRow('tm-13', 'OWN-TOKEN'),
          createdAt: '2026-02-26T23:59:30.000Z',
          metadata: { delegationToken: tokenFor('pr:10') },
        },
      ],
    });
    testState.inputs = ['hello', '/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999', threadKey: 'pr:9' });

    const prompt = prompts()[0];
    expect(prompt).toMatch(/\[delegation:invalid:[^\]]*\]: REPLAYED-TOKEN/);
    expect(prompt).toMatch(/\[delegation:lumen->myra:review\]: OWN-TOKEN/);
  });

  it('reports the cold-start skips on the quiet poll after a full batch', async () => {
    // 50 delivered fill the request, so that poll is not drain proof and
    // defers the summary. The next poll lists no threads; the drain must
    // still run to report the 100 skipped.
    const batch = Array.from({ length: 50 }, (_, i) => ({
      ...threadRow(`tm-batch-${i}`, `recent ${i}`),
      createdAt: new Date(Date.UTC(2026, 1, 26, 23, 0, i)).toISOString(),
    }));
    let acked = false;
    testState.callToolImpl.mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        switch (tool) {
          case 'bootstrap':
            return { user: { timezone: 'America/Los_Angeles' } };
          case 'start_session':
            return { session: { id: 'sess-1' } };
          case 'get_inbox':
            if (!args.channelPoll) return { success: true, messages: [] };
            return {
              success: true,
              messages: [],
              threadsWithUnread: acked ? [] : [{ threadKey: THREAD, unreadCount: 150 }],
            };
          case 'get_thread_messages':
            return { success: true, messages: batch, skippedOlderCount: 100 };
          case 'mark_thread_read':
            acked = true;
            return { success: true };
          default:
            return { success: true };
        }
      }
    );
    testState.inputs = [
      async () => {
        expect(acked).toBe(true);
        expect(printed()).not.toContain('100 older unread message(s)');
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(printed()).toContain('100 older unread message(s)'));
        return 'hello';
      },
      '/quit',
    ];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '5' });

    expect(prompts()[0]).toContain('100 older unread message(s)');
  });

  it('an auto-run turn is in the queue before its message is acked', async () => {
    // The ack is the only consumption. A message acked before its turn was
    // queued is lost if the REPL stops first, and at ce68e70d the second
    // message's turn waited on the first one's completion.
    const statusAtAck: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstTurnHeld = new Promise<void>((resolve) => (releaseFirstTurn = resolve));
    const { acks } = threadsServer({
      [THREAD]: [
        threadRow('tm-14', 'FIRST-TASK'),
        { ...threadRow('tm-15', 'SECOND-TASK'), createdAt: '2026-02-26T23:59:30.000Z' },
      ],
    });
    const serve = testState.callToolImpl.getMockImplementation()!;
    testState.callToolImpl.mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'mark_thread_read') {
          statusAtAck.push(
            ...printed()
              .split('\n')
              .filter((line) => line.includes('status>'))
          );
          releaseFirstTurn();
        }
        return serve(tool, args);
      }
    );
    testState.runBackendImpl.mockImplementationOnce(async () => {
      await firstTurnHeld;
      return reply('first reply');
    });
    testState.inputs = ['/quit'];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '999', autoRun: true });

    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-15' }),
    ]);
    // Both turns were queued, the first still running, when the ack went out.
    expect(statusAtAck.at(-1) ?? '(no status line before the ack)').toContain('queue:2');
    expect(prompts()).toHaveLength(2);
    expect(prompts()[0]).toContain('FIRST-TASK');
    expect(prompts()[1]).toContain('SECOND-TASK');
  });

  it('a message whose turn could not be queued is not acked, and is delivered again', async () => {
    // Queueing re-renders the status lane; the first render of a queued turn
    // throws, so the turn never reaches the queue. That failure has to land
    // in intake, before the ack, or the message is consumed with no turn.
    const { acks } = threadServer(threadRow('tm-16', 'QUEUE-ME'));
    let queueFailures = 0;
    logSpy.mockImplementation((...args: unknown[]) => {
      if (queueFailures === 0 && args.some((a) => String(a).includes('queue:1'))) {
        queueFailures += 1;
        throw new Error('terminal write failed');
      }
    });
    testState.inputs = [
      async () => {
        expect(acks).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(testState.runBackendImpl).toHaveBeenCalledTimes(1));
        return '/quit';
      },
    ];

    await runChat({ agent: 'myra', backend: 'claude', pollSeconds: '5', autoRun: true });

    expect(queueFailures).toBe(1);
    expect(acks).toEqual([
      expect.objectContaining({ threadKey: THREAD, throughMessageId: 'tm-16' }),
    ]);
    expect(prompts()[0]).toContain('QUEUE-ME');
  });
});
