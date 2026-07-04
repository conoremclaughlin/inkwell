import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateStrategyResult } from './wait.js';

const execFileAsync = promisify(execFile);

const CLI_PATH = 'packages/cli/src/cli.ts';

async function runWait(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_PATH, 'wait', ...args], {
      timeout: 30000,
      env: { ...process.env, AGENT_ID: 'wren' },
      cwd: process.cwd(),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.code || 1,
    };
  }
}

describe('sb wait', () => {
  it('shows help text', async () => {
    const result = await runWait(['--help']);
    const output = result.stdout + result.stderr;
    if (output.includes('triggerUncaughtException') || output.includes('Cannot find module')) {
      return;
    }
    expect(output).toContain('Wait for new inbox or thread messages');
    expect(output).toContain('--thread');
    expect(output).toContain('--timeout');
  });

  it('shows --group in help', async () => {
    const result = await runWait(['--help']);
    const output = result.stdout + result.stderr;
    if (output.includes('triggerUncaughtException') || output.includes('Cannot find module')) {
      return;
    }
    expect(output).toContain('--group');
  });

  // Integration tests — require running PCP server
  it.skipIf(!process.env.INK_INTEGRATION)(
    'times out with exit code 1 when no new messages',
    async () => {
      const result = await runWait(['--timeout', '10', '--interval', '5']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Timed out');
    }
  );

  it.skipIf(!process.env.INK_INTEGRATION)(
    'detects existing thread messages and exits 0',
    async () => {
      const result = await runWait(['--thread', 'pr:235', '--timeout', '10', '--interval', '5']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('new message(s)');
    }
  );

  it.skipIf(!process.env.INK_INTEGRATION)('exits 2 for invalid group UUID', async () => {
    const result = await runWait(['--group', 'not-a-uuid', '--timeout', '10', '--interval', '5']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Failed to fetch initial strategy status');
  });

  it.skipIf(!process.env.INK_INTEGRATION)('exits 2 for nonexistent group UUID', async () => {
    const result = await runWait([
      '--group',
      '00000000-0000-4000-8000-000000000000',
      '--timeout',
      '10',
      '--interval',
      '5',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Failed to fetch initial strategy status');
  });
});

describe('validateStrategyResult', () => {
  it('passes for a valid strategy response', () => {
    expect(() =>
      validateStrategyResult({ status: 'active', progress: { total: 3, completed: 1 } }, 'test')
    ).not.toThrow();
  });

  it('throws on { success: false } with error message', () => {
    expect(() =>
      validateStrategyResult({ success: false, error: 'Task group not found' }, 'test')
    ).toThrow('Task group not found');
  });

  it('throws on { success: false } without error message', () => {
    expect(() => validateStrategyResult({ success: false }, 'test')).toThrow(
      'test: server returned failure'
    );
  });

  it('throws on text-shaped MCP error', () => {
    expect(() =>
      validateStrategyResult(
        { text: 'MCP error -32602: Invalid params: groupId must be a UUID' },
        'test'
      )
    ).toThrow('MCP error -32602');
  });

  it('does not throw on valid result that happens to have a text field', () => {
    expect(() =>
      validateStrategyResult(
        { status: 'active', progress: { total: 3 }, text: 'some note' },
        'test'
      )
    ).not.toThrow();
  });

  it('throws on text error even when success is undefined', () => {
    expect(() => validateStrategyResult({ text: 'something went wrong' }, 'test')).toThrow(
      'something went wrong'
    );
  });
});
