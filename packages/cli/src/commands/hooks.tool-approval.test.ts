/**
 * `ink hooks on-tool-approval`, run as Claude Code runs it: the built CLI,
 * the hook input on stdin, and the decision read back from stdout and the
 * exit code (spec automated-turn-permissions §3.4).
 *
 * Two things are pinned. Every refusal is a JSON `deny` with exit 0, never
 * plain text with exit 1, which Claude Code treats as a non-blocking error
 * and runs the tool anyway (docs: hooks, "Exit code output"). And the
 * destructive-command decision: allowed inside the session's own linked
 * worktree, asked of a person attached, and requested from Conor without
 * waiting for a headless turn.
 *
 * Needs the CLI built (`yarn workspace @inklabs/cli build`), as the other
 * entry-point tests do.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let base: string;
let home: string;
let worktree: string;
let mainCheckout: string;
const servers: Server[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ink-tool-approval-')));
  home = join(base, 'home');
  worktree = join(base, 'repo--alpha');
  mainCheckout = join(base, 'repo');
  mkdirSync(join(home, '.ink', 'files', 'wren-scratch'), { recursive: true });
  mkdirSync(join(worktree, 'dist'), { recursive: true });
  mkdirSync(join(mainCheckout, '.git'), { recursive: true });
  mkdirSync(join(mainCheckout, 'dist'), { recursive: true });
  // A linked worktree's .git is a file naming the main checkout's git dir.
  writeFileSync(join(worktree, '.git'), `gitdir: ${mainCheckout}/.git/worktrees/alpha\n`);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(base, { recursive: true, force: true });
});

/** A server that answers approval-request creation, recording each body. */
async function approvalServer(): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/admin/approval-requests') {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requestId: 'req-fixture-1' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}

const headless = Buffer.from(
  JSON.stringify({ sessionId: 's-1', studioId: 'studio-1', sbSlug: 'wren', cliAttached: false })
).toString('base64url');

interface HookRun {
  code: number | null;
  stdout: string;
  decision?: { permissionDecision: string; permissionDecisionReason: string };
}

function runHook(
  command: string,
  options: { cwd?: string; projectDir?: string; serverUrl?: string; context?: string } = {}
): Promise<HookRun> {
  const cwd = options.cwd ?? worktree;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    SB_SLUG: 'wren',
    INK_SERVER_URL: options.serverUrl ?? 'http://127.0.0.1:9',
    CLAUDE_PROJECT_DIR: options.projectDir ?? worktree,
    ...(options.context ? { INK_CONTEXT: options.context } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'hooks', 'on-tool-approval', '--backend', 'claude-code'],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop() ?? '';
      let decision: HookRun['decision'];
      try {
        decision = (JSON.parse(line) as { hookSpecificOutput: HookRun['decision'] })
          .hookSpecificOutput;
      } catch {
        decision = undefined;
      }
      resolve({ code, stdout, decision });
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command, description: 'fixture' },
        cwd,
      })
    );
  });
}

describe('on-tool-approval: destructive commands', () => {
  it('a delete inside the linked-worktree launch checkout runs: no decision, exit 0', async () => {
    const run = await runHook('rm -rf dist');
    expect(run.code).toBe(0);
    expect(run.decision).toBeUndefined();
  });

  it('a delete inside the SB scratch directory runs', async () => {
    const run = await runHook(`rm -rf ${join(home, '.ink', 'files', 'wren-scratch', 'x')}`);
    expect(run.code).toBe(0);
    expect(run.decision).toBeUndefined();
  });

  it('attached, a delete outside asks the person: Claude Code shows its own prompt', async () => {
    const run = await runHook(`rm -rf ${join(mainCheckout, 'dist')}`);
    expect(run.code).toBe(0);
    expect(run.decision?.permissionDecision).toBe('ask');
    expect(run.decision?.permissionDecisionReason).toContain('not inside');
  });

  it('a main checkout is never a root: deleting inside it asks', async () => {
    const run = await runHook('rm -rf dist', { cwd: mainCheckout, projectDir: mainCheckout });
    expect(run.decision?.permissionDecision).toBe('ask');
  });

  it('git reset --hard always asks, even in the studio', async () => {
    const run = await runHook('git reset --hard');
    expect(run.decision?.permissionDecision).toBe('ask');
  });

  it('headless, a delete outside requests approval and is denied at once, naming the request', async () => {
    const server = await approvalServer();
    const run = await runHook(`rm -rf ${join(mainCheckout, 'dist')}`, {
      serverUrl: server.url,
      context: headless,
    });
    expect(run.code).toBe(0);
    expect(run.decision?.permissionDecision).toBe('deny');
    expect(run.decision?.permissionDecisionReason).toContain('req-fixture-1');
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0]).toMatchObject({ tool: 'Bash', timeoutSeconds: 1800 });
  });

  it('headless, with the approval server unreachable, it is denied: fail closed, not open', async () => {
    const run = await runHook(`rm -rf ${join(mainCheckout, 'dist')}`, { context: headless });
    expect(run.code).toBe(0);
    expect(run.decision?.permissionDecision).toBe('deny');
  });

  it('a command that is not destructive gets no decision', async () => {
    const run = await runHook('yarn test');
    expect(run.code).toBe(0);
    expect(run.decision).toBeUndefined();
  });
});

describe('on-tool-approval: the 2FA refusals fail closed', () => {
  it('an approvalRequired match with the server unreachable is a JSON deny, not exit 1', async () => {
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    writeFileSync(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { approvalRequired: ['Bash(echo 2fa-test*)'] } })
    );
    const run = await runHook('echo 2fa-test now');
    expect(run.code).toBe(0);
    expect(run.decision?.permissionDecision).toBe('deny');
    expect(run.decision?.permissionDecisionReason).toContain('could not reach approval server');
  });
});
