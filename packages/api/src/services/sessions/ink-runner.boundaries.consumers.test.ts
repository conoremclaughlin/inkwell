/**
 * The same boundaries as ink-runner.boundaries.test.ts, through the real
 * consumers (Lumen's review of PR #748): the production turn-reply forwarder
 * sends nothing for a stopped run once it was finalized, and the real session
 * event bus keeps a replacement run's replay when the old child finally
 * closes.
 *
 * Fully mocked process and stop: no process is started or signalled.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn(),
  resolve: vi.fn(),
  cleanup: vi.fn(),
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
vi.mock('@inklabs/shared', async (load) => ({
  ...(await load<typeof import('@inklabs/shared')>()),
  injectSessionHeaders: () => ({ cleanup: mocks.cleanup }),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner } from './ink-runner.js';
import { sessionEventBus } from './session-event-bus.js';
import { createTurnReplyForwarder } from '../channel-forward.js';

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

async function launch(handler: unknown = vi.fn(async () => {})) {
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
  return { proc, controller, run, reply };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue('/synthetic/ink');
  mocks.stop.mockResolvedValue({ exited: false, group: 'unknown' });
});
afterEach(() => vi.restoreAllMocks());

describe("InkRunner: a stopped run's boundaries, through the real consumers", () => {
  it('the real forwarder sends no fresh reply after the stopped run was finalized', async () => {
    const sent: string[] = [];
    let released = false;
    const forwarder = createTurnReplyForwarder(
      { channel: 'api', conversationId: 'synthetic-chat' },
      {
        consumeExplicitResponse: () => false,
        send: async (payload) => {
          sent.push(payload.content);
        },
        release: async () => {
          released = true;
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      }
    );
    const t = await launch(forwarder.onTurnReply);
    t.controller.abort();
    const result = await t.run;
    await forwarder.finish(result);
    expect(released).toBe(true);
    t.proc.stdout.emit('data', t.reply(2));
    await tick();
    t.proc.emit('close', 143);
    expect(sent).toEqual([]);
  });

  it("a replacement run's activity stays replayable after the old child closes", async () => {
    const old = await launch();
    old.controller.abort();
    await old.run;
    const next = await launch();
    next.proc.stdout.emit(
      'data',
      line({ type: 'tool_call', toolName: 'synthetic-new-generation' })
    );
    const before: string[] = [];
    const after: string[] = [];
    sessionEventBus.subscribe('synthetic-session', (event) =>
      before.push(String(event.data.toolName))
    )();
    expect(before).toEqual(['synthetic-new-generation']);
    old.proc.emit('close', 143);
    sessionEventBus.subscribe('synthetic-session', (event) =>
      after.push(String(event.data.toolName))
    )();
    next.proc.emit('close', 0);
    await next.run;
    expect(after).toEqual(before);
  });
});
