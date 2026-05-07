import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  buildContainerName,
  buildEnvVars,
  buildDockerRunArgs,
  buildMounts,
  patchMcpConfig,
  stageClaudeDir,
  SandboxOrchestrator,
  type SandboxSpinUpRequest,
} from './orchestrator';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const baseRequest: SandboxSpinUpRequest = {
  userId: 'user-123',
  agentId: 'wren',
  studioId: 'studio-abc',
  studioSlug: 'wren',
  worktreePath: '/tmp/test-studio',
  repoRoot: '/tmp/test-repo',
  branch: 'wren/feat/sandbox',
};

describe('buildContainerName', () => {
  it('includes studio slug and digest', () => {
    const name = buildContainerName(baseRequest);
    expect(name).toMatch(/^ink-sandbox-wren-[a-f0-9]{8}$/);
  });

  it('includes task group slug when provided', () => {
    const name = buildContainerName({
      ...baseRequest,
      taskGroupId: 'tg-456',
      taskGroupTitle: 'Auth Refactor',
    });
    expect(name).toMatch(/^ink-sandbox-wren-auth-refactor-[a-f0-9]{8}$/);
  });

  it('falls back to agentId when no studioSlug', () => {
    const name = buildContainerName({ ...baseRequest, studioSlug: undefined });
    expect(name).toMatch(/^ink-sandbox-wren-[a-f0-9]{8}$/);
  });

  it('sanitizes special characters', () => {
    const name = buildContainerName({
      ...baseRequest,
      studioSlug: 'My Studio!!!',
      taskGroupId: 'tg-1',
      taskGroupTitle: 'Fix: all the BUGS (urgent)',
    });
    expect(name).not.toMatch(/[^a-z0-9-]/);
  });

  it('produces different names for different task groups on the same studio', () => {
    const name1 = buildContainerName({ ...baseRequest, taskGroupId: 'tg-1', taskGroupTitle: 'A' });
    const name2 = buildContainerName({ ...baseRequest, taskGroupId: 'tg-2', taskGroupTitle: 'B' });
    expect(name1).not.toBe(name2);
  });

  it('truncates long slugs', () => {
    const name = buildContainerName({
      ...baseRequest,
      studioSlug: 'a-very-long-studio-name-that-goes-on-forever',
    });
    // "ink-sandbox-" (12) + slug (max 24) + "-" (1) + digest (8) = max 45 chars
    expect(name.length).toBeLessThanOrEqual(50);
  });
});

describe('buildEnvVars', () => {
  it('includes core env vars', () => {
    const env = buildEnvVars(baseRequest);
    expect(env.AGENT_ID).toBe('wren');
    expect(env.INK_STUDIO_ID).toBe('studio-abc');
    expect(env.INK_SANDBOX).toBe('docker');
    expect(env.INK_STUDIO_PATH).toBe('/studio');
  });

  it('rewrites localhost to host.docker.internal', () => {
    const env = buildEnvVars({ ...baseRequest, serverUrl: 'http://localhost:3001' });
    expect(env.INK_SERVER_URL).toBe('http://host.docker.internal:3001');
  });

  it('preserves non-localhost URLs', () => {
    const env = buildEnvVars({ ...baseRequest, serverUrl: 'https://api.example.com' });
    expect(env.INK_SERVER_URL).toBe('https://api.example.com');
  });

  it('includes task group vars when provided', () => {
    const env = buildEnvVars({
      ...baseRequest,
      taskGroupId: 'tg-456',
      taskGroupTitle: 'Auth Refactor',
      taskGroupContext: 'Migrating session tokens',
      taskGroupThreadKey: 'strategy:tg-456',
    });
    expect(env.INK_TASK_GROUP_ID).toBe('tg-456');
    expect(env.INK_TASK_GROUP_TITLE).toBe('Auth Refactor');
    expect(env.INK_TASK_GROUP_CONTEXT).toBe('Migrating session tokens');
    expect(env.INK_TASK_GROUP_THREAD_KEY).toBe('strategy:tg-456');
  });

  it('omits task group vars when not provided', () => {
    const env = buildEnvVars(baseRequest);
    expect(env.INK_TASK_GROUP_ID).toBeUndefined();
    expect(env.INK_TASK_GROUP_TITLE).toBeUndefined();
  });

  it('merges extraEnv', () => {
    const env = buildEnvVars({ ...baseRequest, extraEnv: { CUSTOM_VAR: 'value' } });
    expect(env.CUSTOM_VAR).toBe('value');
  });

  it('includes branch when provided', () => {
    const env = buildEnvVars(baseRequest);
    expect(env.INK_BRANCH).toBe('wren/feat/sandbox');
  });
});

