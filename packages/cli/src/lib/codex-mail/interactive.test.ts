/** No native process, server or model: only an EventEmitter TUI and RPC stub.
 * HOME is isolated before importing modules that can persist runtime state. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  gateway: vi.fn(),
  poll: vi.fn(),
  createPoller: vi.fn(),
  pulse: vi.fn(),
  callInk: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('./gateway.js', () => ({ startCodexMailGateway: mocks.gateway }));
vi.mock('./poller.js', () => ({ createCodexMailPoller: mocks.createPoller }));
vi.mock('./heartbeat.js', () => ({ pulseCodexMail: mocks.pulse }));
vi.mock('../ink-mcp.js', () => ({
  getInkServerUrl: () => 'http://127.0.0.1:9',
  callInkTool: mocks.callInk,
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
    mocks.createPoller.mockReturnValue(mocks.poll);
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
    mocks.createPoller.mockReturnValue(mocks.poll);
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

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ink-interactive-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('CODEX_HOME', join(root, 'codex'));
    vi.stubEnv('TMPDIR', root);
    vi.useFakeTimers();
    const { runCodexMailInteractive } = await import('./interactive.js');
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    let childClosed = false;
    child.once('close', () => {
      childClosed = true;
    });
    mocks.spawn.mockReturnValue(child);
    const expected = [
      {
        event: 'SessionStart',
        eventName: 'sessionStart',
        command: 'ink hooks on-session-start --backend codex --codex-inkmail-only',
      },
    ];
    const nativeWarning = vi.fn((_message: string) => true);
    const onStderr = vi.fn((_chunk: Buffer) => {
      expect(childClosed).toBe(true);
    });
    mocks.callInk.mockResolvedValue({ success: true });
    mocks.createPoller.mockReturnValue(mocks.poll);
    mocks.poll.mockImplementation(async () => {
      await mocks.createPoller.mock.calls[0][0].callInk('get_inbox', {});
      return { threadResult: { fetchFailures: 0 } };
    });
    mocks.pulse.mockResolvedValue(true);
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
                { hooks: expected.map((h) => ({ ...h, enabled: true, trustStatus: 'trusted' })) },
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
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    return {
      nativeWarning,
      onStderr,
      callbacks: mocks.gateway.mock.calls[0][0],
      close: async () => {
        child.emit('close', 0);
        await running;
      },
    };
  }

  it('reports heartbeat failure again after a successful stamp, but not after a skipped stamp', async () => {
    const f = await fixture();
    let pulse: 'fail' | 'skip' | 'success' = 'fail';
    mocks.pulse.mockImplementation(async () => {
      if (pulse === 'fail') throw new Error('fixture heartbeat failure');
      return pulse === 'success';
    });
    try {
      await f.callbacks.onBound('parent-thread');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.nativeWarning).toHaveBeenCalledOnce();
      expect(f.nativeWarning.mock.calls[0][0]).toContain('heartbeat failed');
      pulse = 'skip';
      await vi.advanceTimersByTimeAsync(5000);
      pulse = 'fail';
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.nativeWarning).toHaveBeenCalledOnce();
      pulse = 'success';
      await vi.advanceTimersByTimeAsync(5000);
      pulse = 'fail';
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.nativeWarning).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
    expect(f.onStderr).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'reports poller log failures again only after a clean poll (fetch failures: %s)',
    async (fetchFailures) => {
      const f = await fixture();
      let failing = true;
      mocks.poll.mockImplementation(async () => {
        if (failing) {
          const log = mocks.createPoller.mock.calls[0][0].log;
          log('error', 'fixture thread fetch failed');
          log('error', 'fixture ack failed');
        }
        return { threadResult: { fetchFailures: failing ? fetchFailures : 0 } };
      });
      try {
        await f.callbacks.onBound('parent-thread');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.nativeWarning).toHaveBeenCalledTimes(2);
        failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        failing = true;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.nativeWarning).toHaveBeenCalledTimes(4);
      } finally {
        await f.close();
      }
      expect(f.onStderr).not.toHaveBeenCalled();
    }
  );

  it('flushes a deferred warning once on bind without printing it after exit', async () => {
    const f = await fixture();
    try {
      await f.callbacks.onBound('parent-thread');
      f.nativeWarning.mockReturnValue(false);
      await f.callbacks.onBound('other-thread');
      expect(f.nativeWarning).toHaveBeenCalledOnce();
      expect(f.onStderr).not.toHaveBeenCalled();
      f.nativeWarning.mockReturnValue(true);
      await f.callbacks.onBound('other-thread');
      expect(f.nativeWarning).toHaveBeenCalledTimes(2);
      expect(f.nativeWarning.mock.calls[1]).toEqual(f.nativeWarning.mock.calls[0]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.nativeWarning).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
    expect(f.onStderr).not.toHaveBeenCalled();
  });

  it('prints an undeliverable warning exactly once after child close, never over the live terminal', async () => {
    const f = await fixture();
    try {
      await f.callbacks.onBound('parent-thread');
      f.nativeWarning.mockReturnValue(false);
      await f.callbacks.onBound('other-thread');
      await f.callbacks.onBound('other-thread');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.onStderr).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
    expect(f.onStderr).toHaveBeenCalledOnce();
    expect(f.onStderr.mock.calls[0][0].toString()).toContain('terminal changed Codex threads');
  });
});
