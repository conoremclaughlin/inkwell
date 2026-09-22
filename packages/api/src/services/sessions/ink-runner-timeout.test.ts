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
 *
 * The second block covers what the runner SAYS when a turn fails, which is a
 * separate contract from when it reaps one: that text is quoted verbatim into
 * the heartbeat outage alert a human reads.
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
// Only the three side-effecting helpers are stubbed. Everything else is the
// real module: `describeExit` is pure, and stubbing it would mean these tests
// no longer observe the text the runner actually rejects with.
vi.mock('@inklabs/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inklabs/shared')>()),
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

const baseConfig = { workingDirectory: '/tmp', sbSlug: 'myra', inkSessionId: 'sess-1' };

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
    // Stay under the absolute backstop (derive from the constants so this holds
    // regardless of their exact values / ratio).
    const step = INACTIVITY_TIMEOUT_MS - 1000;
    const iterations = Math.max(2, Math.floor(PROCESS_TIMEOUT_MS / step) - 1);
    for (let i = 0; i < iterations; i++) {
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

/**
 * A runtime error whose cause is on the first line and whose stack runs past
 * any alert-sized budget — ~1.1KB of frames under one 19-character sentence.
 * Kept verbatim from Lumen's review of PR #662 so the red/green evidence he
 * measured and the check that shipped are the same check.
 */
function errorOverLongStack(): string {
  const frames = Array.from(
    { length: 10 },
    (_, i) =>
      `    at step${i} (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)`
  );
  return `Error: fetch failed\n${frames.join('\n')}`;
}

describe('InkRunner failure text', () => {
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

  it('quotes the cause from the tail of stdout, not the banner at its head', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('hello', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    // The shape that produced the unreadable alert: ink reports the fatal
    // error on STDOUT with stderr empty, behind a banner long enough to fill
    // the old 1000-char HEAD slice on its own — so the head never reached the
    // cause, and what it did reach was mostly escape sequences.
    const banner =
      '\x1b[2mApplied "Safe" profile\x1b[0m\n' +
      '\x1b[36mIdentity context loaded:\x1b[0m wren\n' +
      '{"type":"session_meta","id":"sess-1"}\n' +
      '\x1b[38;5;213m▛▀▀▜\x1b[0m\n'.repeat(80);
    const cause = 'Error: backend refused the run: no writer available';

    expect(banner.length).toBeGreaterThan(1000); // else the old head slice would have caught the cause anyway

    child.stdout.emit('data', Buffer.from(`${banner}${cause}\n`));
    child.emit('close', 1);

    const result = await runPromise;

    expect(result.success).toBe(false);
    // The diagnostic survives...
    expect(result.error).toContain('no writer available');
    // ...and the noise that buried it does not.
    expect(result.error).not.toContain('\x1b');
    expect(result.error).not.toContain('Applied "Safe" profile');
    expect(result.error).not.toContain('session_meta');
  });

  it('says so explicitly when a failed turn produced no output at all', async () => {
    const runner = new InkRunner();
    const runPromise = runner.run('hello', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    child.emit('close', 1);

    const result = await runPromise;

    expect(result.success).toBe(false);
    // An empty quote reads as "no error given"; this has to be unambiguous.
    expect(result.error).toContain('no diagnostic output');
  });

  it('leaves the error line classifiable under a stack long enough to bury it', async () => {
    const { classifyError } = await import('@inklabs/shared');
    const runner = new InkRunner();
    const runPromise = runner.run('hello', { config: baseConfig as never });
    await vi.advanceTimersByTimeAsync(0);

    // Lumen's fixture, review of PR #662. An ordinary Node failure: the cause
    // is the FIRST line and the stack that follows it is longer than a display
    // budget. Asserted through `classifyError` on the real result rather than
    // on the excerpt directly, because the defect was that this string is what
    // session-service classifies — a test that fed the classifier its own text
    // would pass against the bug.
    child.stderr.emit('data', Buffer.from(errorOverLongStack()));
    child.emit('close', 1);

    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(classifyError({ errorText: result.error || '' }).category).toBe('network');
  });
});
