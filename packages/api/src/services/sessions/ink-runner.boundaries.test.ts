/**
 * A stopped ink run's boundaries (Lumen's review of PR #748, 6133db4d): once
 * its outcome is known, the run's process is no longer heard (no fresh turn
 * replies, no fresh live activity), and its run-owned cleanup happens once, so
 * a late close of the old child can never touch a replacement run's observer
 * state on the same session. Replies accepted before that point are still
 * awaited.
 *
 * Fully mocked: spawn, the stop, the event bus and the CLI resolution. No
 * process is started or signalled.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn(),
  resolve: vi.fn(),
  cleanup: vi.fn(),
  clear: vi.fn(),
  release: vi.fn(),
  publish: vi.fn(),
  ledger: vi.fn(),
  observer: vi.fn(),
}));

vi.mock('./context-builder.js', () => ({ formatInjectedContext: () => 'Synthetic identity' }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ink-cli.js', () => ({ resolveInkCli: () => null, inkCliSpawn: vi.fn() }));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: mocks.resolve,
  buildSpawnPath: () => '/synthetic/bin',
}));
vi.mock('./stop-process.js', () => ({
  isGroupId: (p: number) => Number.isInteger(p) && p > 1,
  stopProcessAndWait: mocks.stop,
}));
vi.mock('./session-event-bus.js', () => ({
  sessionEventBus: {
    clearReplay: mocks.clear,
    releaseObserverSession: mocks.release,
    publish: mocks.publish,
    registerLedgerPath: mocks.ledger,
    publishObserverEntry: mocks.observer,
  },
}));
vi.mock('@inklabs/shared', async (load) => ({
  ...(await load<typeof import('@inklabs/shared')>()),
  injectSessionHeaders: () => ({ cleanup: mocks.cleanup }),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner } from './ink-runner.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
    pid: 424242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
}

async function launch(handler = vi.fn(async () => {})) {
  const proc = child();
  mocks.spawn.mockReturnValueOnce(proc);
  const controller = new AbortController();
  const run = new InkRunner().run('synthetic prompt', {
    config: {
      workingDirectory: '/synthetic/work',
      inkSessionId: 'synthetic-session',
      mcpConfigPath: '/synthetic/mcp',
      sbSlug: 'synthetic',
      killProcessGroup: true,
      signal: controller.signal,
      onTurnReply: handler,
    } as never,
  });
  await tick();
  const env = mocks.spawn.mock.calls.at(-1)![2].env;
  const reply = (turn: number) =>
    line({
      type: 'turn_reply',
      token: env.INK_TURN_REPLY_TOKEN,
      turn,
      label: 'api',
      text: 'synthetic reply',
      sends: [],
    });
  return { proc, controller, run, reply, handler };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue('/synthetic/ink');
  mocks.stop.mockResolvedValue({ exited: false, group: 'unknown' });
});
afterEach(() => vi.restoreAllMocks());

describe("InkRunner: a stopped run's boundaries", () => {
  it('a reply accepted before Stop is awaited (control)', async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(() => wait);
    const t = await launch(handler);
    t.proc.stdout.emit('data', t.reply(1));
    t.controller.abort();
    let done = false;
    void t.run.then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    finish();
    await t.run;
    expect(done).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    t.proc.emit('close', 143);
  });

  it('accepts no fresh turn reply once an unconfirmed stop has returned', async () => {
    const t = await launch();
    t.controller.abort();
    const result = await t.run;
    expect(result.stopUnconfirmed).toBeDefined();
    t.proc.stdout.emit('data', t.reply(2));
    t.proc.emit('close', 143);
    expect(t.handler).not.toHaveBeenCalled();
  });

  it('publishes no fresh activity once an unconfirmed stop has returned', async () => {
    const t = await launch();
    t.controller.abort();
    await t.run;
    mocks.publish.mockClear();
    t.proc.stdout.emit('data', line({ type: 'tool_call', toolName: 'synthetic-late' }));
    t.proc.emit('close', 143);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("the old stopped child's late close never releases or clears a replacement run's observer state", async () => {
    const old = await launch();
    old.controller.abort();
    await old.run;
    // Once its group is observed gone, a replacement on the same session runs.
    const next = await launch();
    next.proc.stdout.emit(
      'data',
      line({ type: 'session_meta', transcriptPath: '/synthetic/new-ledger' })
    );
    mocks.release.mockClear();
    mocks.clear.mockClear();
    old.proc.emit('close', 143);
    const releases = mocks.release.mock.calls.length;
    const clears = mocks.clear.mock.calls.length;
    next.proc.emit('close', 0);
    await next.run;
    expect({ releases, clears }).toEqual({ releases: 0, clears: 0 });
  });

  it('never releases the run while a reply is still pending: nothing is accepted after the outcome is known', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const handler = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const t = await launch(handler);
    t.proc.stdout.emit('data', t.reply(1));
    t.controller.abort();
    await tick(); // The stop's outcome is known; the first delivery still holds the run.
    t.proc.stdout.emit('data', t.reply(2));
    let done = false;
    void t.run.then(() => {
      done = true;
    });
    finishFirst();
    await tick();
    const acceptedSecond = handler.mock.calls.length === 2;
    const releasedEarly = acceptedSecond && done;
    finishSecond();
    await t.run;
    t.proc.emit('close', 143);
    expect(releasedEarly).toBe(false);
  });

  it('run-owned cleanup happens once, whichever of the stop and the close comes first', async () => {
    const t = await launch();
    t.controller.abort();
    await t.run;
    t.proc.emit('close', 143);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('a fence landing during the asynchronous binary lookup is rechecked at the spawn seam (control)', async () => {
    let resolveBinary!: (path: string) => void;
    let fence = false;
    mocks.resolve.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveBinary = resolve;
        })
    );
    const run = new InkRunner().run('synthetic prompt', {
      config: { admitSpawn: () => (fence ? 'synthetic fenced' : undefined) } as never,
    });
    fence = true;
    resolveBinary('/synthetic/ink');
    expect(await run).toMatchObject({ success: false, refusedBeforeSpawn: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
