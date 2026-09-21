/**
 * A turn we killed is not a turn that finished.
 *
 * ClaudeRunner, GeminiRunner and CodexRunner all reaped a wedged subprocess by
 * calling `resolve()` with a marker string in `finalTextResponse` and nothing
 * else. `run()` then returned `success: true`, because on those paths success
 * meant only "we did not throw". Three things followed from that single bit:
 *
 *   1. `session-service` writes lifecycle `idle` rather than `failed`
 *      (`postRunLifecycle = result.success ? 'idle' : 'failed'`).
 *   2. A heartbeat beat records `reminder_history.status = 'delivered'` with a
 *      null error — so a beat SIGKILLed after five silent minutes leaves a
 *      POSITIVE healthy row. An absence invites a question; a green row
 *      retires one, which is why this is worse than a missing record.
 *   3. `decideChannelForward` passes its `success` gate, and the marker
 *      `[Process timed out after 300s idle]` is auto-forwarded to the human as
 *      if the agent had written it.
 *
 * AntigravityRunner already carries the fix and the reasoning (Lumen, #507):
 * "run() decides success from `status`, so resolving bare reports a killed
 * turn as a successful one". The same bug sat in the three runners beside it.
 * InkRunner was never affected — SIGTERM makes the child exit non-zero and its
 * close handler rejects, which is the only reason the 2026-09-18 heartbeat
 * failure was visible at all.
 *
 * These tests drive the REAL timers through a fake child process, so they
 * cover the timer populating the classification and `run()` mapping it — not
 * just one or the other. Each timeout case is paired with a control on the
 * same runner where the process exits normally, because an assertion that
 * `success` is false proves nothing if `success` is never true.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyError } from '@inklabs/shared';
import { decideChannelForward } from '../channel-forward.js';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn(async (name: string) => `/fake/bin/${name}`),
  buildSpawnPath: vi.fn(() => '/usr/bin:/bin'),
}));
vi.mock('../studio-paths.js', () => ({
  inkStudiosRoot: () => '/tmp/fake-ink-studios',
  ensureInkStudiosRoot: vi.fn(async () => {}),
}));
vi.mock('../studio-settings.js', () => ({
  ensureStudioSettings: vi.fn(async () => {}),
  applyPermissionOverlay: vi.fn(async () => async () => {}),
}));

import { ClaudeRunner, IDLE_TIMEOUT_MS, PROCESS_TIMEOUT_MS } from './claude-runner.js';
import {
  GeminiRunner,
  IDLE_TIMEOUT_MS as GEMINI_IDLE_TIMEOUT_MS,
  PROCESS_TIMEOUT_MS as GEMINI_PROCESS_TIMEOUT_MS,
} from './gemini-runner.js';
import { CodexRunner, PROCESS_TIMEOUT_MS as CODEX_PROCESS_TIMEOUT_MS } from './codex-runner.js';
import type { ClaudeRunnerConfig } from './types.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

/** No inkSessionId / mcpConfigPath / inkAccessToken: the pre-spawn hint,
 *  header-injection and settings-file branches stay out of the way. */
const baseConfig = (): ClaudeRunnerConfig =>
  ({ workingDirectory: '/tmp/fake-work', sbSlug: 'wren' }) as ClaudeRunnerConfig;

let child: FakeChild;

