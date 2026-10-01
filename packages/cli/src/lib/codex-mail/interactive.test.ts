/** No native process, server or model: only an EventEmitter TUI and RPC stub.
 * HOME is isolated before importing modules that can persist runtime state. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), gateway: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('./gateway.js', () => ({ startCodexMailGateway: mocks.gateway }));
vi.mock('./poller.js', () => ({ createCodexMailPoller: () => vi.fn() }));
vi.mock('../ink-mcp.js', () => ({
  getInkServerUrl: () => 'http://127.0.0.1:9',
  callInkTool: vi.fn(),
}));
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('interactive bridge ownership', () => {
  it('keeps a switched bridge paused without rebinding or closing the TUI when returning to the original thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-interactive-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('CODEX_HOME', join(root, 'codex'));
    vi.stubEnv('TMPDIR', root);
    vi.useFakeTimers();
    const { runCodexMailInteractive } = await import('./interactive.js');
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    mocks.spawn.mockReturnValue(child);
    const stop = vi.fn(async () => {});
    mocks.gateway.mockResolvedValue({
      request: vi.fn(),
      isHealthy: () => true,
      stop,
      endpoint: 'unix://fixture',
    });
    const onBound = vi.fn(async (_id: string) => {});
    const running = runCodexMailInteractive(
      {
        binary: 'fixture-only',
        args: [],
        env: {},
        cwd: root,
        sbSlug: 'fixture',
        sessionId: 'fixture-session',
        studioId: 'fixture-studio',
        onBound,
        onStderr: vi.fn(),
      },
      { cwd: root, serverArgs: [], tuiArgs: [], threadOverrides: {}, expectedHooks: [] }
    );
    try {
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      const callback = mocks.gateway.mock.calls[0][0].onBound;
      const bindingPath = mocks.spawn.mock.calls[0][2].env.INK_CODEX_INKMAIL_BINDING;
      await callback('parent-thread');
      expect(existsSync(bindingPath)).toBe(true);
      await callback('other-thread');
      expect(existsSync(bindingPath)).toBe(false);
      await expect(callback('parent-thread')).resolves.toBeUndefined();
      await callback('another-thread');
      expect(existsSync(bindingPath)).toBe(false);
      expect(onBound.mock.calls.map(([id]) => id)).toEqual(['parent-thread']);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      child.emit('close', 0);
      await running;
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
