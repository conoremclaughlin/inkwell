import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runClaude, type SbOptions } from './claude.js';

const cleanupPaths: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

async function waitForRuntimeBackendSessionId(
  runtimePath: string,
  timeoutMs = 5_000
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(runtimePath)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
          sessions?: Array<{ backendSessionId?: string }>;
        };
        const id = parsed.sessions?.[0]?.backendSessionId;
        if (id) return id;
      } catch {
        // keep polling
      }
    }
    await delay(50);
  }
  return undefined;
}

async function waitForBackendArgs(
  argsPath: string,
  predicate: (args: string[]) => boolean,
  timeoutMs = 5_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(argsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(argsPath, 'utf-8')) as unknown;
        if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')) {
          const args = parsed as string[];
          if (predicate(args)) return args;
        }
      } catch {
        // keep polling
      }
    }
    await delay(25);
  }

  throw new Error(`Timed out waiting for backend args in ${argsPath}`);
}

afterEach(() => {
  vi.unstubAllGlobals();

  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) continue;
    rmSync(path, { recursive: true, force: true });
  }
});

describe('claude command integration', () => {
  it('seeds --session-id for first run and persists captured backend session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-claude-int-'));
    cleanupPaths.push(root);

    const homeDir = join(root, 'home');
    const repoDir = join(root, 'repo');
    const binDir = join(root, 'bin');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(homeDir, '.pcp'), { recursive: true });
    mkdirSync(join(repoDir, '.pcp'), { recursive: true });

    writeFileSync(
      join(homeDir, '.pcp', 'config.json'),
      JSON.stringify({ email: 'integration@example.com' }, null, 2)
    );
    writeFileSync(
      join(repoDir, '.pcp', 'identity.json'),
      JSON.stringify({ studioId: 'studio-test' }, null, 2)
    );

    const fakeClaudeArgsPath = join(root, 'fake-claude-args.json');
    const fakeClaudePath = join(binDir, 'claude');
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
const { writeFileSync } = require('fs');
writeFileSync(process.env.FAKE_CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ session_id: process.env.FAKE_CLAUDE_SESSION_ID || 'claude-int-default' }));
`
    );
    chmodSync(fakeClaudePath, 0o755);

    const pcpToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        pcpToolCalls.push({ name: toolName, args: toolArgs });

        let payload: Record<string, unknown> = { success: true };
        if (toolName === 'list_sessions') {
          payload = { sessions: [] };
        } else if (toolName === 'start_session') {
          payload = {
            session: {
              id: String(toolArgs.sessionId || 'generated-session-id'),
              startedAt: new Date().toISOString(),
              backend: 'claude',
            },
          };
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      })
    );

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const oldPcpUrl = process.env.PCP_SERVER_URL;
    const oldArgsPath = process.env.FAKE_CLAUDE_ARGS_PATH;
    const oldFakeSessionId = process.env.FAKE_CLAUDE_SESSION_ID;
    const oldCwd = process.cwd();

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${oldPath || ''}`;
    process.env.PCP_SERVER_URL = 'http://pcp.test.local';
    process.env.FAKE_CLAUDE_ARGS_PATH = fakeClaudeArgsPath;
    process.env.FAKE_CLAUDE_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    process.chdir(repoDir);

    try {
      const options: SbOptions = {
        agent: 'wren',
        model: undefined,
        session: true,
        verbose: false,
        backend: 'claude',
      };

      await runClaude('hello integration', ['hello', 'integration'], options, []);
      await waitForFile(fakeClaudeArgsPath);

      const runtimePath = join(repoDir, '.pcp', 'runtime', 'sessions.json');
      await waitForFile(runtimePath);

      const backendArgs = JSON.parse(readFileSync(fakeClaudeArgsPath, 'utf-8')) as string[];
      const startSessionCall = pcpToolCalls.find((call) => call.name === 'start_session');
      const seededPcpSessionId = String(startSessionCall?.args.sessionId || '');
      expect(seededPcpSessionId).not.toBe('');
      expect(backendArgs).toContain('-p');
      const sessionIdFlagIndex = backendArgs.indexOf('--session-id');
      expect(sessionIdFlagIndex).toBeGreaterThanOrEqual(0);
      expect(backendArgs[sessionIdFlagIndex + 1]).toBe(seededPcpSessionId);

      const runtimeState = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
        sessions: Array<{ backendSessionId?: string }>;
      };
      const persistedBackendSessionId =
        runtimeState.sessions[0]?.backendSessionId ||
        (await waitForRuntimeBackendSessionId(runtimePath, 5_000));
      expect(persistedBackendSessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

      const phaseUpdatesWithBackendId = pcpToolCalls
        .filter((call) => call.name === 'update_session_phase')
        .some((call) => call.args.backendSessionId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(phaseUpdatesWithBackendId).toBe(true);
    } finally {
      process.chdir(oldCwd);

      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;

      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;

      if (oldPcpUrl === undefined) delete process.env.PCP_SERVER_URL;
      else process.env.PCP_SERVER_URL = oldPcpUrl;

      if (oldArgsPath === undefined) delete process.env.FAKE_CLAUDE_ARGS_PATH;
      else process.env.FAKE_CLAUDE_ARGS_PATH = oldArgsPath;

      if (oldFakeSessionId === undefined) delete process.env.FAKE_CLAUDE_SESSION_ID;
      else process.env.FAKE_CLAUDE_SESSION_ID = oldFakeSessionId;
    }
  });

  it('uses stale-session recovery strategy for existing PCP sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-claude-stale-int-'));
    cleanupPaths.push(root);

    const homeDir = join(root, 'home');
    const repoDir = join(root, 'repo');
    const binDir = join(root, 'bin');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(homeDir, '.pcp'), { recursive: true });
    mkdirSync(join(repoDir, '.pcp'), { recursive: true });

    writeFileSync(
      join(homeDir, '.pcp', 'config.json'),
      JSON.stringify({ email: 'integration@example.com' }, null, 2)
    );

    const fakeClaudeArgsPath = join(root, 'fake-claude-args-stale.json');
    const fakeClaudePath = join(binDir, 'claude');
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
const { writeFileSync } = require('fs');
writeFileSync(process.env.FAKE_CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`
    );
    chmodSync(fakeClaudePath, 0o755);

    const pcpSessionId = '11111111-1111-4111-8111-111111111111';
    const trackedSession = {
      id: pcpSessionId,
      startedAt: new Date().toISOString(),
      backend: 'claude',
      backendSessionId: 'stale-backend-id',
      workingDir: repoDir,
    };
    const pcpToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        pcpToolCalls.push({ name: toolName, args: toolArgs });

        let payload: Record<string, unknown> = { success: true };
        if (toolName === 'list_sessions') {
          payload = { sessions: [trackedSession] };
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      })
    );

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const oldPcpUrl = process.env.PCP_SERVER_URL;
    const oldArgsPath = process.env.FAKE_CLAUDE_ARGS_PATH;
    const oldCwd = process.cwd();
    const oldIsTTY = process.stdin.isTTY;

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${oldPath || ''}`;
    process.env.PCP_SERVER_URL = 'http://pcp.test.local';
    process.env.FAKE_CLAUDE_ARGS_PATH = fakeClaudeArgsPath;
    process.chdir(repoDir);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const projectDirNames = new Set([
        repoDir.replace(/[\\/]/g, '-'),
        realpathSync(repoDir).replace(/[\\/]/g, '-'),
      ]);
      const claudeProjectDirs = Array.from(projectDirNames).map((name) =>
        join(homeDir, '.claude', 'projects', name)
      );
      for (const dir of claudeProjectDirs) {
        mkdirSync(dir, { recursive: true });
      }
      // Ensure project-local session index is non-empty so stale detection is applied.
      for (const dir of claudeProjectDirs) {
        writeFileSync(join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), '');
      }

      const options: SbOptions = {
        agent: 'wren',
        model: undefined,
        session: true,
        verbose: false,
        backend: 'claude',
        sessionChoice: `pcp:${pcpSessionId}`,
      };

      // No orphaned local PCP-backed Claude session => seed with PCP session ID.
      await runClaude('first stale test', ['first', 'stale', 'test'], options, []);
      const firstArgs = await waitForBackendArgs(fakeClaudeArgsPath, (args) =>
        args.includes('first stale test')
      );
      expect(firstArgs).toContain('--session-id');
      expect(firstArgs).toContain(pcpSessionId);

      // Add orphaned local session file for PCP id => recover via --resume <pcpSessionId>.
      for (const dir of claudeProjectDirs) {
        writeFileSync(join(dir, `${pcpSessionId}.jsonl`), '');
      }

      await runClaude('second stale test', ['second', 'stale', 'test'], options, []);
      const secondArgs = await waitForBackendArgs(fakeClaudeArgsPath, (args) =>
        args.includes('second stale test')
      );
      const resumeFlagIndex = secondArgs.indexOf('--resume');
      expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(secondArgs[resumeFlagIndex + 1]).toBe(pcpSessionId);
      expect(secondArgs).not.toContain('--session-id');

      const phaseUpdatesWithOrphanRepair = pcpToolCalls
        .filter((call) => call.name === 'update_session_phase')
        .some(
          (call) =>
            call.args.sessionId === pcpSessionId && call.args.backendSessionId === pcpSessionId
        );
      expect(phaseUpdatesWithOrphanRepair).toBe(true);
    } finally {
      process.chdir(oldCwd);

      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;

      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;

      if (oldPcpUrl === undefined) delete process.env.PCP_SERVER_URL;
      else process.env.PCP_SERVER_URL = oldPcpUrl;

      if (oldArgsPath === undefined) delete process.env.FAKE_CLAUDE_ARGS_PATH;
      else process.env.FAKE_CLAUDE_ARGS_PATH = oldArgsPath;

      Object.defineProperty(process.stdin, 'isTTY', {
        value: oldIsTTY,
        configurable: true,
      });
    }
  });

  it('recovers stale runtime auto-resume sessions before spawning claude', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-claude-runtime-stale-'));
    cleanupPaths.push(root);

    const homeDir = join(root, 'home');
    const repoDir = join(root, 'repo');
    const binDir = join(root, 'bin');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(homeDir, '.pcp'), { recursive: true });
    mkdirSync(join(repoDir, '.pcp', 'runtime'), { recursive: true });

    writeFileSync(
      join(homeDir, '.pcp', 'config.json'),
      JSON.stringify({ email: 'integration@example.com' }, null, 2)
    );

    const pcpSessionId = '33333333-3333-4333-8333-333333333333';
    writeFileSync(
      join(repoDir, '.pcp', 'runtime', 'sessions.json'),
      JSON.stringify(
        {
          version: 1,
          current: {
            pcpSessionId,
            backend: 'claude',
            updatedAt: new Date().toISOString(),
          },
          sessions: [
            {
              pcpSessionId,
              backend: 'claude',
              agentId: 'wren',
              backendSessionId: 'stale-backend-id',
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2
      )
    );

    const projectDirNames = new Set([
      repoDir.replace(/[\\/]/g, '-'),
      realpathSync(repoDir).replace(/[\\/]/g, '-'),
    ]);
    for (const name of projectDirNames) {
      const projectDir = join(homeDir, '.claude', 'projects', name);
      mkdirSync(projectDir, { recursive: true });
      // Non-empty local set that does NOT include stale-backend-id triggers stale detection.
      writeFileSync(join(projectDir, '44444444-4444-4444-8444-444444444444.jsonl'), '');
    }

    const fakeClaudeArgsPath = join(root, 'fake-claude-args-runtime-stale.json');
    const fakeClaudePath = join(binDir, 'claude');
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env node
const { writeFileSync } = require('fs');
writeFileSync(process.env.FAKE_CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`
    );
    chmodSync(fakeClaudePath, 0o755);

    const pcpToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        pcpToolCalls.push({ name: toolName, args: toolArgs });

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      })
    );

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const oldPcpUrl = process.env.PCP_SERVER_URL;
    const oldArgsPath = process.env.FAKE_CLAUDE_ARGS_PATH;
    const oldCwd = process.cwd();
    const oldIsTTY = process.stdin.isTTY;

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${oldPath || ''}`;
    process.env.PCP_SERVER_URL = 'http://pcp.test.local';
    process.env.FAKE_CLAUDE_ARGS_PATH = fakeClaudeArgsPath;
    process.chdir(repoDir);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const options: SbOptions = {
        agent: 'wren',
        model: undefined,
        session: true,
        verbose: false,
        backend: 'claude',
      };

      await runClaude('runtime stale fast path test', ['runtime', 'stale'], options, []);
      const args = await waitForBackendArgs(fakeClaudeArgsPath, (candidate) =>
        candidate.includes('runtime stale fast path test')
      );

      expect(args).toContain('--session-id');
      expect(args).toContain(pcpSessionId);
      expect(args).not.toContain('--resume');
    } finally {
      process.chdir(oldCwd);

      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;

      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;

      if (oldPcpUrl === undefined) delete process.env.PCP_SERVER_URL;
      else process.env.PCP_SERVER_URL = oldPcpUrl;

      if (oldArgsPath === undefined) delete process.env.FAKE_CLAUDE_ARGS_PATH;
      else process.env.FAKE_CLAUDE_ARGS_PATH = oldArgsPath;

      Object.defineProperty(process.stdin, 'isTTY', {
        value: oldIsTTY,
        configurable: true,
      });
    }
  });
});
