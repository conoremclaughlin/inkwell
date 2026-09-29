/**
 * AntigravityRunner production-boundary tests.
 *
 * The crash and timeout tests in antigravity-runner.test.ts stub
 * `spawnProcess()` and hand `run()` an already-correct result — so they assert
 * the mapping and nothing else. Mechanically reverting the real close-handler
 * or kill branches leaves them green, which means they were describing my
 * intent rather than the system (Lumen, round three).
 *
 * These drive the real thing. The ONLY seam stubbed is binary resolution: a
 * fake `agy` stands in for the CLI, and everything after it — spawn, the
 * stream-json line buffering, the close handler, the kill escalation — is
 * production code running against real OS processes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

const fixtures = mkdtempSync(join(tmpdir(), 'agy-fake-'));

/** Write an executable stand-in for the agy CLI. */
function fakeAgy(name: string, body: string): string {
  const path = join(fixtures, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

const hoisted = vi.hoisted(() => ({ binary: '' }));

vi.mock('./resolve-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve-binary.js')>();
  return { ...actual, resolveBinaryPath: () => Promise.resolve(hoisted.binary) };
});

import { AntigravityRunner } from './antigravity-runner.js';
import type { ClaudeRunnerConfig } from './types.js';

const config = (): ClaudeRunnerConfig => ({
  workingDirectory: fixtures,
  mcpConfigPath: join(fixtures, '.mcp.json'),
  // No inkAccessToken: this exercises the spawn path, not global config staging.
  inkMcpUrl: 'http://localhost:3001/mcp',
});

const emit = (event: object) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')});`;

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

