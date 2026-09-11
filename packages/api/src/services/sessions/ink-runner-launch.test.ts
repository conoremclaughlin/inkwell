/**
 * The ink chat loop is launched from this checkout's own CLI build, run
 * through this server's node binary, never from the global ~/.ink/bin/ink
 * link. Only a checkout with no build falls back to `ink` on PATH.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const resolveInkCliMock = vi.fn();
const resolveBinaryPathMock = vi.fn(async () => '/fake/bin/ink');
const buildSpawnPathMock = vi.fn((bin: string) => `${bin}:dir:/usr/bin`);

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-binary', () => ({
  resolveBinaryPath: (...a: unknown[]) => resolveBinaryPathMock(...a),
  buildSpawnPath: (...a: unknown[]) => buildSpawnPathMock(...a),
}));
vi.mock('../ink-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ink-cli')>()),
  resolveInkCli: (...a: unknown[]) => resolveInkCliMock(...a),
}));
vi.mock('@inklabs/shared', () => ({
  injectSessionHeaders: vi.fn(() => null),
  buildSessionEnv: vi.fn(() => ({})),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner } from './ink-runner';

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

const baseConfig = { workingDirectory: '/tmp', agentId: 'myra', pcpSessionId: 'sess-1' };
const CLI = '/srv/checkout/packages/cli/dist/cli.js';

/** Run one turn to the point of spawn, close the child cleanly, and return the spawn call. */
async function launchOnce(): Promise<{
  command: string;
  args: string[];
  options: { env: Record<string, string> };
}> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const run = new InkRunner().run('hello', { config: baseConfig as never });
  for (let i = 0; i < 20 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(spawnMock).toHaveBeenCalledOnce();
  child.emit('close', 0);
  await run;
  const [command, args, options] = spawnMock.mock.calls[0] as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  return { command, args, options };
}

beforeEach(() => {
  resolveInkCliMock.mockReset();
  resolveBinaryPathMock.mockClear();
  buildSpawnPathMock.mockClear();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InkRunner launch command', () => {
  it("runs this checkout's CLI build through the server's own node binary", async () => {
    resolveInkCliMock.mockReturnValue({ path: CLI, source: 'checkout', script: true });

    const { command, args, options } = await launchOnce();

    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(CLI);
    expect(args.slice(-2)).toEqual(['--message', 'hello']);
    expect(resolveBinaryPathMock).not.toHaveBeenCalled();
    // The child's PATH is built from the node binary that actually runs.
    // buildSpawnPath only prepends that directory when PATH lacks it, so a
    // PATH that already lists another node earlier still wins for nested
    // `#!/usr/bin/env node` shebangs (existing limitation, unchanged here).
    expect(buildSpawnPathMock).toHaveBeenCalledWith(process.execPath);
    expect(options.env.PATH).toBe(`${process.execPath}:dir:/usr/bin`);
  });

  it('runs an INK_CLI_PATH executable directly, with no script argument', async () => {
    resolveInkCliMock.mockReturnValue({ path: '/opt/ink/bin/ink', source: 'env', script: false });

    const { command, args } = await launchOnce();

    expect(command).toBe('/opt/ink/bin/ink');
    expect(args[0]).not.toBe('/opt/ink/bin/ink');
    expect(args).not.toContain(CLI);
    expect(buildSpawnPathMock).toHaveBeenCalledWith('/opt/ink/bin/ink');
  });

  it('falls back to `ink` on PATH only when this checkout has no build', async () => {
    resolveInkCliMock.mockReturnValue(null);

    const { command, args } = await launchOnce();

    expect(resolveBinaryPathMock).toHaveBeenCalledWith('ink');
    expect(command).toBe('/fake/bin/ink');
    expect(args).not.toContain(CLI);
    expect(args.slice(-2)).toEqual(['--message', 'hello']);
  });
});
