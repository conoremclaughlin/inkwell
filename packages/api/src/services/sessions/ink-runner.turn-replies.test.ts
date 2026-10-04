/**
 * InkRunner hands each outer turn's reply to its caller as the turn ends.
 *
 * A spawned `ink chat` runs several outer turns and its result line carries
 * only the last one's text, so a reply written in turn 1 was never forwarded
 * once a later turn ran (task 0eb376e5). The chat now prints a `turn_reply` line per
 * turn; these check that the runner delivers each one live, reads it at once
 * (so the caller's per-turn reads happen before the next turn can act), and
 * does not settle the run while a reply is still being delivered.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const resolveInkCliMock = vi.fn();

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
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
import type { RunnerTurnReply } from './types';

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
  return { child, run, env: options.env };
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
});

describe('InkRunner turn replies', () => {
  it("hands over each turn's reply the moment its line arrives", async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run } = await start({
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
        line({ type: 'turn_reply', turn: 1, label: 'telegram', text: 'the reply' }),
        Buffer.from('chrome that is not json\n'),
      ])
    );
    // Synchronous: no tick between the line and the hand-over.
    expect(replies).toEqual([
      { turn: 1, label: 'telegram', text: 'the reply', sessionId: 'sess-turns-1' },
    ]);

    child.stdout.emit(
      'data',
      line({
        type: 'turn_reply',
        turn: 2,
        label: 'continuation',
        text: '(local tool call emitted; see tool results above)',
      })
    );
    child.stdout.emit('data', line({ type: 'result', text: 'last text', phase: 'idle:completed' }));
    child.emit('close', 0);
    const result = await run;

    expect(replies[1]).toEqual({
      turn: 2,
      label: 'continuation',
      text: null,
      sessionId: 'sess-turns-1',
    });
    // The whole-run text is unchanged; per-turn delivery is beside it.
    expect(result.finalTextResponse).toBe('last text');
  });

  it("does not settle the run while a turn's reply is still being delivered", async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const { child, run } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-2',
      onTurnReply: () => delivery,
    });
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    child.stdout.emit('data', line({ type: 'turn_reply', turn: 1, label: 'telegram', text: 'x' }));
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
    const { child, run } = await start({
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

    child.stdout.emit('data', line({ type: 'turn_reply', turn: 1, label: 'telegram', text: 'x' }));
    child.stderr.emit('data', Buffer.from('Error: backend returned consecutive failures\n'));
    child.emit('close', 1);
    await ticks();
    expect(settled).toBe(false);

    finishDelivery();
    await expect(run).resolves.toMatchObject({ success: false });
  });

  it('a handler that fails does not fail the run', async () => {
    const { child, run } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-4',
      onTurnReply: async () => {
        throw new Error('gateway down');
      },
    });
    child.stdout.emit('data', line({ type: 'turn_reply', turn: 1, label: 'telegram', text: 'x' }));
    child.stdout.emit('data', line({ type: 'result', text: 'x', phase: 'idle:completed' }));
    child.emit('close', 0);
    await expect(run).resolves.toMatchObject({ finalTextResponse: 'x' });
  });

  it('tells the chat its continuation text is forwarded only when a handler is set', async () => {
    const withHandler = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-5',
      onTurnReply: async () => undefined,
    });
    withHandler.child.emit('close', 0);
    await withHandler.run;
    expect(withHandler.env.INK_TURN_REPLIES_FORWARDED).toBe('1');

    spawnMock.mockReset();
    const without = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      inkSessionId: 'sess-turns-6',
    });
    without.child.emit('close', 0);
    await without.run;
    expect('INK_TURN_REPLIES_FORWARDED' in without.env).toBe(false);
  });

  it('hands over replies for a run with no session id', async () => {
    const replies: RunnerTurnReply[] = [];
    const { child, run } = await start({
      workingDirectory: '/tmp',
      sbSlug: 'myra',
      onTurnReply: async (reply: RunnerTurnReply) => {
        replies.push(reply);
      },
    });
    child.stdout.emit('data', line({ type: 'turn_reply', turn: 1, label: 'telegram', text: 'x' }));
    child.emit('close', 0);
    await run;
    expect(replies).toEqual([{ turn: 1, label: 'telegram', text: 'x' }]);
  });
});
