/**
 * An inkling turn's ceiling and stop, through the real ClaudeRunner and a
 * fake `claude` binary (as claude-runner.spawn-env.test.ts does): only
 * binary resolution is stubbed. The fake ignores SIGTERM and starts a
 * grandchild that ignores it too, the way a tool a turn started might.
 * Every pid it reports is killed by that exact pid afterwards.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtures = mkdtempSync(join(tmpdir(), 'claude-fake-stop-'));
const pidsPath = join(fixtures, 'pids.json');
const hoisted = vi.hoisted(() => ({
  binary: '',
  scriptedStop: null as null | { exited: boolean; group?: 'empty' | 'alive' | 'unknown' },
  /** Stands in for the permission overlay, the last await before the spawn; returns its restore. */
  overlay: null as null | (() => () => Promise<void>),
}));

vi.mock('./resolve-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve-binary.js')>();
  return { ...actual, resolveBinaryPath: () => Promise.resolve(hoisted.binary) };
});

// The real stop, except where a test needs a stop that is never confirmed:
// no real process outlives SIGKILL, so that one answer is scripted.
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

vi.mock('../studio-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../studio-settings.js')>();
  return {
    ...actual,
    applyPermissionOverlay: (...args: Parameters<typeof actual.applyPermissionOverlay>) =>
      hoisted.overlay ? Promise.resolve(hoisted.overlay()) : actual.applyPermissionOverlay(...args),
  };
});

import { ClaudeRunner } from './claude-runner.js';
import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from './stop-process.js';

const IGNORES_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

const reported = (): number[] =>
  existsSync(pidsPath) ? (JSON.parse(readFileSync(pidsPath, 'utf-8')) as number[]) : [];

afterEach(() => {
  for (const pid of reported()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(pidsPath, { force: true });
});

/** A fake claude that ignores SIGTERM and starts a grandchild that does too. */
function writeHangingFake(): string {
  const fake = join(fixtures, 'claude-hangs.mjs');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "import { spawn } from 'child_process';",
      "import { writeFileSync } from 'fs';",
      `const g = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, g.pid]));`,
      IGNORES_TERM,
    ].join('\n'),
    { mode: 0o755 }
  );
  chmodSync(fake, 0o755);
  return fake;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake claude that exits `exitAfterMs` after SIGTERM, the way a CLI winding
 * down does. It reports its pid only once that handler is in place, so a stop
 * can never land before it.
 */
function writeSlowToExitFake(exitAfterMs: number): string {
  const fake = join(fixtures, `claude-exits-after-${exitAfterMs}.mjs`);
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'fs';",
      `process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${exitAfterMs}));`,
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid]));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { mode: 0o755 }
  );
  chmodSync(fake, 0o755);
  return fake;
}

/**
 * A fake claude that exits as soon as it gets SIGTERM, having started a tool
 * that ignores SIGTERM: the shape a wait on the leader alone cannot see. Both
 * report their pids only once their handlers are in place.
 */
function writeLeaderWithStubbornTool(): string {
  const fake = join(fixtures, 'claude-leaves-a-tool.mjs');
  const toolPidPath = join(fixtures, 'tool.pid');
  const tool = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(toolPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "import { spawn } from 'child_process';",
      "import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';",
      `rmSync(${JSON.stringify(toolPidPath)}, { force: true });`,
      "process.on('SIGTERM', () => process.exit(0));",
      `spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], { stdio: 'ignore' });`,
      'const wait = setInterval(() => {',
      `  if (!existsSync(${JSON.stringify(toolPidPath)})) return;`,
      `  const toolPid = Number(readFileSync(${JSON.stringify(toolPidPath)}, 'utf-8'));`,
      '  if (!(toolPid > 0)) return;',
      '  clearInterval(wait);',
      `  writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, toolPid]));`,
      '}, 20);',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { mode: 0o755 }
  );
  chmodSync(fake, 0o755);
  return fake;
}

