import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  buildContainerName,
  buildEnvVars,
  buildDockerRunArgs,
  buildMounts,
  getRunnerFilesDir,
  patchMcpConfig,
  stageClaudeDir,
  stageCodexDir,
  SandboxOrchestrator,
  type SandboxSpinUpRequest,
} from './orchestrator';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The staging functions copy credentials out of the home directory and, on
// macOS, out of the login keychain. Every test here runs against a synthetic
// home and a scratch tmpdir that is removed afterwards, and no test can reach
// the real keychain: before this, each local run left copies of the machine's
// Claude and Codex logins under $TMPDIR.
const sandboxHost = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  return {
    root,
    home,
    tmp,
    keychain: undefined as string | undefined,
    keychainCalls: 0,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => sandboxHost.home, tmpdir: () => sandboxHost.tmp };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const realAsync = promisify(actual.execFile);
  const isKeychain = (command: string) => command === 'security' || command.endsWith('/security');
  const execFile = Object.assign(
    (command: string, ...rest: unknown[]) => {
      if (isKeychain(command)) throw new Error('Keychain access is blocked in tests');
      return (actual.execFile as (...args: unknown[]) => unknown)(command, ...rest);
    },
    {
      [promisify.custom]: async (command: string, args: string[], options: object) => {
        if (!isKeychain(command)) return realAsync(command, args, options);
        sandboxHost.keychainCalls += 1;
        if (sandboxHost.keychain === undefined) throw new Error('No synthetic keychain entry');
        return { stdout: sandboxHost.keychain, stderr: '' };
      },
    }
  );
  return { ...actual, execFile };
});

afterAll(() => {
  rmSync(sandboxHost.root, { recursive: true, force: true });
});

function resetHome() {
  rmSync(sandboxHost.home, { recursive: true, force: true });
  mkdirSync(sandboxHost.home);
  sandboxHost.keychain = undefined;
  sandboxHost.keychainCalls = 0;
}

