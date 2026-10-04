/**
 * A turn that is still producing output is never killed on wall-clock.
 *
 * Conor, 2026-10-04 (the turn-timeouts thread): every ceiling kill in the
 * thirty hours before stopped a turn that was writing seconds earlier, so the
 * general ceiling goes, the silence timeout stays, and a ceiling exists only
 * when one is configured (turn-ceiling.ts). These tests run with no ceiling
 * configured, which is the default; runner-timeout-classification.test.ts
 * configures one and checks it still kills.
 *
 * Each runner is driven through a fake child with real (faked) timers:
 *   - output every half silence-window for three hours: not killed, and the
 *     turn still ends as a success when the process exits;
 *   - a silence of the full window: stopped, as before. Codex had no silence
 *     timeout while it had a ceiling, so for it this is new.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  delete process.env.CLAUDE_PROCESS_TIMEOUT_MS;
  delete process.env.GEMINI_PROCESS_TIMEOUT_MS;
  delete process.env.CODEX_PROCESS_TIMEOUT_MS;
});

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
  applyPermissionOverlay: vi.fn(async () => async () => {}),
}));

import {
  ClaudeRunner,
  IDLE_TIMEOUT_MS as CLAUDE_IDLE_TIMEOUT_MS,
  PROCESS_TIMEOUT_MS as CLAUDE_PROCESS_TIMEOUT_MS,
} from './claude-runner.js';
import {
  GeminiRunner,
  IDLE_TIMEOUT_MS as GEMINI_IDLE_TIMEOUT_MS,
  PROCESS_TIMEOUT_MS as GEMINI_PROCESS_TIMEOUT_MS,
} from './gemini-runner.js';
import {
  CodexRunner,
  IDLE_TIMEOUT_MS as CODEX_IDLE_TIMEOUT_MS,
  PROCESS_TIMEOUT_MS as CODEX_PROCESS_TIMEOUT_MS,
} from './codex-runner.js';
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

const baseConfig = (): ClaudeRunnerConfig =>
  ({ workingDirectory: '/tmp/fake-work', sbSlug: 'wren' }) as ClaudeRunnerConfig;

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

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

async function settleSpawn() {
  await vi.advanceTimersByTimeAsync(0);
  expect(spawnMock).toHaveBeenCalledOnce();
}

/**
 * Output every half silence-window for `totalMs`, or until killed. Returns
 * the fake time that actually passed, so a test can prove the loop ran: a
 * window that is not a positive number would advance nothing and pass
 * vacuously.
 */
async function keepWriting(idleMs: number, totalMs: number, line: string): Promise<number> {
  expect(Number.isFinite(idleMs) && idleMs > 0, 'silence window').toBe(true);
  const step = Math.floor(idleMs / 2);
  let elapsed = 0;
  while (elapsed < totalMs && child.kill.mock.calls.length === 0) {
    child.stdout.emit('data', `${line}\n`);
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
  return elapsed;
}

const runners = [
  {
    name: 'ClaudeRunner',
    make: () => new ClaudeRunner(),
    idleMs: CLAUDE_IDLE_TIMEOUT_MS,
    ceiling: () => CLAUDE_PROCESS_TIMEOUT_MS,
    noise: JSON.stringify({ type: 'system', subtype: 'noise' }),
    finish: () => {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`
      );
      child.emit('close', 0);
    },
  },
  {
    name: 'GeminiRunner',
    make: () => new GeminiRunner(),
    idleMs: GEMINI_IDLE_TIMEOUT_MS,
    ceiling: () => GEMINI_PROCESS_TIMEOUT_MS,
    noise: JSON.stringify({ type: 'noise' }),
    finish: () => child.emit('close', 0),
  },
  {
    name: 'CodexRunner',
    make: () => new CodexRunner(),
    idleMs: CODEX_IDLE_TIMEOUT_MS,
    ceiling: () => CODEX_PROCESS_TIMEOUT_MS,
    noise: JSON.stringify({ type: 'item.started' }),
    finish: () => child.emit('close', 0),
  },
];

describe('CodexRunner silence window', () => {
  it('is no shorter than the 30-minute ceiling it replaces', () => {
    // `codex exec --json` is silent through a long reasoning item or command,
    // so a shorter window could stop a turn the old ceiling let finish
    // (Lumen, #745). At 30 minutes it never stops one sooner.
    expect(CODEX_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});

describe.each(runners)('$name with no ceiling configured', (r) => {
  it('has no ceiling', () => {
    expect(r.ceiling()).toBeUndefined();
  });

  it('is not killed after three hours while output keeps flowing, and ends as a success', async () => {
    const runPromise = r.make().run('long job', { config: baseConfig() });
    await settleSpawn();

    const elapsed = await keepWriting(r.idleMs, THREE_HOURS_MS, r.noise);
    expect(child.kill).not.toHaveBeenCalled();
    expect(elapsed).toBeGreaterThanOrEqual(THREE_HOURS_MS);

    r.finish();
    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('is still stopped by its silence timeout', async () => {
    const runPromise = r.make().run('wedged', { config: baseConfig() });
    await settleSpawn();

    // An hour of work first, then a last line, then nothing.
    expect(await keepWriting(r.idleMs, THREE_HOURS_MS / 3, r.noise)).toBeGreaterThanOrEqual(
      THREE_HOURS_MS / 3
    );
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', `${r.noise}\n`);

    await vi.advanceTimersByTimeAsync(r.idleMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // A killed Claude turn settles once its process exits (#743).
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null);
    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(result.error).toMatch(/no output/i);
  });
});
