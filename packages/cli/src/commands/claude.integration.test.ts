import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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

    const pcpToolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown; headers?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        const rawHeaders = (init?.headers || {}) as Record<string, unknown>;
        const normalizedHeaders = Object.fromEntries(
          Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), String(value)])
        );
        pcpToolCalls.push({ name: toolName, args: toolArgs, headers: normalizedHeaders });

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
    process.env.FAKE_CLAUDE_SESSION_ID = 'claude-session-int-1';
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
      expect(startSessionCall?.headers['x-pcp-caller-profile']).toBe('runtime');
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
      expect(persistedBackendSessionId).toBe('claude-session-int-1');

      const phaseUpdatesWithBackendId = pcpToolCalls
        .filter((call) => call.name === 'update_session_phase')
        .some((call) => call.args.backendSessionId === 'claude-session-int-1');
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

  it('creates codex PCP session with runtime profile and persists backend session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-codex-int-'));
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

    const fakeCodexArgsPath = join(root, 'fake-codex-args.json');
    const fakeCodexPath = join(binDir, 'codex');
    writeFileSync(
      fakeCodexPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('fs');
writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ session_id: process.env.FAKE_CODEX_SESSION_ID || 'codex-int-default' }));
`
    );
    chmodSync(fakeCodexPath, 0o755);

    const pcpToolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown; headers?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        const rawHeaders = (init?.headers || {}) as Record<string, unknown>;
        const normalizedHeaders = Object.fromEntries(
          Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), String(value)])
        );
        pcpToolCalls.push({ name: toolName, args: toolArgs, headers: normalizedHeaders });

        let payload: Record<string, unknown> = { success: true };
        if (toolName === 'list_sessions') {
          payload = { sessions: [] };
        } else if (toolName === 'start_session') {
          payload = {
            session: {
              id: String(toolArgs.sessionId || 'generated-session-id'),
              startedAt: new Date().toISOString(),
              backend: 'codex',
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
    const oldArgsPath = process.env.FAKE_CODEX_ARGS_PATH;
    const oldFakeSessionId = process.env.FAKE_CODEX_SESSION_ID;
    const oldCwd = process.cwd();

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${oldPath || ''}`;
    process.env.PCP_SERVER_URL = 'http://pcp.test.local';
    process.env.FAKE_CODEX_ARGS_PATH = fakeCodexArgsPath;
    process.env.FAKE_CODEX_SESSION_ID = 'codex-session-int-1';
    process.chdir(repoDir);

    try {
      const options: SbOptions = {
        agent: 'lumen',
        model: undefined,
        session: true,
        verbose: false,
        backend: 'codex',
      };

      await runClaude('hello codex', ['hello', 'codex'], options, []);
      await waitForFile(fakeCodexArgsPath);

      const runtimePath = join(repoDir, '.pcp', 'runtime', 'sessions.json');
      await waitForFile(runtimePath);

      const backendArgs = JSON.parse(readFileSync(fakeCodexArgsPath, 'utf-8')) as string[];
      const startSessionCall = pcpToolCalls.find((call) => call.name === 'start_session');
      expect(startSessionCall?.headers['x-pcp-caller-profile']).toBe('runtime');
      expect(startSessionCall?.args.backend).toBe('codex');
      expect(backendArgs).not.toContain('resume');

      const runtimeState = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
        sessions: Array<{ backendSessionId?: string }>;
      };
      const persistedBackendSessionId =
        runtimeState.sessions[0]?.backendSessionId ||
        (await waitForRuntimeBackendSessionId(runtimePath, 5_000));
      expect(persistedBackendSessionId).toBe('codex-session-int-1');

      const phaseUpdatesWithBackendId = pcpToolCalls
        .filter((call) => call.name === 'update_session_phase')
        .some((call) => call.args.backendSessionId === 'codex-session-int-1');
      expect(phaseUpdatesWithBackendId).toBe(true);
    } finally {
      process.chdir(oldCwd);

      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;

      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;

      if (oldPcpUrl === undefined) delete process.env.PCP_SERVER_URL;
      else process.env.PCP_SERVER_URL = oldPcpUrl;

      if (oldArgsPath === undefined) delete process.env.FAKE_CODEX_ARGS_PATH;
      else process.env.FAKE_CODEX_ARGS_PATH = oldArgsPath;

      if (oldFakeSessionId === undefined) delete process.env.FAKE_CODEX_SESSION_ID;
      else process.env.FAKE_CODEX_SESSION_ID = oldFakeSessionId;
    }
  });

  it('creates gemini PCP session with runtime profile and persists backend session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-gemini-int-'));
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

    const fakeGeminiArgsPath = join(root, 'fake-gemini-args.json');
    const fakeGeminiPath = join(binDir, 'gemini');
    writeFileSync(
      fakeGeminiPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('fs');
writeFileSync(process.env.FAKE_GEMINI_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ session_id: process.env.FAKE_GEMINI_SESSION_ID || 'gemini-int-default' }));
`
    );
    chmodSync(fakeGeminiPath, 0o755);

    const pcpToolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown; headers?: unknown }) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          id?: number;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const toolName = body.params?.name || '';
        const toolArgs = body.params?.arguments || {};
        const rawHeaders = (init?.headers || {}) as Record<string, unknown>;
        const normalizedHeaders = Object.fromEntries(
          Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), String(value)])
        );
        pcpToolCalls.push({ name: toolName, args: toolArgs, headers: normalizedHeaders });

        let payload: Record<string, unknown> = { success: true };
        if (toolName === 'list_sessions') {
          payload = { sessions: [] };
        } else if (toolName === 'start_session') {
          payload = {
            session: {
              id: String(toolArgs.sessionId || 'generated-session-id'),
              startedAt: new Date().toISOString(),
              backend: 'gemini',
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
    const oldArgsPath = process.env.FAKE_GEMINI_ARGS_PATH;
    const oldFakeSessionId = process.env.FAKE_GEMINI_SESSION_ID;
    const oldCwd = process.cwd();

    process.env.HOME = homeDir;
    process.env.PATH = `${binDir}:${oldPath || ''}`;
    process.env.PCP_SERVER_URL = 'http://pcp.test.local';
    process.env.FAKE_GEMINI_ARGS_PATH = fakeGeminiArgsPath;
    process.env.FAKE_GEMINI_SESSION_ID = 'gemini-session-int-1';
    process.chdir(repoDir);

    try {
      const options: SbOptions = {
        agent: 'aster',
        model: undefined,
        session: true,
        verbose: false,
        backend: 'gemini',
      };

      await runClaude('hello gemini', ['hello', 'gemini'], options, []);
      await waitForFile(fakeGeminiArgsPath);

      const runtimePath = join(repoDir, '.pcp', 'runtime', 'sessions.json');
      await waitForFile(runtimePath);

      const backendArgs = JSON.parse(readFileSync(fakeGeminiArgsPath, 'utf-8')) as string[];
      const startSessionCall = pcpToolCalls.find((call) => call.name === 'start_session');
      expect(startSessionCall?.headers['x-pcp-caller-profile']).toBe('runtime');
      expect(startSessionCall?.args.backend).toBe('gemini');
      expect(backendArgs).toContain('-p');
      expect(backendArgs).not.toContain('--resume');

      const runtimeState = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
        sessions: Array<{ backendSessionId?: string }>;
      };
      const persistedBackendSessionId =
        runtimeState.sessions[0]?.backendSessionId ||
        (await waitForRuntimeBackendSessionId(runtimePath, 5_000));
      expect(persistedBackendSessionId).toBe('gemini-session-int-1');

      const phaseUpdatesWithBackendId = pcpToolCalls
        .filter((call) => call.name === 'update_session_phase')
        .some((call) => call.args.backendSessionId === 'gemini-session-int-1');
      expect(phaseUpdatesWithBackendId).toBe(true);
    } finally {
      process.chdir(oldCwd);

      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;

      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;

      if (oldPcpUrl === undefined) delete process.env.PCP_SERVER_URL;
      else process.env.PCP_SERVER_URL = oldPcpUrl;

      if (oldArgsPath === undefined) delete process.env.FAKE_GEMINI_ARGS_PATH;
      else process.env.FAKE_GEMINI_ARGS_PATH = oldArgsPath;

      if (oldFakeSessionId === undefined) delete process.env.FAKE_GEMINI_SESSION_ID;
      else process.env.FAKE_GEMINI_SESSION_ID = oldFakeSessionId;
    }
  });
});