describe('close handler — real subprocess', () => {
  it('returns success and the conversation id when agy exits cleanly', async () => {
    hoisted.binary = fakeAgy(
      'agy-ok.mjs',
      [
        emit({ event: 'init', conversation_id: 'conv-live-1' }),
        emit({
          event: 'result',
          result: { conversation_id: 'conv-live-1', status: 'SUCCESS', response: 'hello' },
        }),
      ].join('\n')
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(true);
    expect(result.backendSessionId).toBe('conv-live-1');
    expect(result.finalTextResponse).toBe('hello');
  });

  it('keeps the init conversation id when agy dies before emitting a result', async () => {
    // The real regression: this branch used to reject, which discarded the
    // accumulator. The id agy already created was lost, so the next message
    // started a fresh conversation and could repeat side effects.
    hoisted.binary = fakeAgy(
      'agy-crash.mjs',
      [emit({ event: 'init', conversation_id: 'conv-live-2' }), 'process.exit(1);'].join('\n')
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(false);
    expect(result.backendSessionId).toBe('conv-live-2');
    expect(result.error).toContain('code 1');
  });

  it('fails a non-zero exit that produced partial text first', async () => {
    // The old branch only rejected when there was NO output, so a crash after
    // partial text resolved with no status and run() called it a success.
    hoisted.binary = fakeAgy(
      'agy-partial.mjs',
      [
        emit({ event: 'init', conversation_id: 'conv-live-3' }),
        emit({ event: 'step_update', step_update: { state: 'DONE', text_delta: 'partway' } }),
        'process.exit(1);',
      ].join('\n')
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(false);
    expect(result.finalTextResponse).toContain('partway');
  });

  it('parses a result split across stdout chunk boundaries', async () => {
    // stream-json lines can arrive in pieces; the remainder buffer is the only
    // thing keeping a split envelope parseable.
    const payload = JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-live-4', status: 'SUCCESS', response: 'chunked' },
    });
    hoisted.binary = fakeAgy(
      'agy-chunked.mjs',
      [
        `process.stdout.write(${JSON.stringify(payload.slice(0, 20))});`,
        'setTimeout(() => {',
        `  process.stdout.write(${JSON.stringify(payload.slice(20) + '\n')});`,
        '}, 30);',
      ].join('\n')
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(true);
    expect(result.finalTextResponse).toBe('chunked');
  });

  it('surfaces a spawn failure rather than hanging', async () => {
    hoisted.binary = join(fixtures, 'does-not-exist');

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('recovered tool errors — real subprocess', () => {
  it('reports success when agy answers despite a tool error', async () => {
    // The envelope shape is copied from a real agy 1.1.13 run: a malformed MCP
    // call sets status ERROR and populates error, yet the agent recovered and
    // response carries its answer. Classifying that as a failed turn threw away
    // a reply the agent had written — and told the sender it never arrived.
    hoisted.binary = fakeAgy(
      'agy-recovered.mjs',
      [
        emit({ event: 'init', conversation_id: 'conv-recovered' }),
        emit({
          event: 'result',
          result: {
            conversation_id: 'conv-recovered',
            status: 'ERROR',
            response: 'RECOVERED',
            error:
              'Error in MCP tool execution: MCP error -32602: Input validation error: ' +
              'Invalid arguments for tool get_thread_messages',
          },
        }),
      ].join('\n')
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(true);
    expect(result.finalTextResponse).toBe('RECOVERED');
    expect(result.backendSessionId).toBe('conv-recovered');
  });

  it('still fails when agy errors with no answer at all', async () => {
    // The unauthenticated shape: status ERROR, empty response. Must stay fatal.
    hoisted.binary = fakeAgy(
      'agy-broken.mjs',
      emit({
        event: 'result',
        result: {
          conversation_id: '',
          status: 'ERROR',
          response: '',
          error: 'authentication failed or timed out',
        },
      })
    );

    const result = await new AntigravityRunner().run('hi', { config: config() });

    expect(result.success).toBe(false);
    expect(result.error).toContain('authentication failed');
  });
});

describe('killProcess — real subprocess', () => {
  const kill = (runner: AntigravityRunner, proc: unknown) =>
    (runner as unknown as { killProcess: (p: unknown) => Promise<void> }).killProcess(proc);

  it('resolves once a well-behaved child exits', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
    await expect(kill(new AntigravityRunner(), proc)).resolves.toBeUndefined();
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });

  it('short-circuits when the child has already exited', async () => {
    const proc = spawn(process.execPath, ['-e', 'process.exit(0);']);
    await new Promise((resolve) => proc.once('exit', resolve));

    await expect(kill(new AntigravityRunner(), proc)).resolves.toBeUndefined();
  });

  it('resolves when kill() itself throws, instead of stranding the turn', async () => {
    // The temporal-dead-zone path, and the one that actually needs fault
    // injection: a real already-exited child short-circuits on the exitCode
    // guard and never reaches it. It fires when the guard passes but kill()
    // throws — the child died in between, so the signal hits no such process.
    //
    // finish() then cleared `escalation`/`giveUp` before they were initialised,
    // throwing a ReferenceError out of the promise executor. The timeout
    // callers only attach .then(), so nothing observed the rejection and the
    // turn stayed pending forever. A hang, not a crash.
    //
    // Confirmed red against the previous commit; the real-process version of
    // this test stayed green, which is why it is not the one guarding it.
    const alreadyGone = {
      exitCode: null,
      signalCode: null,
      pid: 999999,
      once: () => {},
      kill: () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    };

    await expect(kill(new AntigravityRunner(), alreadyGone)).resolves.toBeUndefined();
  }, 10_000);

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const proc = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ]);
    // Give the handler time to register before signalling.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await kill(new AntigravityRunner(), proc);

    expect(proc.signalCode).toBe('SIGKILL');
  }, 20_000);
});

// spec:sender-token-binding v3 §4 Phase 0 (task 7f4ceda4). A REAL child, so
// this is the environment the binary itself sees, after docker-or-host
// resolution and the runner's own merge: the parent's secrets are absent, the
// session credentials the server minted are present. The fake agy reports the
// NAMES it finds, never values.
describe('child environment — real subprocess (Phase 0)', () => {
  it('the agy child never sees a server secret, and sees its own session credentials', async () => {
    vi.stubEnv('JWT_SECRET', 'synthetic-jwt-secret');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic-service-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'synthetic-bot');
    vi.stubEnv('INK_ACCESS_TOKEN', 'parent-session-token');
    try {
      const probe = [
        'JWT_SECRET',
        'SUPABASE_SECRET_KEY',
        'TELEGRAM_BOT_TOKEN',
        'INK_ACCESS_TOKEN',
        'INK_DELEGATION_SECRET',
        'INK_SESSION_ID',
        'SB_SLUG',
        'HOME',
        'PATH',
      ];
      hoisted.binary = fakeAgy(
        'agy-env.mjs',
        [
          `const present = ${JSON.stringify(probe)}.filter((n) => n in process.env);`,
          `const token = process.env.INK_ACCESS_TOKEN === 'child-session-token' ? 'child' : 'other';`,
          `process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-env' }) + '\\n');`,
          `process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-env', status: 'SUCCESS', response: present.join(',') + '|' + token } }) + '\\n');`,
        ].join('\n')
      );
      const result = await new AntigravityRunner().run('hi', {
        config: {
          ...config(),
          sbSlug: 'wren',
          inkSessionId: 'sess-agy-env',
          inkAccessToken: 'child-session-token',
          inkDelegationSecret: 'synthetic-derived-secret',
        } as never,
      });
      expect(result.success).toBe(true);
      const [names, token] = (result.finalTextResponse ?? '').split('|');
      const present = new Set(names.split(',').filter(Boolean));
      expect(present.has('JWT_SECRET')).toBe(false);
      expect(present.has('SUPABASE_SECRET_KEY')).toBe(false);
      expect(present.has('TELEGRAM_BOT_TOKEN')).toBe(false);
      expect(present.has('INK_ACCESS_TOKEN')).toBe(true);
      expect(token).toBe('child');
      expect(present.has('INK_DELEGATION_SECRET')).toBe(true);
      expect(present.has('INK_SESSION_ID')).toBe(true);
      expect(present.has('SB_SLUG')).toBe(true);
      expect(present.has('HOME')).toBe(true);
      expect(present.has('PATH')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
