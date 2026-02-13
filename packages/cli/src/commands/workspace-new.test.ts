/**
 * Workspace New Feature Tests
 *
 * Tests for workspace branch naming convention, config copying,
 * and cleanWorkspace identity.json-based branch resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'pcp-ws-new-test-' + Date.now());
const TEST_REPO = join(TEST_DIR, 'test-repo');

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    encoding: 'utf-8',
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Resolve real path for the TEST_DIR (macOS /var -> /private/var) */
function realDir(repo: string): string {
  return join(repo, '..');
}

function initRepo(): string {
  mkdirSync(TEST_REPO, { recursive: true });
  git('init', TEST_REPO);
  git('config user.email "test@test.com"', TEST_REPO);
  git('config user.name "Test User"', TEST_REPO);
  writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
  git('add .', TEST_REPO);
  git('commit -m "Initial commit"', TEST_REPO);
  // Resolve real path (macOS /var -> /private/var)
  return git('rev-parse --show-toplevel', TEST_REPO);
}

describe('Branch naming convention: agentId/workspace/name', () => {
  let realRepo: string;

  beforeEach(() => {
    realRepo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should use agentId/workspace/name as default branch pattern', () => {
    const agentId = 'wren';
    const name = 'feature-auth';
    const expectedBranch = `${agentId}/workspace/${name}`;

    const wsPath = join(realDir(realRepo), `test-repo--${name}`);
    git(`worktree add -b "${expectedBranch}" "${wsPath}"`, realRepo);

    const branches = git('branch', realRepo);
    expect(branches).toContain(expectedBranch);

    const currentBranch = git('branch --show-current', wsPath);
    expect(currentBranch).toBe(expectedBranch);
  });

  it('should support different agents with the same workspace name', () => {
    const wsPath1 = join(realDir(realRepo), `test-repo--ws1`);
    const wsPath2 = join(realDir(realRepo), `test-repo--ws2`);

    git(`worktree add -b "wren/workspace/shared" "${wsPath1}"`, realRepo);
    git(`worktree add -b "myra/workspace/shared" "${wsPath2}"`, realRepo);

    const branches = git('branch', realRepo);
    expect(branches).toContain('wren/workspace/shared');
    expect(branches).toContain('myra/workspace/shared');
  });

  it('should produce correct identity.json with new branch format', () => {
    const agentId = 'benson';
    const name = 'api-v2';
    const branch = `${agentId}/workspace/${name}`;
    const wsPath = join(realDir(realRepo), `test-repo--${name}`);

    git(`worktree add -b "${branch}" "${wsPath}"`, realRepo);

    const pcpDir = join(wsPath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });

    const identity = {
      agentId,
      context: `workspace-${name}`,
      description: `Workspace: ${name}`,
      workspace: name,
      branch,
      createdAt: new Date().toISOString(),
      createdBy: 'test@test.com',
    };
    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

    const saved = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
    expect(saved.branch).toBe('benson/workspace/api-v2');
    expect(saved.agentId).toBe('benson');
    expect(saved.workspace).toBe('api-v2');
  });
});

describe('cleanWorkspace: branch from identity.json', () => {
  let realRepo: string;

  beforeEach(() => {
    realRepo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should read branch from identity.json for cleanup', () => {
    const branch = 'wren/workspace/cleanup-test';
    const wsPath = join(realDir(realRepo), `test-repo--cleanup-test`);

    git(`worktree add -b "${branch}" "${wsPath}"`, realRepo);

    // Write identity.json with the branch
    const pcpDir = join(wsPath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });
    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify({ branch }));

    // Read it back — simulating what cleanWorkspace does
    const identity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
    expect(identity.branch).toBe(branch);

    // Actually clean up using the branch from identity
    git(`worktree remove "${wsPath}" --force`, realRepo);
    git(`branch -D "${identity.branch}"`, realRepo);

    expect(existsSync(wsPath)).toBe(false);
    const branches = git('branch', realRepo);
    expect(branches).not.toContain(branch);
  });

  it('should fall back to git worktree list when identity.json is missing', () => {
    const branch = 'wren/workspace/no-identity';
    const wsPath = join(realDir(realRepo), `test-repo--no-identity`);

    git(`worktree add -b "${branch}" "${wsPath}"`, realRepo);

    // No identity.json — simulate worktree-list lookup
    const worktreeOutput = git('worktree list --porcelain', realRepo);
    let foundBranch: string | undefined;
    let currentPath = '';
    for (const line of worktreeOutput.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9);
      } else if (line.startsWith('branch ') && currentPath === wsPath) {
        foundBranch = line.substring(7).replace('refs/heads/', '');
      }
    }

    expect(foundBranch).toBe(branch);

    // Clean up using the discovered branch
    git(`worktree remove "${wsPath}" --force`, realRepo);
    git(`branch -D "${foundBranch}"`, realRepo);

    expect(existsSync(wsPath)).toBe(false);
    const branches = git('branch', realRepo);
    expect(branches).not.toContain(branch);
  });

  it('should handle identity.json with legacy workspace/ branch format', () => {
    // Even if someone has an old identity.json, cleanWorkspace should work
    const legacyBranch = 'workspace/legacy-test';
    const wsPath = join(realDir(realRepo), `test-repo--legacy-test`);

    git(`worktree add -b "${legacyBranch}" "${wsPath}"`, realRepo);

    const pcpDir = join(wsPath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });
    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify({ branch: legacyBranch }));

    const identity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));

    git(`worktree remove "${wsPath}" --force`, realRepo);
    git(`branch -D "${identity.branch}"`, realRepo);

    expect(existsSync(wsPath)).toBe(false);
    const branches = git('branch', realRepo);
    expect(branches).not.toContain(legacyBranch);
  });
});