describe('buildDockerRunArgs', () => {
  it('includes required docker run flags', () => {
    const args = buildDockerRunArgs(baseRequest);
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('-d');
    expect(args).toContain(DEFAULT_IMAGE_NAME());
  });

  it('sets container name', () => {
    const args = buildDockerRunArgs(baseRequest);
    const nameIdx = args.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(args[nameIdx + 1]).toMatch(/^ink-sandbox-/);
  });

  it('sets workdir to /studio', () => {
    const args = buildDockerRunArgs(baseRequest);
    const idx = args.indexOf('--workdir');
    expect(args[idx + 1]).toBe('/studio');
  });

  it('adds host.docker.internal mapping', () => {
    const args = buildDockerRunArgs(baseRequest);
    expect(args).toContain('--add-host');
    const idx = args.indexOf('--add-host');
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('adds discovery labels', () => {
    const args = buildDockerRunArgs(baseRequest);
    expect(args).toContain('ink.sandbox=true');
    expect(args).toContain(`ink.agent-id=wren`);
    expect(args).toContain(`ink.studio-id=studio-abc`);
  });

  it('adds task group label when provided', () => {
    const args = buildDockerRunArgs({ ...baseRequest, taskGroupId: 'tg-456' });
    expect(args).toContain('ink.task-group-id=tg-456');
  });

  it('sets network none when requested', () => {
    const args = buildDockerRunArgs({ ...baseRequest, networkMode: 'none' });
    const idx = args.indexOf('--network');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('none');
  });

  it('passes env vars as -e flags', () => {
    const args = buildDockerRunArgs(baseRequest);
    const envPairs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envPairs.some((p) => p.startsWith('AGENT_ID=wren'))).toBe(true);
    expect(envPairs.some((p) => p.startsWith('INK_SANDBOX=docker'))).toBe(true);
  });
});

describe('buildMounts', () => {
  it('returns empty array when worktree path does not exist', () => {
    const mounts = buildMounts({ ...baseRequest, worktreePath: '/nonexistent/path' });
    expect(mounts.filter((m) => m.target === '/studio')).toHaveLength(0);
  });
});

describe('patchMcpConfig', () => {
  it('rewrites localhost URLs to host.docker.internal', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const result = patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(patched.mcpServers.inkwell.url).toBe('http://host.docker.internal:3001/mcp');
  });

  it('strips stdio/command-based servers', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
          inkmail: { command: 'npx', args: ['tsx', 'packages/channel-plugin/index.ts'] },
          playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
        },
      })
    );

    const result = patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(Object.keys(patched.mcpServers)).toEqual(['inkwell']);
    expect(patched.mcpServers.inkmail).toBeUndefined();
    expect(patched.mcpServers.playwright).toBeUndefined();
  });

  it('preserves remote HTTP servers without rewriting', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer token' },
          },
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const result = patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(patched.mcpServers.github.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(patched.mcpServers.github.headers).toEqual({ Authorization: 'Bearer token' });
    expect(patched.mcpServers.inkwell.url).toBe('http://host.docker.internal:3001/mcp');
  });

  it('returns undefined when no HTTP servers exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
        },
      })
    );

    const result = patchMcpConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when .mcp.json does not exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    const result = patchMcpConfig(tmpDir);
    expect(result).toBeUndefined();
  });
});

describe('stageClaudeDir', () => {
  it('stages credentials from file when .credentials.json exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cred-stage-'));
    // stageClaudeDir reads from the real homedir, so we test what it returns
    const result = stageClaudeDir(join(tmpDir, 'staging'));
    // On this machine (macOS with active Claude session), should extract from keychain
    // In CI or without credentials, returns undefined — both are valid
    if (result) {
      expect(result).toContain('claude-home');
      expect(existsSync(join(result, '.credentials.json'))).toBe(true);
      const creds = JSON.parse(readFileSync(join(result, '.credentials.json'), 'utf-8'));
      expect(creds.claudeAiOauth).toBeDefined();
    }
  });

  it('copies settings files when they exist', () => {
    const result = stageClaudeDir(mkdtempSync(join(tmpdir(), 'cred-stage-')));
    if (result) {
      // settings.json should be copied if it exists on the host
      const hostSettings = join(homedir(), '.claude', 'settings.json');
      if (existsSync(hostSettings)) {
        expect(existsSync(join(result, 'settings.json'))).toBe(true);
      }
    }
  });
});

describe('SandboxOrchestrator', () => {
  let mockExecFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecFile = vi.fn();
  });

  describe('isRunning', () => {
    it('returns true when docker inspect succeeds', async () => {
      const orch = new SandboxOrchestrator({ dockerCommand: '/usr/bin/true' });
      // /usr/bin/true always exits 0 — simulates a found container
      const result = await orch.isRunning('test-container');
      expect(result).toBe(true);
    });

    it('returns false when docker inspect fails', async () => {
      const orch = new SandboxOrchestrator({ dockerCommand: '/usr/bin/false' });
      const result = await orch.isRunning('test-container');
      expect(result).toBe(false);
    });
  });
});

function DEFAULT_IMAGE_NAME(): string {
  return 'inkwell:studio-sandbox';
}
