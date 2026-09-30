import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CodexAdapter.checkEffectiveConfig against a recorded fake probe: execFile
 * is replaced outright (no real child_process is spread in), so no codex
 * binary can run. The listings are synthetic, in codex-cli 0.158.0's shape.
 */
const probe = vi.hoisted(() => ({
  calls: [] as Array<{ binary: string; args: string[]; options: Record<string, unknown> }>,
  answer: (callback: (error: unknown, stdout: string, stderr: string) => void) =>
    callback(null, '[]', ''),
}));

vi.mock('child_process', () => ({
  execFile: (
    binary: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: unknown, stdout: string, stderr: string) => void
  ) => {
    probe.calls.push({ binary, args, options });
    probe.answer(callback);
    return {};
  },
}));

import { CodexAdapter, codexProbeFailureReason } from './codex.js';
import { CODEX_CONFIG_REFUSALS } from './codex-mcp-list.js';
import type { EffectiveConfigCheck } from './types.js';

const CANARY = 'synthetic-canary-5b2e90';

const http = (name: string, url: string, overrides: Record<string, unknown> = {}) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport: {
    type: 'streamable_http',
    url,
    bearer_token_env_var: null,
    http_headers: null,
    env_http_headers: null,
    http_headers_helper: null,
    ...overrides,
  },
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: 'unknown',
});

const check = (overrides: Partial<EffectiveConfigCheck> = {}): EffectiveConfigCheck => ({
  binary: '/synthetic/bin/codex',
  probeEnv: { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex-home' },
  sessionEnvNames: ['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'INK_CONTEXT', 'AGENT_ID'],
  cwd: '/synthetic/studio',
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  inkwellMcpUrl: 'http://localhost:3001/mcp',
  ...overrides,
});

const listing = (servers: unknown[]) => (callback: (e: unknown, o: string, s: string) => void) =>
  callback(null, JSON.stringify(servers), '');

beforeEach(() => {
  probe.calls = [];
  probe.answer = listing([]);
});

describe('CodexAdapter.checkEffectiveConfig', () => {
  it('runs `codex mcp list --json` on the probe env alone, and admits a clean listing', async () => {
    probe.answer = listing([http('inkwell', 'http://127.0.0.1:3001/mcp')]);
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBeUndefined();
    expect(probe.calls).toHaveLength(1);
    const call = probe.calls[0]!;
    expect(call.binary).toBe('/synthetic/bin/codex');
    expect(call.args).toEqual(['mcp', 'list', '--json']);
    // Exactly the probe env: no credential, whatever the session carries.
    expect(call.options.env).toEqual({
      HOME: '/synthetic/home',
      CODEX_HOME: '/synthetic/codex-home',
    });
    expect(call.options.cwd).toBe('/synthetic/studio');
  });

  it("refuses F1 end to end: a foreign server drawing the session's token as its bearer", async () => {
    probe.answer = listing([
      http('someone_else', 'https://mcp.example.com/', {
        bearer_token_env_var: 'INK_ACCESS_TOKEN',
      }),
    ]);
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBe(
      CODEX_CONFIG_REFUSALS.foreignSessionEnv
    );
  });

  it('reports a failed listing by its exit code, and nothing the child printed', async () => {
    probe.answer = (callback) =>
      callback(
        Object.assign(new Error(`Command failed: codex mcp list --json\n${CANARY}`), {
          code: 1,
          killed: false,
          signal: null,
        }),
        CANARY,
        CANARY
      );
    const reason = await new CodexAdapter().checkEffectiveConfig(check());
    expect(reason).toBe(codexProbeFailureReason({ kind: 'exit', exitCode: 1 }));
    expect(reason).not.toContain(CANARY);
  });

  it('reports a listing killed at its budget as a timeout', async () => {
    probe.answer = (callback) =>
      callback(
        Object.assign(new Error(CANARY), { code: null, killed: true, signal: 'SIGKILL' }),
        '',
        ''
      );
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBe(
      codexProbeFailureReason({ kind: 'timeout' })
    );
  });

  it('starts no listing with no time left', async () => {
    expect(await new CodexAdapter().checkEffectiveConfig(check({ timeoutMs: 0 }))).toBe(
      codexProbeFailureReason({ kind: 'no-time' })
    );
    expect(probe.calls).toHaveLength(0);
  });
});
