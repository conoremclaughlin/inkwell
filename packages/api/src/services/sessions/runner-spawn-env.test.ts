/**
 * spec:sender-token-binding v3 §4 Phase 0 (task 7f4ceda4).
 *
 * The Claude and Gemini runners spawned their child with
 * `{ ...cleanEnv, ...spawnEnv }` on the host path, where cleanEnv was the
 * server's whole environment minus CLAUDECODE: every spawned SB held the JWT
 * signing key and the Supabase service key (P4). This drives each runner's
 * spawn entry point with child_process mocked and asserts the FINAL env handed
 * to spawn, override order included. The Codex runner is covered beside its
 * existing env test; the ink runner in ink-runner.spawn-env.test.ts; the
 * Antigravity runner end to end with a real child in
 * antigravity-runner.spawn.test.ts.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn(async (name: string) => `/fake/bin/${name}`),
  buildSpawnPath: vi.fn((bin: string) => `${bin}:dir:/usr/bin`),
}));

import { ClaudeRunner } from './claude-runner.js';
import { GeminiRunner } from './gemini-runner.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
    pid: 4242,
  }) as FakeChild;
}

/** Start the runner's spawn entry point, wait for spawn, close the child, return the env spawn saw. */
async function captureSpawnEnv(start: () => Promise<unknown>): Promise<Record<string, string>> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const pending = start().catch(() => undefined);
  for (let i = 0; i < 50 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(spawnMock).toHaveBeenCalledOnce();
  child.stdout.end();
  child.stderr.end();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await pending;
  const [, , options] = spawnMock.mock.calls[0] as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  return options.env;
}

const SECRETS: Record<string, string> = {
  JWT_SECRET: 'synthetic-jwt-secret',
  SUPABASE_SECRET_KEY: 'synthetic-service-key',
  GOOGLE_CLIENT_SECRET: 'synthetic-oauth-secret',
  TELEGRAM_BOT_TOKEN: 'synthetic-bot',
  SB_TEST_PASSWORD: 'synthetic-password',
  INK_ACCESS_TOKEN: 'parent-session-token',
};

let workingDirectory: string;

beforeEach(() => {
  spawnMock.mockReset();
  workingDirectory = mkdtempSync(join(tmpdir(), 'runner-spawn-env-'));
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  vi.stubEnv('HOME', '/home/synthetic');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workingDirectory, { recursive: true, force: true });
  vi.clearAllMocks();
});

function assertAllowlisted(env: Record<string, string>, expected: Record<string, string>): void {
  for (const name of Object.keys(SECRETS)) {
    if (name === 'INK_ACCESS_TOKEN') continue;
    expect(name in env, name).toBe(false);
  }
  // The parent's INK_ACCESS_TOKEN never crosses; the child's comes from its config.
  expect(env.INK_ACCESS_TOKEN).toBe(expected.INK_ACCESS_TOKEN);
  for (const [name, value] of Object.entries(expected)) {
    expect(env[name], name).toBe(value);
  }
  expect('CLAUDECODE' in env).toBe(false);
  expect(env.HOME).toBe('/home/synthetic');
}

describe('ClaudeRunner child environment (Phase 0)', () => {
  it('hands claude an allowlisted env with its own session credentials', async () => {
    const runner = new ClaudeRunner();
    const config = {
      workingDirectory,
      mcpConfigPath: '',
      sbSlug: 'wren',
      inkSessionId: 'sess-claude-env',
      inkAccessToken: 'child-session-token',
      inkDelegationSecret: 'synthetic-derived-secret',
    };
    const env = await captureSpawnEnv(() =>
      (
        runner as unknown as {
          spawnProcess: (a: string[], m: string, c: unknown) => Promise<unknown>;
        }
      ).spawnProcess(['--print'], 'hello', config)
    );
    assertAllowlisted(env, {
      INK_ACCESS_TOKEN: 'child-session-token',
      INK_DELEGATION_SECRET: 'synthetic-derived-secret',
      INK_SESSION_ID: 'sess-claude-env',
      SB_SLUG: 'wren',
      AGENT_ID: 'wren',
      PATH: '/fake/bin/claude:dir:/usr/bin',
      INK_CHANNEL_HOST: 'print',
    });
  });
});

describe('GeminiRunner child environment (Phase 0)', () => {
  it('hands gemini an allowlisted env with its own session credentials', async () => {
    const runner = new GeminiRunner();
    const config = {
      workingDirectory,
      mcpConfigPath: '',
      sbSlug: 'aster',
      inkSessionId: 'sess-gemini-env',
      inkAccessToken: 'child-session-token',
      inkDelegationSecret: 'synthetic-derived-secret',
    };
    const env = await captureSpawnEnv(() =>
      (
        runner as unknown as {
          spawnProcess: (a: string[], c: unknown, e?: unknown) => Promise<unknown>;
        }
      ).spawnProcess(['--prompt', 'hello'], config, { GEMINI_SYNTHETIC_EXTRA: 'yes' })
    );
    assertAllowlisted(env, {
      INK_ACCESS_TOKEN: 'child-session-token',
      INK_DELEGATION_SECRET: 'synthetic-derived-secret',
      INK_SESSION_ID: 'sess-gemini-env',
      SB_SLUG: 'aster',
      AGENT_ID: 'aster',
      PATH: '/fake/bin/gemini:dir:/usr/bin',
      GEMINI_SYNTHETIC_EXTRA: 'yes',
    });
  });
});