beforeEach(() => {
  vi.useFakeTimers();
  child = makeFakeChild();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Let the async pre-spawn work (binary resolution, studio root) settle. */
async function settleSpawn() {
  await vi.advanceTimersByTimeAsync(0);
  expect(spawnMock).toHaveBeenCalledOnce();
}

/**
 * Assert the shape every timed-out turn must have, whichever runner produced
 * it. Kept as one helper so a runner cannot be fixed to a weaker standard than
 * its siblings.
 */
function expectClassifiedTimeout(result: {
  success: boolean;
  error?: string;
  finalTextResponse?: string;
}) {
  // The bit the whole chain reads.
  expect(result.success).toBe(false);

  // A reason, not a bare false. `deliverReminderViaSession` writes
  // `result.error` into reminder_history.error_message, so a turn that fails
  // without one is recorded as "session reported failure with no detail".
  expect(result.error).toBeTruthy();
  expect(result.error).toMatch(/timeout|timed out/i);
  expect(result.error).toMatch(/killed/i);

  // classifyError keys on that wording. Without it the row lands in the
  // non-retryable `unknown` category, so the word is load-bearing rather than
  // decorative.
  const classification = classifyError({ errorText: result.error! });
  expect(classification.category).toBe('timeout');
  expect(classification.retryable).toBe(true);

  // Nothing reaches the user: the marker must not be auto-forwarded as the
  // agent's answer.
  expect(
    decideChannelForward({
      hadExplicitResponse: false,
      success: result.success,
      finalTextResponse: result.finalTextResponse,
    })
  ).toEqual({ action: 'nothing-delivered', reason: 'run-failed' });
}

describe('ClaudeRunner — a killed turn is reported as a failure', () => {
  it('classifies an idle timeout instead of resolving as a completed turn', async () => {
    const runner = new ClaudeRunner();
    const runPromise = runner.run('do the thing', { config: baseConfig() });
    await settleSpawn();

    // Partial work first: the turn really started, and what it emitted must
    // survive the failure rather than being discarded.
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'starting on it' }] },
      })}\n`
    );

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await runPromise;
    expectClassifiedTimeout(result);
    // Partial text is kept — it is evidence of what the turn got through, and
    // the failure classification is what stops it being mistaken for an answer.
    expect(result.finalTextResponse).toBe('starting on it');
  });

  it('classifies the hard ceiling even while output keeps flowing', async () => {
    const runner = new ClaudeRunner();
    const runPromise = runner.run('runaway', { config: baseConfig() });
    await settleSpawn();

    // Emit steadily so the idle timer never trips — this must reach the
    // absolute backstop, not the idle path.
    const step = Math.floor(IDLE_TIMEOUT_MS / 2);
    const iterations = Math.ceil(PROCESS_TIMEOUT_MS / step) + 1;
    for (let i = 0; i < iterations && child.kill.mock.calls.length === 0; i++) {
      child.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'noise' })}\n`);
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await runPromise;
    expectClassifiedTimeout(result);
    expect(result.error).toMatch(/ceiling/);
  });

  it('CONTROL: a process that exits on its own is still a success', async () => {
    const runner = new ClaudeRunner();
    const runPromise = runner.run('quick', { config: baseConfig() });
    await settleSpawn();

    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'all done' })}\n`
    );
    child.emit('close', 0);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.finalTextResponse).toBe('all done');
    expect(child.kill).not.toHaveBeenCalled();
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: result.success,
        finalTextResponse: result.finalTextResponse,
      })
    ).toEqual({ action: 'auto-forward', content: 'all done' });
  });
});

describe('GeminiRunner — a killed turn is reported as a failure', () => {
  it('classifies an idle timeout instead of resolving as a completed turn', async () => {
    const runner = new GeminiRunner();
    const runPromise = runner.run('do the thing', { config: baseConfig() });
    await settleSpawn();

    await vi.advanceTimersByTimeAsync(GEMINI_IDLE_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    expectClassifiedTimeout(await runPromise);
  });

  it('classifies the hard ceiling even while output keeps flowing', async () => {
    const runner = new GeminiRunner();
    const runPromise = runner.run('runaway', { config: baseConfig() });
    await settleSpawn();

    const step = Math.floor(GEMINI_IDLE_TIMEOUT_MS / 2);
    const iterations = Math.ceil(GEMINI_PROCESS_TIMEOUT_MS / step) + 1;
    for (let i = 0; i < iterations && child.kill.mock.calls.length === 0; i++) {
      child.stdout.emit('data', `${JSON.stringify({ type: 'noise' })}\n`);
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await runPromise;
    expectClassifiedTimeout(result);
    expect(result.error).toMatch(/ceiling/);
  });

  it('CONTROL: a process that exits on its own is still a success', async () => {
    const runner = new GeminiRunner();
    const runPromise = runner.run('quick', { config: baseConfig() });
    await settleSpawn();

    child.emit('close', 0);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('CodexRunner — a killed turn is reported as a failure', () => {
  it('classifies the hard ceiling instead of resolving as a completed turn', async () => {
    const runner = new CodexRunner();
    const runPromise = runner.run('do the thing', { config: baseConfig() });
    await settleSpawn();

    await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await runPromise;
    expectClassifiedTimeout(result);
    expect(result.error).toMatch(/ceiling/);
  });

  it('CONTROL: a process that exits on its own is still a success', async () => {
    const runner = new CodexRunner();
    const runPromise = runner.run('quick', { config: baseConfig() });
    await settleSpawn();

    child.emit('close', 0);

    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