/** The pids the fake reported, once it has. */
async function whenReported(): Promise<number[]> {
  const until = Date.now() + 10_000;
  while (reported().length === 0) {
    if (Date.now() > until) throw new Error('the fake never reported its pid');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return reported();
}

describe('ClaudeRunner: a run with its own ceiling, stopped as a group', () => {
  it('a cancelled run that ignores SIGTERM settles at the group SIGKILL, once it has exited, as a non-transient failure', async () => {
    hoisted.binary = writeHangingFake();
    const controller = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = Date.now();
      controller.abort();
    }, 500);
    const result = await new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        killProcessGroup: true,
        signal: controller.signal,
      },
    });
    const settledAfter = Date.now() - abortedAt;
    const [fakeClaude, grandchild] = reported();
    // Settled when the process was gone, not when it was signalled: until
    // then it could still write to the session a next turn would resume.
    expect(alive(fakeClaude)).toBe(false);
    expect(settledAfter).toBeGreaterThanOrEqual(STOP_GRACE_MS - 100);
    expect(settledAfter).toBeLessThan(STOP_GRACE_MS + STOP_GIVE_UP_MS);
    expect(result).toMatchObject({
      success: false,
      error: 'Claude Code turn cancelled, process stopped',
    });
    // Not the word the retry classifier reads as transient.
    expect(String(result.error)).not.toMatch(/timeout/i);

    // The grandchild got the same SIGKILL; give the system a moment to reap it.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it.each([
    ['as a group', true],
    ['alone', false],
  ])(
    'a cancelled run (%s) settles when its process exits, not when it is signalled',
    async (_label, killProcessGroup) => {
      hoisted.binary = writeSlowToExitFake(400);
      const controller = new AbortController();
      const run = new ClaudeRunner().run('hello', {
        config: {
          workingDirectory: fixtures,
          mcpConfigPath: join(fixtures, '.mcp.json'),
          killProcessGroup,
          signal: controller.signal,
        },
      });
      const [fakeClaude] = await whenReported();
      const abortedAt = Date.now();
      controller.abort();
      const result = await run;
      const settledAfter = Date.now() - abortedAt;
      expect(alive(fakeClaude)).toBe(false);
      expect(settledAfter).toBeGreaterThanOrEqual(350);
      // Promptly once it has gone: no fixed wait for the grace period.
      expect(settledAfter).toBeLessThan(STOP_GRACE_MS);
      expect(result).toMatchObject({
        success: false,
        error: 'Claude Code turn cancelled, process stopped',
      });
    },
    20_000
  );

  it('a run past its ceiling settles when its process exits, not when it is signalled', async () => {
    hoisted.binary = writeSlowToExitFake(400);
    const started = Date.now();
    const result = await new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        timeoutMs: 1000,
        killProcessGroup: true,
      },
    });
    const [fakeClaude] = reported();
    expect(alive(fakeClaude)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000 + 350);
    expect(result).toMatchObject({
      success: false,
      error: 'Claude Code timeout: exceeded the 1s ceiling, process killed',
    });
  }, 20_000);

  it('a cancelled run keeps what its process wrote while it wound down', async () => {
    const fake = join(fixtures, 'claude-says-goodbye.mjs');
    const lastWord = JSON.stringify({ type: 'result', result: 'stopped mid-thought' });
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'fs';",
        `process.on('SIGTERM', () => { process.stdout.write(${JSON.stringify(lastWord + '\n')}); setTimeout(() => process.exit(0), 100); });`,
        `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid]));`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { mode: 0o755 }
    );
    chmodSync(fake, 0o755);
    hoisted.binary = fake;
    const controller = new AbortController();
    const run = new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        killProcessGroup: true,
        signal: controller.signal,
      },
    });
    await whenReported();
    controller.abort();
    const result = await run;
    expect(result).toMatchObject({ success: false, finalTextResponse: 'stopped mid-thought' });
  }, 20_000);

  it('a process that never confirms its exit is given up on at the bound, and the outcome says so', async () => {
    hoisted.binary = writeSlowToExitFake(400);
    hoisted.scriptedStop = { exited: false, group: 'alive' };
    try {
      const controller = new AbortController();
      const run = new ClaudeRunner().run('hello', {
        config: {
          workingDirectory: fixtures,
          mcpConfigPath: join(fixtures, '.mcp.json'),
          killProcessGroup: true,
          signal: controller.signal,
        },
      });
      const [fakeClaude] = await whenReported();
      controller.abort();
      const result = await run;
      expect(result).toMatchObject({ success: false });
      expect(result.error).toBe(
        'Claude Code turn cancelled; its processes did not confirm they had stopped'
      );
      expect(String(result.error)).not.toMatch(/timeout/i);
      // The group to fence on; process metadata only.
      expect(result.stopUnconfirmed).toEqual({
        leaderExited: false,
        pgid: fakeClaude,
        group: 'alive',
      });
    } finally {
      hoisted.scriptedStop = null;
    }
  }, 20_000);

  it('a leader that exited is not enough: a group that could not be observed leaves the stop unconfirmed', async () => {
    hoisted.binary = writeSlowToExitFake(400);
    hoisted.scriptedStop = { exited: true, group: 'unknown' };
    try {
      const controller = new AbortController();
      const run = new ClaudeRunner().run('hello', {
        config: {
          workingDirectory: fixtures,
          mcpConfigPath: join(fixtures, '.mcp.json'),
          killProcessGroup: true,
          signal: controller.signal,
        },
      });
      const [fakeClaude] = await whenReported();
      controller.abort();
      const result = await run;
      expect(result.error).toBe(
        'Claude Code turn cancelled; its processes did not confirm they had stopped'
      );
      expect(result.stopUnconfirmed).toMatchObject({
        leaderExited: true,
        pgid: fakeClaude,
        group: 'unknown',
      });
    } finally {
      hoisted.scriptedStop = null;
    }
  }, 20_000);

  it('a group stop is confirmed only by an empty group: an outcome that says nothing of the group leaves it unconfirmed', async () => {
    hoisted.binary = writeSlowToExitFake(400);
    hoisted.scriptedStop = { exited: true };
    try {
      const controller = new AbortController();
      const run = new ClaudeRunner().run('hello', {
        config: {
          workingDirectory: fixtures,
          mcpConfigPath: join(fixtures, '.mcp.json'),
          killProcessGroup: true,
          signal: controller.signal,
        },
      });
      const [fakeClaude] = await whenReported();
      controller.abort();
      const result = await run;
      expect(result.error).toBe(
        'Claude Code turn cancelled; its processes did not confirm they had stopped'
      );
      expect(result.stopUnconfirmed).toEqual({ leaderExited: true, pgid: fakeClaude });
    } finally {
      hoisted.scriptedStop = null;
    }
  }, 20_000);

  it('a cancelled run whose leader exits on SIGTERM settles only once its TERM-ignoring tool is gone (Lumen 42298771)', async () => {
    hoisted.binary = writeLeaderWithStubbornTool();
    const controller = new AbortController();
    const run = new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        killProcessGroup: true,
        signal: controller.signal,
      },
    });
    const [fakeClaude, tool] = await whenReported();
    const abortedAt = Date.now();
    controller.abort();
    const result = await run;
    const settledAfter = Date.now() - abortedAt;
    // The leader went at once; the run waited for the tool, which only the
    // group's SIGKILL ends.
    expect(alive(fakeClaude)).toBe(false);
    expect(alive(tool)).toBe(false);
    expect(settledAfter).toBeGreaterThanOrEqual(STOP_GRACE_MS - 100);
    expect(result).toMatchObject({
      success: false,
      error: 'Claude Code turn cancelled, process stopped',
    });
    expect(result.stopUnconfirmed).toBeUndefined();
  }, 20_000);

  it('stops at the run ceiling, and nothing it started is left running', async () => {
    const fake = join(fixtures, 'claude-hangs.mjs');
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        "import { spawn } from 'child_process';",
        "import { writeFileSync } from 'fs';",
        `const g = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, g.pid]));`,
        IGNORES_TERM,
      ].join('\n'),
      { mode: 0o755 }
    );
    chmodSync(fake, 0o755);
    hoisted.binary = fake;

    const started = Date.now();
    const result = await new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        timeoutMs: 1000,
        killProcessGroup: true,
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({
      success: false,
      error: 'Claude Code timeout: exceeded the 1s ceiling, process killed',
    });

    const [fakeClaude, grandchild] = reported();
    expect(grandchild).toBeGreaterThan(0);
    // The stop's grace period, then the group's SIGKILL.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    expect(alive(fakeClaude)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);
});

