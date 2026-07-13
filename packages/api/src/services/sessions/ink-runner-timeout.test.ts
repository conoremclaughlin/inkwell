/**
 * InkRunner inactivity-timeout tests.
 *
 * The ink backend is buffered (no token stream), so a working turn's only
 * mid-turn liveness signal is the NDJSON events it writes to stdout (one per
 * tool call). These tests drive a fake child process with fake timers to verify
 * that:
 *   - a silent (hung) process is reaped after the inactivity window,
 *   - stdout/stderr activity keeps a long-but-working turn alive,
 *   - the absolute backstop still reaps a process that emits forever,
 *   - provider-stall stderr signatures are classified in the kill log.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
const warnMock = vi.fn();

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => warnMock(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('./resolve-binary', () => ({
  resolveBinaryPath: vi.fn(async () => '/fake/bin/ink'),
  buildSpawnPath: vi.fn(() => '/usr/bin:/bin'),
}));
vi.mock('@inklabs/shared', () => ({
  injectSessionHeaders: vi.fn(() => null),
  buildSessionEnv: vi.fn(() => ({})),
  writeRuntimeSessionHint: vi.fn(),
}));

import { InkRunner, INACTIVITY_TIMEOUT_MS, PROCESS_TIMEOUT_MS } from './ink-runner';

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

describe('InkRunner inactivity timeout', () => {
  let child: FakeChild;

  beforeEach(() => {
    vi.useFakeTimers();
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    warnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reaps a silent process after the inactivity window', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('hello', { config: baseConfig as never });

    // Let the async spawn setup (resolveBinaryPath) settle so the child is wired.
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledOnce();

    // No output at all — just short of the window, still alive.
    await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();

    // Cross the window → SIGTERM.
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Killed process exits non-zero; run() resolves with a failure result.
    child.emit('close', 143);
    const result = await runPromise;
    expect(result.success).toBe(false);
  });

  it('keeps a long-but-working turn alive as long as stdout flows', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('bulk download', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    // Emit a tool_call line every (window - 1s) for well past the window's worth
    // of wall-clock. Each emission resets the idle timer, so it never trips.
    const step = INACTIVITY_TIMEOUT_MS - 1000;
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(step);
      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'tool_call', toolName: 'download_drive_file' })}\n`)
      );
    }
    expect(child.kill).not.toHaveBeenCalled();

    // Now go silent — the timer finally trips.
    await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', 143);
    await runPromise;
  });

  it('resolves normally when the process finishes before going idle', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('quick', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    child.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'result', text: 'done', sessionId: 'sess-1' })}\n`)
    );
    child.emit('close', 0);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.finalTextResponse).toBe('done');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reaps via the absolute backstop even if output never stops', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('runaway', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    // Emit steadily (resets inactivity forever) until just past the absolute cap.
    const step = 30_000;
    const iterations = Math.ceil(PROCESS_TIMEOUT_MS / step) + 1;
    for (let i = 0; i < iterations && !child.kill.mock.calls.length; i++) {
      child.stdout.emit('data', Buffer.from('noise\n'));
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', 143);
    await runPromise;
  });

  it('classifies a provider stall from stderr in the kill log', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('stalled', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    child.stderr.emit('data', Buffer.from('Error: stream disconnected before completion\n'));
    await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const idleWarn = warnMock.mock.calls.find((c) => String(c[0]).includes('idle for'));
    expect(idleWarn).toBeDefined();
    expect(idleWarn?.[1]).toMatchObject({
      cause: 'provider-stall',
      stallSignature: 'stream disconnected',
    });

    child.emit('close', 143);
    await runPromise;
  });

  it('only kills once even if both timers would fire', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('x', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS);
    // SIGTERM once, plus the delayed SIGKILL escalation — but only one SIGTERM.
    const sigterms = child.kill.mock.calls.filter((c) => c[0] === 'SIGTERM');
    expect(sigterms).toHaveLength(1);

    child.emit('close', 143);
    await runPromise;
  });
});
