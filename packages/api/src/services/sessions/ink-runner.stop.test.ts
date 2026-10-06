/**
 * An inkling turn on the ink runtime, stopped the way a Claude one is (#747):
 * through the real InkRunner and a fake `ink` (INK_CLI_PATH), run by node.
 * The fake reads what to do from a data file beside it and records every
 * spawn, so a test can count attempts. Every pid it reports is killed by that
 * exact pid afterwards, and the only groups signalled are its own.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtures = mkdtempSync(join(tmpdir(), 'ink-fake-stop-'));
const fake = join(fixtures, 'ink.mjs');
const behaviourPath = join(fixtures, 'behaviour.json');
const pidsPath = join(fixtures, 'pids.json');
const spawnsPath = join(fixtures, 'spawns.log');

const hoisted = vi.hoisted(() => ({
  scriptedStop: null as null | { exited: boolean; group?: 'empty' | 'alive' | 'unknown' },
}));

// The real stop, except where a test needs one that is never confirmed: no
// real process outlives SIGKILL, so that one answer is scripted.
vi.mock('./stop-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stop-process.js')>();
  return {
    ...actual,
    stopProcessAndWait: (...args: Parameters<typeof actual.stopProcessAndWait>) =>
      hoisted.scriptedStop
        ? Promise.resolve(hoisted.scriptedStop)
        : actual.stopProcessAndWait(...args),
  };
});

import { InkRunner, BOOTSTRAP_REQUIRED_EXIT_MARKER } from './ink-runner.js';
import { resolveInkCli } from '../ink-cli.js';
import { STOP_GRACE_MS } from './stop-process.js';

/**
 * What the fake does, as data. It reports its pid (and its tool's) only once
 * its handlers are in place, then writes `stdoutLines` and `stderrText`, then
 * exits with `exitCode`, or hangs when that is null.
 */
interface Behaviour {
  stdoutLines?: string[];
  stderrText?: string;
  exitCode?: number | null;
  /** Start a tool child that ignores SIGTERM (it stays in the group). */
  tool?: boolean;
  /** The tool inherits the leader's stdout, so the pipe stays open while it lives. */
  toolHoldsStdout?: boolean;
  /** Exit on SIGTERM (a leader that goes at once). */
  exitOnTerm?: boolean;
}

writeFileSync(
  fake,
  [
    "import { spawn } from 'child_process';",
    "import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';",
    "import { dirname, join } from 'path';",
    "import { fileURLToPath } from 'url';",
    'const here = dirname(fileURLToPath(import.meta.url));',
    "const b = JSON.parse(readFileSync(join(here, 'behaviour.json'), 'utf-8'));",
    "appendFileSync(join(here, 'spawns.log'), process.pid + '\\n');",
    "process.on('SIGTERM', () => { if (b.exitOnTerm) process.exit(0); });",
    "const report = (pids) => writeFileSync(join(here, 'pids.json'), JSON.stringify(pids));",
    'const go = () => {',
    '  for (const line of b.stdoutLines || []) process.stdout.write(line + "\\n");',
    '  if (b.stderrText) process.stderr.write(b.stderrText);',
    '  if (b.exitCode !== null && b.exitCode !== undefined) setTimeout(() => process.exit(b.exitCode), 50);',
    '};',
    'if (b.tool) {',
    "  const toolPidPath = join(here, 'tool.pid');",
    '  rmSync(toolPidPath, { force: true });',
    `  const tool = "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";`,
    "  spawn(process.execPath, ['-e', tool, toolPidPath], { stdio: b.toolHoldsStdout ? ['ignore', 'inherit', 'ignore'] : 'ignore' });",
    '  const wait = setInterval(() => {',
    '    if (!existsSync(toolPidPath)) return;',
    "    const toolPid = Number(readFileSync(toolPidPath, 'utf-8'));",
    '    if (!(toolPid > 0)) return;',
    '    clearInterval(wait);',
    '    report([process.pid, toolPid]);',
    '    go();',
    '  }, 20);',
    '} else {',
    '  report([process.pid]);',
    '  go();',
    '}',
    'setInterval(() => {}, 1000);',
  ].join('\n')
);

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

const reported = (): number[] =>
  existsSync(pidsPath) ? (JSON.parse(readFileSync(pidsPath, 'utf-8')) as number[]) : [];
const spawnCount = (): number =>
  existsSync(spawnsPath)
    ? readFileSync(spawnsPath, 'utf-8').trim().split('\n').filter(Boolean).length
    : 0;

