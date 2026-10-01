/** No native process, server or model: only an EventEmitter TUI and RPC stub.
 * HOME is isolated before importing modules that can persist runtime state. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), gateway: vi.fn(), poll: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('./gateway.js', () => ({ startCodexMailGateway: mocks.gateway }));
vi.mock('./poller.js', () => ({ createCodexMailPoller: () => mocks.poll }));
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
      warn: vi.fn(() => true),
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
  it('renders one native warning per hook state, never writes over the TUI, and resumes after trust', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-interactive-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('CODEX_HOME', join(root, 'codex'));
    vi.stubEnv('TMPDIR', root);
    vi.useFakeTimers();
    const { runCodexMailInteractive } = await import('./interactive.js');
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    mocks.spawn.mockReturnValue(child);
    const expected = [
      {
        event: 'SessionStart',
        eventName: 'sessionStart',
        command: 'ink hooks on-session-start --backend codex --codex-inkmail-only',
      },
    ];
    let state = 'missing';
    const nativeWarning = vi.fn(() => true),
      onStderr = vi.fn();
    mocks.poll.mockResolvedValue({ threadResult: { fetchFailures: 0 } });
    mocks.gateway.mockResolvedValue({
      endpoint: 'unix://fixture',
      isHealthy: () => true,
      stop: vi.fn(),
      warn: nativeWarning,
      request: vi.fn(async (method) =>
        method === 'config/read'
          ? { config: { features: { hooks: true } } }
          : {
              data: [
                {
                  hooks:
                    state === 'missing'
                      ? []
                      : expected.map((h) => ({ ...h, enabled: true, trustStatus: state })),
                },
              ],
            }
      ),
    });
    const running = runCodexMailInteractive(
      {
        binary: 'fixture-only',
        args: [],
        env: {},
        cwd: root,
        sbSlug: 'fixture',
        sessionId: 'fixture-session',
        studioId: 'fixture-studio',
        onBound: async () => {},
        onStderr,
      },
      { cwd: root, serverArgs: [], tuiArgs: [], threadOverrides: {}, expectedHooks: expected }
    );
    try {
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      await mocks.gateway.mock.calls[0][0].onBound('parent-thread');
      await vi.advanceTimersByTimeAsync(180_000);
      expect(nativeWarning).toHaveBeenCalledOnce();
      expect(nativeWarning.mock.calls[0][0]).toContain('did not load');
      expect(nativeWarning.mock.calls[0][0]).toContain('--no-codex-inkmail');
      expect(mocks.poll).not.toHaveBeenCalled();
      state = 'untrusted';
      await vi.advanceTimersByTimeAsync(120_000);
      expect(nativeWarning).toHaveBeenCalledTimes(2);
      expect(nativeWarning.mock.calls[1][0]).toContain('review and trust');
      expect(mocks.poll).not.toHaveBeenCalled();
      state = 'trusted';
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.poll).toHaveBeenCalledOnce();
      expect(nativeWarning.mock.calls[2][0]).toContain('can resume');
      expect(onStderr).not.toHaveBeenCalled();
    } finally {
      child.emit('close', 0);
      await running;
    }
    expect(onStderr).not.toHaveBeenCalled();
  });
});
