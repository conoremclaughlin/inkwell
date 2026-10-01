/**
 * A backend the server spawned never moves its session's lifecycle.
 *
 * The server writes `running` and the run's turn epoch before it spawns a
 * backend, and fences its finalize on that epoch. The installed
 * handle_session_running_write mints a fresh epoch whenever `running` lands
 * on a row that is not running, so an `idle` written from inside the run was
 * followed by a rotation at the child's next `running`, and the run's own
 * finalize matched zero rows.
 *
 * The measured idle came from the startup hook. On 2026-09-29 every direct
 * Claude Code spawn was a fresh session (12 of 12, `isResume: false`), so
 * every one fired the `startup` SessionStart hook, whose update_session_state
 * wrote `lifecycle: 'idle'` about a second into the run; all 11 that finished
 * were fenced out. Under `ink chat` the same write came from a provider that
 * started a fresh session mid-turn, and left the row stuck `running` under an
 * epoch nobody held. The compaction hooks write `compacting` and `idle` the
 * same way; that path is from reading the code, not from a measured run.
 *
 * These tests drive the real handlers through the registered commands, with
 * fetch recording every request they make.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Command } from 'commander';

// The hook log and user config resolve under HOME at import; keep both off
// the real ~/.ink.
const originalHome = vi.hoisted(() => {
  const home = process.env.HOME;
  process.env.HOME = `${process.env.TMPDIR || '/tmp'}/ink-hooks-server-run-home-${process.pid}`;
  return home;
});

vi.mock('../auth/tokens.js', () => ({
  getValidAccessToken: vi.fn(async () => null),
  getValidDelegatedAccessToken: vi.fn(() => null),
  loadAuth: vi.fn(),
  isTokenExpired: vi.fn(),
  decodeJwtPayload: vi.fn(),
}));

import { registerHooksCommands } from './hooks.js';

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000003';

interface Recorded {
  url: string;
  body: Record<string, unknown> | undefined;
}

function headlessContext(): string {
  return Buffer.from(
    JSON.stringify({ sessionId: SESSION_ID, studioId: 'main', sbSlug: 'wren', cliAttached: false })
  ).toString('base64url');
}

describe('hooks: a backend the server spawned leaves the lifecycle to the run', () => {
  const ENV_KEYS = [
    'INK_CONTEXT',
    'INK_SESSION_ID',
    'INK_SERVER_URL',
    'SB_SLUG',
    'AGENT_ID',
    'INK_STUDIO_ID',
  ] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let requests: Recorded[];
  let workDir: string;
  let originalCwd: string;
  let stdinWasTty: boolean | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.INK_SERVER_URL = 'http://ink.test';
    process.env.INK_SESSION_ID = SESSION_ID;
    process.env.SB_SLUG = 'wren';

    workDir = mkdtempSync(join(tmpdir(), 'ink-hooks-server-run-'));
    originalCwd = process.cwd();
    process.chdir(workDir);

    // A TTY stdin reads as "no payload" without waiting on the stream.
    stdinWasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        requests.push({ url: String(url), body });
        const payload = String(url).endsWith('/mcp')
          ? {
              jsonrpc: '2.0',
              id: body?.id ?? 1,
              result: { content: [{ type: 'text', text: '{"success":true}' }] },
            }
          : { success: true };
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        } as Response;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinWasTty, configurable: true });
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  async function runHook(...args: string[]) {
    const program = new Command();
    program.exitOverride();
    registerHooksCommands(program);
    await program.parseAsync(['hooks', ...args], { from: 'user' });
  }

  /** Every update_session_state the handler sent, as its tool arguments. */
  function stateUpdates(): Array<Record<string, unknown>> {
    return requests
      .filter((r) => r.url.endsWith('/mcp'))
      .map((r) => r.body?.params as { name?: string; arguments?: Record<string, unknown> })
      .filter((params) => params?.name === 'update_session_state')
      .map((params) => params.arguments ?? {});
  }

  /** Every lifecycle-route request the handler sent. */
  function lifecyclePosts(): Array<Record<string, unknown>> {
    return requests.filter((r) => r.url.endsWith('/api/hooks/lifecycle')).map((r) => r.body ?? {});
  }

  it('a spawned session start links the session without writing lifecycle', async () => {
    process.env.INK_CONTEXT = headlessContext();

    await runHook('on-session-start', '--backend', 'claude-code');

    const updates = stateUpdates().filter((args) => args.sessionId === SESSION_ID);
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('lifecycle');
    // The linkage still goes: the startup write is also where the session
    // learns its working directory.
    expect(updates[0].workingDir).toBe(process.cwd());
  });

  it('control: a person starting a session still marks it idle', async () => {
    await runHook('on-session-start', '--backend', 'claude-code');

    const updates = stateUpdates().filter((args) => args.sessionId === SESSION_ID);
    expect(updates).toHaveLength(1);
    expect(updates[0].lifecycle).toBe('idle');
  });

  it("a spawned session's compaction declares itself headless, so the route writes no lifecycle", async () => {
    process.env.INK_CONTEXT = headlessContext();

    await runHook('pre-compact', '--backend', 'claude-code');
    await runHook('post-compact');

    const posts = lifecyclePosts();
    expect(posts.map((p) => p.event)).toEqual(['pre-compact', 'post-compact']);
    for (const post of posts) expect(post.headless).toBe(true);
  });

  it("control: a person's compaction still reports compacting and idle", async () => {
    await runHook('pre-compact', '--backend', 'claude-code');
    await runHook('post-compact');

    const posts = lifecyclePosts();
    expect(posts.map((p) => [p.event, p.lifecycle])).toEqual([
      ['pre-compact', 'compacting'],
      ['post-compact', 'idle'],
    ]);
    for (const post of posts) expect(post).not.toHaveProperty('headless');
  });
});