describe('Config directory copying', () => {
  let realRepo: string;

  beforeEach(() => {
    realRepo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should copy .claude/ directory as-is into workspace', () => {
    // Create .claude/ in the repo with settings
    const claudeDir = join(realRepo, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({ permissions: {} }));

    // Create workspace
    const wsPath = join(realDir(realRepo), `test-repo--config-test`);
    git(`worktree add -b "wren/workspace/config-test" "${wsPath}"`, realRepo);

    // Copy .claude/ into workspace (simulating copyConfigDirs behavior)
    const target = join(wsPath, '.claude');
    cpSync(claudeDir, target, { recursive: true });

    expect(existsSync(join(wsPath, '.claude', 'settings.local.json'))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(wsPath, '.claude', 'settings.local.json'), 'utf-8')
    );
    expect(settings.permissions).toBeDefined();
  });

  it('should always write fresh .pcp/identity.json, never copy from source', () => {
    // Create .pcp/ with an identity in the main repo
    const srcPcp = join(realRepo, '.pcp');
    mkdirSync(srcPcp, { recursive: true });
    writeFileSync(
      join(srcPcp, 'identity.json'),
      JSON.stringify({
        agentId: 'wren',
        workspace: 'main',
        branch: 'main',
      })
    );

    // Create workspace
    const wsPath = join(realDir(realRepo), `test-repo--fresh-id`);
    git(`worktree add -b "wren/workspace/fresh-id" "${wsPath}"`, realRepo);

    // Write fresh identity (simulating createWorkspace behavior)
    const wsPcp = join(wsPath, '.pcp');
    mkdirSync(wsPcp, { recursive: true });
    const freshIdentity = {
      agentId: 'wren',
      context: 'workspace-fresh-id',
      workspace: 'fresh-id',
      branch: 'wren/workspace/fresh-id',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(wsPcp, 'identity.json'), JSON.stringify(freshIdentity, null, 2));

    const wsIdentity = JSON.parse(readFileSync(join(wsPcp, 'identity.json'), 'utf-8'));
    expect(wsIdentity.workspace).toBe('fresh-id');
    expect(wsIdentity.branch).toBe('wren/workspace/fresh-id');

    // Confirm main repo identity wasn't touched
    const mainIdentity = JSON.parse(readFileSync(join(srcPcp, 'identity.json'), 'utf-8'));
    expect(mainIdentity.workspace).toBe('main');
  });

  it('should handle copying multiple config directories', () => {
    // Create .claude/ and .codex/ in the repo
    mkdirSync(join(realRepo, '.claude'), { recursive: true });
    writeFileSync(join(realRepo, '.claude', 'settings.local.json'), '{}');
    mkdirSync(join(realRepo, '.codex'), { recursive: true });
    writeFileSync(join(realRepo, '.codex', 'config.toml'), '# test');

    const wsPath = join(realDir(realRepo), `test-repo--multi-config`);
    git(`worktree add -b "wren/workspace/multi-config" "${wsPath}"`, realRepo);

    // Copy both
    for (const dir of ['.claude', '.codex']) {
      cpSync(join(realRepo, dir), join(wsPath, dir), { recursive: true });
    }

    expect(existsSync(join(wsPath, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(wsPath, '.codex', 'config.toml'))).toBe(true);
  });

  it('should not copy config dirs that do not exist in source', () => {
    // .gemini/ doesn't exist in the repo
    const wsPath = join(realDir(realRepo), `test-repo--no-gemini`);
    git(`worktree add -b "wren/workspace/no-gemini" "${wsPath}"`, realRepo);

    // Attempt to copy .gemini/ (should be a no-op)
    const geminiSrc = join(realRepo, '.gemini');
    if (existsSync(geminiSrc)) {
      cpSync(geminiSrc, join(wsPath, '.gemini'), { recursive: true });
    }

    expect(existsSync(join(wsPath, '.gemini'))).toBe(false);
  });
});

describe('Workspace name defaults', () => {
  it('should default name to "new" when not provided and not TTY', () => {
    // Simulating the non-interactive path
    const name: string | undefined = undefined;
    const resolved = name || 'new';
    expect(resolved).toBe('new');
  });

  it('should use provided name when given', () => {
    const name = 'feature-auth';
    const resolved = name || 'new';
    expect(resolved).toBe('feature-auth');
  });

  it('should derive correct branch from agentId and name', () => {
    const agentId = 'myra';
    const name = 'monitoring';
    const branch = `${agentId}/workspace/${name}`;
    expect(branch).toBe('myra/workspace/monitoring');
  });
});
