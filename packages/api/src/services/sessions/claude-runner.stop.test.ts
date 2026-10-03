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
const hoisted = vi.hoisted(() => ({ binary: '' }));

vi.mock('./resolve-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve-binary.js')>();
  return { ...actual, resolveBinaryPath: () => Promise.resolve(hoisted.binary) };
});

import { ClaudeRunner } from './claude-runner.js';

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

describe('ClaudeRunner: a run with its own ceiling, stopped as a group', () => {
  it('a cancelled run stops at once, as a non-transient failure, with nothing left running', async () => {
    hoisted.binary = writeHangingFake();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const result = await new ClaudeRunner().run('hello', {
      config: {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
        killProcessGroup: true,
        signal: controller.signal,
      },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({
      success: false,
      error: 'Claude Code turn cancelled, process stopped',
    });
    // Not the word the retry classifier reads as transient.
    expect(String(result.error)).not.toMatch(/timeout/i);

    const [fakeClaude, grandchild] = reported();
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    expect(alive(fakeClaude)).toBe(false);
    expect(alive(grandchild)).toBe(false);
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