function writeHomeFile(relative: string, content: string) {
  const path = join(sandboxHost.home, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

const baseRequest: SandboxSpinUpRequest = {
  userId: 'user-123',
  sbSlug: 'wren',
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

  it('falls back to sbSlug when no studioSlug', () => {
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

  it('uses containerName override when provided', () => {
    const name = buildContainerName({ ...baseRequest, containerName: 'ink-test-my-fixture' });
    expect(name).toBe('ink-test-my-fixture');
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
  it('includes required docker run flags', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('-d');
    expect(args).toContain(DEFAULT_IMAGE_NAME());
  });

  it('sets container name', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    const nameIdx = args.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(args[nameIdx + 1]).toMatch(/^ink-sandbox-/);
  });

  it('sets workdir to /studio', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    const idx = args.indexOf('--workdir');
    expect(args[idx + 1]).toBe('/studio');
  });

  it('adds host.docker.internal mapping', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    expect(args).toContain('--add-host');
    const idx = args.indexOf('--add-host');
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('adds discovery labels', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    expect(args).toContain('ink.sandbox=true');
    expect(args).toContain(`ink.agent-id=wren`);
    expect(args).toContain(`ink.studio-id=studio-abc`);
  });

  it('adds task group label when provided', async () => {
    const args = await buildDockerRunArgs({ ...baseRequest, taskGroupId: 'tg-456' });
    expect(args).toContain('ink.task-group-id=tg-456');
  });

  it('sets network none when requested', async () => {
    const args = await buildDockerRunArgs({ ...baseRequest, networkMode: 'none' });
    const idx = args.indexOf('--network');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('none');
  });

  it('passes env vars as -e flags', async () => {
    const args = await buildDockerRunArgs(baseRequest);
    const envPairs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envPairs.some((p) => p.startsWith('AGENT_ID=wren'))).toBe(true);
    expect(envPairs.some((p) => p.startsWith('INK_SANDBOX=docker'))).toBe(true);
  });
});

describe('getRunnerFilesDir', () => {
  it('returns expected path pattern under ~/.ink/runtime/sandbox/<containerName>/runner-files', () => {
    const dir = getRunnerFilesDir('ink-sandbox-wren-abc12345');
    expect(dir).toBe(
      join(homedir(), '.ink', 'runtime', 'sandbox', 'ink-sandbox-wren-abc12345', 'runner-files')
    );
  });

  it('returns distinct paths for different container names', () => {
    const dir1 = getRunnerFilesDir('ink-sandbox-wren-aaaa1111');
    const dir2 = getRunnerFilesDir('ink-sandbox-lumen-bbbb2222');
    expect(dir1).not.toBe(dir2);
  });
});

describe('buildMounts', () => {
  it('includes a mount with target /run/ink for runner temp files', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mount-ink-'));
    const mounts = await buildMounts({ ...baseRequest, worktreePath: tmpDir, repoRoot: tmpDir });
    const runInkMount = mounts.find((m) => m.target === '/run/ink');
    expect(runInkMount).toBeDefined();
    expect(runInkMount!.readOnly).toBe(false);
    // Source should end with 'runner-files'
    expect(runInkMount!.source).toMatch(/runner-files$/);
  });

  it('returns empty array when worktree path does not exist', async () => {
    const mounts = await buildMounts({ ...baseRequest, worktreePath: '/nonexistent/path' });
    expect(mounts.filter((m) => m.target === '/studio')).toHaveLength(0);
  });

  it('mounts worktree at /studio when path exists', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mount-test-'));
    const mounts = await buildMounts({ ...baseRequest, worktreePath: tmpDir, repoRoot: tmpDir });
    expect(mounts.some((m) => m.target === '/studio' && m.source === tmpDir)).toBe(true);
  });

  it('resolves git worktree mounts when .git is a file', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'repo-'));
    const worktreeDir = mkdtempSync(join(tmpdir(), 'worktree-'));

    // Create canonical .git structure
    mkdirSync(join(repoDir, '.git', 'worktrees', 'my-branch'), { recursive: true });

    // Create .git file (worktree marker)
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${repoDir}/.git/worktrees/my-branch\n`);

    const mounts = await buildMounts({
      ...baseRequest,
      worktreePath: worktreeDir,
      repoRoot: repoDir,
    });

    // Should mount canonical .git dir
    const gitDirMount = mounts.find((m) => m.target === '/repo/.git');
    expect(gitDirMount).toBeDefined();
    expect(gitDirMount!.source).toBe(join(repoDir, '.git'));

    // Should mount patched .git file
    const gitFileMount = mounts.find((m) => m.target === '/studio/.git');
    expect(gitFileMount).toBeDefined();
    expect(gitFileMount!.readOnly).toBe(true);

    // Patched .git file should point to container path
    const patchedContent = readFileSync(gitFileMount!.source, 'utf-8');
    expect(patchedContent).toBe('gitdir: /repo/.git/worktrees/my-branch\n');
  });

  it('skips git worktree mounts when .git is a directory', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'repo-git-dir-'));
    mkdirSync(join(tmpDir, '.git'), { recursive: true });

    const mounts = await buildMounts({
      ...baseRequest,
      worktreePath: tmpDir,
      repoRoot: tmpDir,
    });

    // No /repo/.git mount needed — .git dir is inside the bind mount
    expect(mounts.find((m) => m.target === '/repo/.git')).toBeUndefined();
  });
});

describe('patchMcpConfig', () => {
  it('rewrites localhost URLs to host.docker.internal', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const result = await patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(patched.mcpServers.inkwell.url).toBe('http://host.docker.internal:3001/mcp');
  });

  it('strips stdio/command-based servers', async () => {
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

    const result = await patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(Object.keys(patched.mcpServers)).toEqual(['inkwell']);
    expect(patched.mcpServers.inkmail).toBeUndefined();
    expect(patched.mcpServers.playwright).toBeUndefined();
  });

  it('preserves remote HTTP servers without rewriting', async () => {
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

    const result = await patchMcpConfig(tmpDir);
    expect(result).toBeTruthy();
    const patched = JSON.parse(readFileSync(result!, 'utf-8'));
    expect(patched.mcpServers.github.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(patched.mcpServers.github.headers).toEqual({ Authorization: 'Bearer token' });
    expect(patched.mcpServers.inkwell.url).toBe('http://host.docker.internal:3001/mcp');
  });

  it('returns undefined when no HTTP servers exist', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
        },
      })
    );

    const result = await patchMcpConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when .mcp.json does not exist', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-patch-'));
    const result = await patchMcpConfig(tmpDir);
    expect(result).toBeUndefined();
  });

  it('writes to provided staging dir instead of worktree', async () => {
    const studioDir = mkdtempSync(join(tmpdir(), 'studio-'));
    const stagingDir = mkdtempSync(join(tmpdir(), 'staging-'));
    writeFileSync(
      join(studioDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
        },
      })
    );

    const result = await patchMcpConfig(studioDir, stagingDir);
    expect(result).toBeTruthy();
    // Patched file should be in staging dir, not studio dir
    expect(result!.startsWith(stagingDir)).toBe(true);
    expect(existsSync(join(studioDir, '.ink'))).toBe(false);
  });
});

describe('stageClaudeDir', () => {
  beforeEach(resetHome);

  it('stages the credentials file and settings from the home directory', async () => {
    writeHomeFile('.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"synthetic"}}');
    writeHomeFile('.claude/settings.json', '{"theme":"dark"}');
    const result = await stageClaudeDir(mkdtempSync(join(tmpdir(), 'cred-stage-')));
    expect(result).toContain('claude-home');
    expect(result!.startsWith(sandboxHost.root)).toBe(true);
    expect(readFileSync(join(result!, '.credentials.json'), 'utf-8')).toContain('synthetic');
    expect(readFileSync(join(result!, 'settings.json'), 'utf-8')).toBe('{"theme":"dark"}');
    expect(sandboxHost.keychainCalls).toBe(0);
  });

  it('falls back to the keychain only on macOS, and only through the stub', async () => {
    sandboxHost.keychain = '{"claudeAiOauth":{"accessToken":"from-keychain"}}';
    const result = await stageClaudeDir(mkdtempSync(join(tmpdir(), 'cred-stage-')));
    if (process.platform !== 'darwin') {
      expect(result).toBeUndefined();
      expect(sandboxHost.keychainCalls).toBe(0);
      return;
    }
    expect(sandboxHost.keychainCalls).toBe(1);
    const creds = JSON.parse(readFileSync(join(result!, '.credentials.json'), 'utf-8'));
    expect(creds.claudeAiOauth.accessToken).toBe('from-keychain');
  });

  it('returns undefined when neither a file nor a keychain entry exists', async () => {
    const result = await stageClaudeDir(mkdtempSync(join(tmpdir(), 'cred-stage-')));
    expect(result).toBeUndefined();
  });
});

describe('stageCodexDir', () => {
  beforeEach(resetHome);

  const codexConfig = [
    '[mcp_servers.inkwell]',
    'url = "http://localhost:3001/mcp"',
    '',
    '[projects."/Users/someone/ws/repo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  it('stages auth.json and installation_id when codex auth exists', async () => {
    writeHomeFile('.codex/auth.json', '{"tokens":{"access_token":"synthetic"}}');
    writeHomeFile('.codex/installation_id', 'install-123');
    const result = await stageCodexDir(mkdtempSync(join(tmpdir(), 'codex-stage-')));
    expect(result).toBeDefined();
    expect(result!.startsWith(sandboxHost.root)).toBe(true);
    const auth = JSON.parse(readFileSync(join(result!, 'auth.json'), 'utf-8'));
    expect(auth.tokens.access_token).toBe('synthetic');
    expect(readFileSync(join(result!, 'installation_id'), 'utf-8')).toBe('install-123');
  });

  it('rewrites loopback URLs, strips host projects and trusts /studio', async () => {
    writeHomeFile('.codex/auth.json', '{"tokens":{}}');
    writeHomeFile('.codex/config.toml', codexConfig);
    const result = await stageCodexDir(mkdtempSync(join(tmpdir(), 'codex-stage-')));
    const config = readFileSync(join(result!, 'config.toml'), 'utf-8');
    expect(config).not.toMatch(/url\s*=\s*"https?:\/\/localhost/);
    expect(config).toContain('host.docker.internal');
    expect(config).not.toContain('/Users/');
    expect(config).toContain('[projects."/studio"]');
    expect(config).toContain('trust_level = "trusted"');
  });

  it('returns undefined when auth.json does not exist', async () => {
    writeHomeFile('.codex/config.toml', codexConfig);
    const result = await stageCodexDir(mkdtempSync(join(tmpdir(), 'codex-no-auth-')));
    expect(result).toBeUndefined();
  });
});

describe('SandboxOrchestrator', () => {
  beforeEach(() => {
    vi.fn();
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