afterEach(() => {
  for (const pid of [
    ...reported(),
    ...(existsSync(spawnsPath)
      ? readFileSync(spawnsPath, 'utf-8').trim().split('\n').filter(Boolean).map(Number)
      : []),
  ]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const path of [pidsPath, spawnsPath, behaviourPath, join(fixtures, 'tool.pid')]) {
    rmSync(path, { force: true });
  }
  hoisted.scriptedStop = null;
  vi.unstubAllEnvs();
});

/**
 * Sets the fake's behaviour and points InkRunner at it. Refuses to go on
 * unless the fake is what will actually run: falling back to this checkout's
 * real CLI would start a real `ink chat`, which can reach a model.
 */
function behave(behaviour: Behaviour): void {
  writeFileSync(behaviourPath, JSON.stringify(behaviour));
  vi.stubEnv('INK_CLI_PATH', fake);
  const cli = resolveInkCli();
  if (cli?.path !== fake || !cli.script) {
    throw new Error('InkRunner would not run the fake ink; refusing to spawn anything');
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function whenReported(): Promise<number[]> {
  const until = Date.now() + 10_000;
  while (reported().length === 0) {
    if (Date.now() > until) throw new Error('the fake never reported its pid');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return reported();
}

const baseConfig = { workingDirectory: fixtures, mcpConfigPath: '', sbSlug: 'synthetic' };

/** A complete, invented context, so a fresh attempt can format it. */
const syntheticContext = {
  agent: {
    sbSlug: 'synthetic',
    name: 'Synthetic',
    role: 'companion',
    values: [],
    capabilities: [],
    relationships: {},
  },
  user: { id: 'synthetic-user', timezone: 'America/Los_Angeles', contacts: {}, preferences: {} },
  temporal: {
    currentTime: '1:00 PM',
    currentDate: '2026-10-04',
    dayOfWeek: 'Sunday',
    timezone: 'America/Los_Angeles',
    greeting: 'Hello',
  },
  recentMemories: [],
  activeProjects: [],
};

describe('InkRunner: an inkling turn stopped as a group (parity with #747)', () => {
  it('a cancelled run whose leader exits on SIGTERM settles only once its TERM-ignoring tool is gone', async () => {
    behave({ tool: true, exitOnTerm: true });
    const controller = new AbortController();
    const run = new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    const [leader, tool] = await whenReported();
    const stoppedAt = Date.now();
    controller.abort();
    const result = await run;
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(STOP_GRACE_MS - 100);
    expect(alive(leader)).toBe(false);
    expect(alive(tool)).toBe(false);
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat turn cancelled, process stopped',
    });
    expect(String(result.error)).not.toMatch(/timeout/i);
    expect(result.stopUnconfirmed).toBeUndefined();
  }, 20_000);

  it('a stop that cannot be confirmed is reported, and recovery text in its output never starts another attempt', async () => {
    // Its output carries both recovery signatures; a resume plus injected
    // context would let either one start a second attempt.
    behave({
      stdoutLines: [],
      stderrText: `session not found\n${BOOTSTRAP_REQUIRED_EXIT_MARKER}\n`,
      exitCode: null,
    });
    hoisted.scriptedStop = { exited: false, group: 'alive' };
    const controller = new AbortController();
    const run = new InkRunner().run('hello', {
      backendSessionId: 'synthetic-resume',
      injectedContext: syntheticContext as never,
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    const [leader] = await whenReported();
    controller.abort();
    const result = await run;
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat turn cancelled; its processes did not confirm they had stopped',
      stopUnconfirmed: { leaderExited: false, pgid: leader, group: 'alive' },
    });
    expect(spawnCount()).toBe(1);
  }, 20_000);

  it('a group stop is confirmed only by an empty group: an outcome that says nothing of the group leaves it unconfirmed', async () => {
    behave({ exitCode: null });
    hoisted.scriptedStop = { exited: true };
    const controller = new AbortController();
    const run = new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    const [leader] = await whenReported();
    controller.abort();
    const result = await run;
    expect(result.error).toBe(
      'ink chat turn cancelled; its processes did not confirm they had stopped'
    );
    expect(result.stopUnconfirmed).toEqual({ leaderExited: true, pgid: leader });
  }, 20_000);

  it('a cancelled run keeps the usage and responses its process reported, without calling the turn a success', async () => {
    behave({
      stdoutLines: [
        JSON.stringify({ type: 'send_response', channel: 'api', content: 'partial reply' }),
        JSON.stringify({
          type: 'result',
          text: 'stopped mid-thought',
          usage: { contextTokens: 10, inputTokens: 7, outputTokens: 3 },
        }),
      ],
      exitOnTerm: true,
      exitCode: null,
    });
    const controller = new AbortController();
    const run = new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    await whenReported();
    // Long enough for the lines to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await run;
    expect(result.success).toBe(false);
    expect(result.responses).toEqual([
      expect.objectContaining({ channel: 'api', content: 'partial reply' }),
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.finalTextResponse).toBe('stopped mid-thought');
  }, 20_000);

  it('a leader that exits while a descendant still holds its stdout settles on the group, not on the pipe closing', async () => {
    // The tool keeps the stdout pipe open, so `close` cannot fire while it
    // lives. The stop settles on the leader's exit plus an empty group, once
    // the group's SIGKILL has taken the tool.
    behave({ tool: true, toolHoldsStdout: true, exitOnTerm: true, exitCode: null });
    const controller = new AbortController();
    const run = new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    const [leader, tool] = await whenReported();
    const stoppedAt = Date.now();
    controller.abort();
    const result = await run;
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(STOP_GRACE_MS - 100);
    expect(alive(leader)).toBe(false);
    expect(alive(tool)).toBe(false);
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat turn cancelled, process stopped',
    });
    expect(result.stopUnconfirmed).toBeUndefined();
  }, 20_000);

  it("stops at the run's own ceiling, and nothing it started is left running", async () => {
    behave({ tool: true, exitOnTerm: true, exitCode: null });
    const run = new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, timeoutMs: 1000 } as never,
    });
    const [leader, tool] = await whenReported();
    const result = await run;
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat timeout: exceeded the 1s ceiling, process stopped',
    });
    expect(alive(leader)).toBe(false);
    expect(alive(tool)).toBe(false);
  }, 20_000);
});

