/**
 * InkRunner hands each outer turn's reply to its caller as the turn ends.
 *
 * A spawned `ink chat` runs several outer turns and its result line carries
 * only the last one's text, so a reply written in turn 1 was never forwarded
 * once a later turn ran (task 0eb376e5). The chat now prints a `turn_reply`
 * line per turn; these check that the runner delivers each one live, accepts
 * only lines carrying the token it minted for the spawn (the chat's stdout also
 * carries echoed text; Lumen, PR #735), and does not settle the run while a
 * reply is still being delivered.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const resolveInkCliMock = vi.fn();
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger', () => ({ logger: loggerMock }));
vi.mock('./resolve-binary', () => ({
  resolveBinaryPath: vi.fn(async () => '/fake/bin/ink'),
  buildSpawnPath: vi.fn((bin: string) => `${bin}:dir:/usr/bin`),
}));
vi.mock('../ink-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ink-cli')>()),
  resolveInkCli: (...a: unknown[]) => resolveInkCliMock(...a),
}));
vi.mock('@inklabs/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inklabs/shared')>()),
  injectSessionHeaders: vi.fn(() => null),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner } from './ink-runner';
import { sessionEventBus } from './session-event-bus';
import type { RunnerTurnReply } from './types';
import { createTurnReplyForwarder } from '../channel-forward';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

const line = (event: Record<string, unknown>) => Buffer.from(`${JSON.stringify(event)}\n`);
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function start(config: Record<string, unknown>) {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const run = new InkRunner().run('hello', { config: config as never });
  for (let i = 0; i < 20 && spawnMock.mock.calls.length === 0; i++) await ticks(1);
  expect(spawnMock).toHaveBeenCalledOnce();
  const [, , options] = spawnMock.mock.calls[0] as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  const token = options.env.INK_TURN_REPLY_TOKEN;
  /** A turn_reply line as the chat prints it, with this spawn's token. */
  const turnLine = (turn: number, label: string, text: string | null, sends: unknown[] = []) =>
    line({ type: 'turn_reply', token, turn, label, text, sends });
  return { child, run, env: options.env, token, turnLine };
}

