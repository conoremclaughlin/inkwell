import { execSync } from 'child_process';
import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  buildDockerRunArgs,
  buildStudioSandboxPlan,
  parseExtraMount,
  resolveBackendAuthNames,
} from './studio-sandbox.js';

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git('init -b main', root);
  git('config user.email "test@example.com"', root);
  git('config user.name "Test User"', root);
  writeFileSync(join(root, 'README.md'), '# test\n', 'utf-8');
  git('add README.md', root);
  git('commit -m "init"', root);
  return git('rev-parse --show-toplevel', root);
}

describe('studio sandbox planning', () => {
  const tmpRoot = join(tmpdir(), `pcp-studio-sandbox-${Date.now()}`);

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('builds a studio-first mount plan with patched MCP config and worktree git support', () => {
    const repoRoot = initRepo(join(tmpRoot, 'repo'));
    const studioPath = join(tmpRoot, 'repo--alpha');
    git(`worktree add -b lumen/studio/alpha "${studioPath}"`, repoRoot);

    mkdirSync(join(studioPath, '.pcp'), { recursive: true });
    writeFileSync(
      join(studioPath, '.pcp', 'identity.json'),
      JSON.stringify(
        {
          agentId: 'lumen',
          studio: 'alpha',
          studioId: 'studio-alpha',
          branch: 'lumen/studio/alpha',
        },
        null,
        2
      ),
      'utf-8'
    );
    writeFileSync(
      join(studioPath, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            pcp: { type: 'http', url: 'http://localhost:3001/mcp' },
            supabase: { type: 'http', url: 'http://127.0.0.1:54321/mcp' },
            github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const plan = buildStudioSandboxPlan(studioPath);

    expect(plan.context.studioPath.endsWith(basename(studioPath))).toBe(true);
    expect(plan.context.canonicalRepoRoot.endsWith(basename(repoRoot))).toBe(true);
    expect(plan.studioAccess).toBe('rw');
    expect(plan.network).toBe('default');
    expect(plan.containerName).toContain('pcp-studio-sandbox-alpha-');
    expect(plan.env.PCP_SERVER_URL).toBe('http://host.docker.internal:3001');

    const activeStudioMount = plan.mounts.find((mount) => mount.target === '/studio');
    expect(activeStudioMount?.source.endsWith(basename(studioPath))).toBe(true);
    expect(activeStudioMount?.readOnly).toBe(false);

    const siblingMounts = plan.mounts.filter((mount) => mount.target.startsWith('/studios/'));
    expect(siblingMounts.map((mount) => mount.target)).toContain(`/studios/${basename(repoRoot)}`);
    expect(siblingMounts.map((mount) => mount.target)).toContain(
      `/studios/${basename(studioPath)}`
    );

    const gitMount = plan.mounts.find((mount) => mount.reason.includes('worktree .git indirection'));
    expect(gitMount?.source.endsWith(join(basename(repoRoot), '.git'))).toBe(true);
    expect(gitMount?.target.endsWith(join(basename(repoRoot), '.git'))).toBe(true);

    expect(plan.patchedMcpConfigPath).toBeTruthy();
    expect(existsSync(plan.patchedMcpConfigPath!)).toBe(true);
    const patched = JSON.parse(readFileSync(plan.patchedMcpConfigPath!, 'utf-8')) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(patched.mcpServers.pcp.url).toBe('http://host.docker.internal:3001/mcp');
    expect(patched.mcpServers.supabase.url).toBe('http://host.docker.internal:54321/mcp');
    expect(patched.mcpServers.github.url).toBe('https://api.githubcopilot.com/mcp/');

    const args = buildDockerRunArgs(plan, { command: ['bash', '-lc', 'pwd'] });
    expect(args).toContain('--add-host');
    expect(args).toContain('host.docker.internal:host-gateway');
    expect(args).not.toContain('--init');
    expect(args).toContain(plan.image);
    expect(args).toContain('bash');
    expect(args).toContain('/studio');
  });

  it('supports a stricter no-studio plan', () => {
    const repoRoot = initRepo(join(tmpRoot, 'repo-no-mounts'));
    const plan = buildStudioSandboxPlan(repoRoot, {
      studioAccess: 'none',
      includeSiblingStudios: false,
    });

    expect(plan.mounts).toEqual([]);
    expect(plan.studioAccess).toBe('none');
  });
});

describe('extra mount parsing', () => {
  it('parses ro/rw mounts', () => {
    const parsed = parseExtraMount(`${tmpdir()}:/host-tmp:ro`);
    expect(parsed.source).toBe(tmpdir());
    expect(parsed.target).toBe('/host-tmp');
    expect(parsed.readOnly).toBe(true);
  });

  it('rejects dangerous mount sources', () => {
    expect(() => parseExtraMount(`/etc:/host-etc:ro`)).toThrow(/dangerous mount source/i);
    expect(() => parseExtraMount(`${homedir()}:/host-home:rw`)).toThrow(/dangerous mount source/i);
  });
});

describe('backend auth selection', () => {
  it('expands the all alias and preserves uniqueness', () => {
    expect(resolveBackendAuthNames('all')).toEqual(['claude', 'codex', 'gemini']);
    expect(resolveBackendAuthNames('codex,codex,gemini')).toEqual(['codex', 'gemini']);
  });

  it('mounts backend auth directories read-only by default', () => {
    const repoRoot = initRepo(join(tmpdir(), `pcp-studio-sandbox-auth-${Date.now()}`, 'repo-auth'));
    const plan = buildStudioSandboxPlan(repoRoot, { backendAuth: ['codex'] });
    const authMount = plan.mounts.find((mount) => mount.reason === 'codex auth/config');
    expect(authMount?.readOnly).toBe(true);
  });
});