describe("InkRunner: the caller's admission at every physical spawn", () => {
  it('a refusal at the first spawn starts nothing', async () => {
    behave({ exitCode: 0 });
    const result = await new InkRunner().run('hello', {
      config: { ...baseConfig, admitSpawn: () => 'Synthetic refusal' } as never,
    });
    expect(result).toMatchObject({
      success: false,
      error: 'Synthetic refusal',
      refusedBeforeSpawn: true,
    });
    expect(spawnCount()).toBe(0);
  });

  it('an already-aborted signal starts nothing', async () => {
    behave({ exitCode: 0 });
    const controller = new AbortController();
    controller.abort();
    const result = await new InkRunner().run('hello', {
      config: { ...baseConfig, killProcessGroup: true, signal: controller.signal } as never,
    });
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat turn cancelled, process stopped',
    });
    expect(spawnCount()).toBe(0);
  });

  it('a fence that lands during the first attempt refuses the recovery attempt', async () => {
    // The first attempt fails for want of identity context, which would
    // otherwise be retried with the server's copy.
    behave({ stderrText: `${BOOTSTRAP_REQUIRED_EXIT_MARKER}\n`, exitCode: 1 });
    let calls = 0;
    const result = await new InkRunner().run('hello', {
      injectedContext: syntheticContext as never,
      config: {
        ...baseConfig,
        admitSpawn: () => (++calls > 1 ? 'Synthetic refusal' : undefined),
      } as never,
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ success: false, refusedBeforeSpawn: true });
    expect(spawnCount()).toBe(1);
  }, 20_000);

  it('a cancel that lands before the recovery attempt starts no second process', async () => {
    behave({ stderrText: `${BOOTSTRAP_REQUIRED_EXIT_MARKER}\n`, exitCode: 1 });
    const controller = new AbortController();
    let calls = 0;
    const result = await new InkRunner().run('hello', {
      injectedContext: syntheticContext as never,
      config: {
        ...baseConfig,
        killProcessGroup: true,
        signal: controller.signal,
        // The owner presses Stop as the recovery attempt is about to start.
        admitSpawn: () => {
          if (++calls > 1) controller.abort();
          return undefined;
        },
      } as never,
    });
    expect(result).toMatchObject({
      success: false,
      error: 'ink chat turn cancelled, process stopped',
    });
    expect(spawnCount()).toBe(1);
  }, 20_000);

  it('an admitting gate spawns as before (control)', async () => {
    behave({
      stdoutLines: [JSON.stringify({ type: 'result', text: 'done' })],
      exitCode: 0,
    });
    const asked: number[] = [];
    const result = await new InkRunner().run('hello', {
      config: { ...baseConfig, admitSpawn: () => (asked.push(1), undefined) } as never,
    });
    expect(asked).toHaveLength(1);
    expect(result).toMatchObject({ success: true, finalTextResponse: 'done' });
    expect(spawnCount()).toBe(1);
  }, 20_000);
});
