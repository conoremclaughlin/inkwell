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

/**
 * No harness-noise bypass here on purpose. Swallowing "Cannot find module" or
 * an uncaught exception would let a CLI that fails to even start satisfy every
 * assertion below vacuously — which defeats the point of a command-level test.
 * A runner that can't launch the CLI is a real failure and should say so.
 */
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

/** A crash or unresolved import means the assertions below prove nothing. */
function assertCliStarted(output: string): void {
  expect(output).not.toContain('Cannot find module');
  expect(output).not.toContain('triggerUncaughtException');
  expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
}

describe('signed-out guard', () => {
  it('ink awaken prints the guidance and exits non-zero', async () => {
    const { output, exitCode } = await runSignedOut(['awaken', '--backend', 'claude']);
    assertCliStarted(output);
    expect(output).toContain(NOT_SIGNED_IN_MESSAGE);
    expect(exitCode).not.toBe(0);
  });

  it('ink wait prints the guidance, not a bare prefix', async () => {
    const { output, exitCode } = await runSignedOut(['wait', '--timeout', '5']);
    assertCliStarted(output);
    expect(output).toContain(NOT_SIGNED_IN_MESSAGE);
    // The regression: an interpolation slip left "[ink wait] " with no message.
    expect(output).not.toMatch(/\[ink wait\]\s*$/);
    expect(exitCode).toBe(2);
  });

  it('points at `ink auth login` rather than looping users through `ink init`', async () => {
    const { output } = await runSignedOut(['awaken', '--backend', 'claude']);
    assertCliStarted(output);
    expect(output).toContain('ink auth login');
  });
});