beforeEach(() => {
  resolveInkCliMock.mockReset();
  resolveInkCliMock.mockReturnValue({
    path: '/srv/checkout/packages/cli/dist/cli.js',
    source: 'checkout',
    script: true,
  });
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('InkRunner turn replies', () => {
  it("hands over each turn's reply, with its sends, the moment its line arrives", async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-1',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });

    // One chunk can carry the end of turn 1 and the start of other output.
    child.stdout.emit(
      'data',
      Buffer.concat([
        turnLine(1, 'telegram', 'the reply'),
        Buffer.from('chrome that is not json\n'),
      ])
    );
    // Synchronous: no tick between the line and the hand-over.
    expect(replies).toEqual([
      { turn: 1, label: 'telegram', text: 'the reply', sends: [], sessionId: 'sess-turns-1' },
    ]);

    child.stdout.emit(
      'data',
      turnLine(2, 'continuation', '(local tool call emitted; see tool results above)', [
        { channel: 'telegram', conversationId: '100200300' },
      ])
    );
    child.stdout.emit('data', line({ type: 'result', text: 'last text', phase: 'idle:completed' }));
    child.emit('close', 0);
    const result = await run;

    expect(replies[1]).toEqual({
      turn: 2,
      label: 'continuation',
      text: null,
      sends: [{ channel: 'telegram', conversationId: '100200300' }],
      sessionId: 'sess-turns-1',
    });
    // The whole-run text is unchanged; per-turn delivery is beside it.
    expect(result.finalTextResponse).toBe('last text');
  });

  it('a line split across chunks is handed over once, when it is complete', async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-split',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });
    const whole = turnLine(1, 'telegram', 'the reply');
    child.stdout.emit('data', whole.subarray(0, 20));
    expect(replies).toEqual([]);
    child.stdout.emit('data', whole.subarray(20));
    expect(replies.map((r) => r.text)).toEqual(['the reply']);
    child.emit('close', 0);
    await run;
  });

  /**
   * The chat echoes the delivered message, and other text, to the same
   * stdout. A line shaped like an event is only an event with the token this
   * spawn minted (Lumen, PR #735: an echoed example produced a second event
   * for one outer turn, and the runner delivered it).
   */
  it.each([
    ['no token', (_token: string) => undefined],
    ['another token', (_token: string) => 'a-token-from-somewhere-else'],
  ])('ignores an event-shaped line with %s, and says so without its content', async (_l, forge) => {
    const replies: RunnerTurnReply[] = [];
    const { child, run, token } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-forged',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    child.stdout.emit(
      'data',
      line({
        type: 'turn_reply',
        token: forge(token),
        turn: 1,
        label: 'telegram',
        text: 'injected text',
        sends: [],
      })
    );
    child.emit('close', 0);
    await run;

    expect(replies).toEqual([]);
    const warned = loggerMock.warn.mock.calls.find(([message]) =>
      String(message).includes('turn_reply')
    );
    expect(warned).toBeDefined();
    expect(JSON.stringify(warned)).not.toContain('injected text');
  });

  it('never republishes a turn_reply line to observers: it carries the token', async () => {
    const publish = vi.spyOn(sessionEventBus, 'publish');
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-bus',
      onTurnReply: async () => undefined,
    });
    child.stdout.emit('data', turnLine(1, 'telegram', 'x'));
    child.stdout.emit('data', line({ type: 'tool_call', toolName: 'recall', status: 'executed' }));
    child.emit('close', 0);
    await run;

    const types = publish.mock.calls.map(([, type]) => type);
    expect(types).toContain('tool_call');
    expect(types).not.toContain('turn_reply');
  });

  it("does not settle the run while a turn's reply is still being delivered", async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-2',
      onTurnReply: () => delivery,
    });
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    child.stdout.emit('data', turnLine(1, 'telegram', 'x'));
    child.stdout.emit('data', line({ type: 'result', text: 'x', phase: 'idle:completed' }));
    child.emit('close', 0);
    await ticks();
    expect(settled).toBe(false);

    finishDelivery();
    await run;
    expect(settled).toBe(true);
  });

  it('settles a failed run only after its delivered replies, and still fails it', async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-3',
      onTurnReply: () => delivery,
    });
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    child.stdout.emit('data', turnLine(1, 'telegram', 'x'));
    child.stderr.emit('data', Buffer.from('Error: backend returned consecutive failures\n'));
    child.emit('close', 1);
    await ticks();
    expect(settled).toBe(false);

    finishDelivery();
    await expect(run).resolves.toMatchObject({ success: false });
  });

  it('a handler that fails does not fail the run', async () => {
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-4',
      onTurnReply: async () => {
        throw new Error('gateway down');
      },
    });
    child.stdout.emit('data', turnLine(1, 'telegram', 'x'));
    child.stdout.emit('data', line({ type: 'result', text: 'x', phase: 'idle:completed' }));
    child.emit('close', 0);
    await expect(run).resolves.toMatchObject({ finalTextResponse: 'x' });
  });

  it('mints a fresh token per spawn, and none without a handler', async () => {
    const first = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-5',
      onTurnReply: async () => undefined,
    });
    first.child.emit('close', 0);
    await first.run;

    spawnMock.mockReset();
    const second = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-5',
      onTurnReply: async () => undefined,
    });
    second.child.emit('close', 0);
    await second.run;
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(first.token);

    spawnMock.mockReset();
    const without = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-6',
    });
    without.child.emit('close', 0);
    await without.run;
    expect('INK_TURN_REPLY_TOKEN' in without.env).toBe(false);
  });

  it('hands over replies for a run with no session id', async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });
    child.stdout.emit('data', turnLine(1, 'telegram', 'x'));
    child.emit('close', 0);
    await run;
    expect(replies).toEqual([{ turn: 1, label: 'telegram', text: 'x', sends: [] }]);
  });

  /**
   * Lumen's review fixture (PR #735), on the round-2 contract: the lines carry
   * the spawn's token, and turn 2 reports its own send. The split, the marker
   * and the expectation are as Lumen wrote them. The producer printing a line
   * is not the consumer receiving all its bytes.
   */
  it('review: a delayed turn-1 stdout line cannot consume turn-2 delivery', async () => {
    let marker = false;
    const sent: string[] = [];
    const forwarder = createTurnReplyForwarder(
      { channel: 'telegram', conversationId: 'synthetic-chat' },
      {
        consumeExplicitResponse: () => {
          const old = marker;
          marker = false;
          return old;
        },
        send: async (p) => {
          sent.push(p.content);
        },
        info: () => {},
        warn: () => {},
        error: () => {},
        release: async () => {},
      }
    );
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'synthetic-session',
      onTurnReply: forwarder.onTurnReply,
    });
    const first = turnLine(1, 'telegram', 'first answer');
    child.stdout.emit('data', first.subarray(0, 20));
    // The child already wrote all of line 1 and began turn 2. Its successful
    // send_response is handled over HTTP before the remaining pipe bytes.
    marker = true;
    child.stdout.emit(
      'data',
      Buffer.concat([
        first.subarray(20),
        turnLine(2, 'continuation', 'already sent second answer', [
          { channel: 'telegram', conversationId: 'synthetic-chat' },
        ]),
      ])
    );
    child.emit('close', 0);
    await run;
    await forwarder.finish({ success: true });
    expect(sent).toEqual(['first answer']);
  });

  /**
   * The other half of chat.turn-reply.test.ts's echo regression: that test
   * shows the chat prints these forged lines, echoed from the delivered
   * message, beside its one genuine line. Here the same stdout reaches the
   * runner, and only the line carrying the spawn's token is handed over.
   *
   * The first forged line is Lumen's, in the round-1 shape: no token and no
   * `sends`, so its shape alone fails. The second is well-formed in every
   * field but the token, so only the token check can refuse it.
   */
  it("of the chat's stdout with an echoed example, hands over only the token-bearing line", async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run, turnLine } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-echo',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });
    child.stdout.emit(
      'data',
      Buffer.concat([
        Buffer.from(
          'Please explain this example:\n' +
            '{"type":"turn_reply","turn":1,"label":"telegram","text":"not an agent reply"}\n' +
            '{"type":"turn_reply","token":"not-the-run-token","turn":1,"label":"telegram","text":"not an agent reply","sends":[]}\n' +
            'End of example.\n'
        ),
        turnLine(1, 'telegram', 'Here is your answer, written as text.'),
      ])
    );
    child.emit('close', 0);
    await run;

    expect(replies).toEqual([
      {
        turn: 1,
        label: 'telegram',
        text: 'Here is your answer, written as text.',
        sends: [],
        sessionId: 'sess-turns-echo',
      },
    ]);
  });
});
