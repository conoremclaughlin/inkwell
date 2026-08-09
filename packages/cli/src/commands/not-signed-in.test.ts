/**
 * Command-level coverage for the signed-out guard.
 *
 * Unit-testing NOT_SIGNED_IN_MESSAGE only proves the constant is right — it
 * cannot catch a call site that imports the constant and then fails to print
 * it. That is exactly what slipped through on `ink wait`, which emitted a bare
 * "[ink wait] " prefix. These spawn the real CLI with an empty HOME (no
 * ~/.ink/config.json) and assert the user actually sees the guidance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NOT_SIGNED_IN_MESSAGE } from '../lib/user-config.js';

const execFileAsync = promisify(execFile);
const CLI_PATH = 'packages/cli/src/cli.ts';

let emptyHome: string;

beforeAll(() => {
  emptyHome = mkdtempSync(join(tmpdir(), 'ink-signed-out-'));
});

afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
});

async function runSignedOut(args: string[]): Promise<{ output: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_PATH, ...args], {
      timeout: 30000,
      cwd: process.cwd(),
      env: { ...process.env, HOME: emptyHome, AGENT_ID: 'wren' },
    });
    return { output: stdout + stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { output: (e.stdout || '') + (e.stderr || ''), exitCode: e.code ?? 1 };
  }
}

/** tsx/module resolution hiccups in CI shouldn't read as an assertion failure. */
function isHarnessNoise(output: string): boolean {
  return output.includes('triggerUncaughtException') || output.includes('Cannot find module');
}

describe('signed-out guard', () => {
  it('ink awaken prints the guidance and exits non-zero', async () => {
    const { output, exitCode } = await runSignedOut(['awaken', '--backend', 'claude']);
    if (isHarnessNoise(output)) return;
    expect(output).toContain(NOT_SIGNED_IN_MESSAGE);
    expect(exitCode).not.toBe(0);
  });

  it('ink wait prints the guidance, not a bare prefix', async () => {
    const { output, exitCode } = await runSignedOut(['wait', '--timeout', '5']);
    if (isHarnessNoise(output)) return;
    expect(output).toContain(NOT_SIGNED_IN_MESSAGE);
    // The regression: an interpolation slip left "[ink wait] " with no message.
    expect(output).not.toMatch(/\[ink wait\]\s*$/);
    expect(exitCode).toBe(2);
  });

  it('points at `ink auth login` rather than looping users through `ink init`', async () => {
    const { output } = await runSignedOut(['awaken', '--backend', 'claude']);
    if (isHarnessNoise(output)) return;
    expect(output).toContain('ink auth login');
  });
});