describe("ClaudeRunner: the caller's admission is asked again at the spawn seam (Lumen's review of #747)", () => {
  /** A fake claude that records its pid and exits at once, so a spawn by mistake ends cleanly. */
  function writeExitsAtOnceFake(): string {
    const fake = join(fixtures, 'claude-exits.mjs');
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'fs';",
        `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid]));`,
      ].join('\n'),
      { mode: 0o755 }
    );
    chmodSync(fake, 0o755);
    return fake;
  }

  /**
   * Starts a run whose gate reads `refuse` when asked, recording each answer.
   * The run has a permission overlay, its last await before the spawn, and
   * `refuse` turns while that await is in flight.
   */
  function runGated(refuse: { now: boolean; during: boolean }) {
    const asked: boolean[] = [];
    const overlay = { restored: false };
    hoisted.overlay = () => {
      if (refuse.during) refuse.now = true;
      return async () => {
        overlay.restored = true;
      };
    };
    const run = new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        killProcessGroup: true,
        permissionOverlay: { allow: [] },
        admitSpawn: () => {
          asked.push(refuse.now);
          return refuse.now ? 'Synthetic refusal' : undefined;
        },
      },
    });
    return { run, asked, overlay };
  }

  afterEach(() => {
    hoisted.overlay = null;
  });

  it('a refusal that arrives during the last await of the run’s preparation starts nothing, undoes the overlay, and says so', async () => {
    hoisted.binary = writeExitsAtOnceFake();
    const { run, asked, overlay } = runGated({ now: false, during: true });
    const result = await run;
    expect(asked).toEqual([true]);
    expect(result).toMatchObject({
      success: false,
      error: 'Synthetic refusal',
      refusedBeforeSpawn: true,
    });
    expect(reported()).toEqual([]);
    expect(overlay.restored).toBe(true);
  });

  it('an admitting gate spawns as before (control: the fake records itself when it runs)', async () => {
    hoisted.binary = writeExitsAtOnceFake();
    const { run, asked } = runGated({ now: false, during: false });
    const result = await run;
    expect(asked).toEqual([false]);
    expect(result.refusedBeforeSpawn).toBeUndefined();
    expect(reported()).toHaveLength(1);
  });
});
