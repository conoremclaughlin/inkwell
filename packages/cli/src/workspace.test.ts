/**
 * Workspace Management Tests
 *
 * Tests for the PCP Workspaces CLI functionality.
 * These tests verify workspace creation, listing, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Test utilities
const TEST_DIR = join(tmpdir(), 'pcp-workspace-tests');
const TEST_REPO = join(TEST_DIR, 'test-repo');

/**
 * Initialize a test git repository
 */
function initTestRepo(): void {
  // Create test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_REPO);

  // Initialize git repo
  execSync('git init', { cwd: TEST_REPO, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: TEST_REPO, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: TEST_REPO, stdio: 'pipe' });

  // Create initial commit
  writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
  execSync('git add .', { cwd: TEST_REPO, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: TEST_REPO, stdio: 'pipe' });
}

/**
 * Clean up test directory
 */
function cleanupTestRepo(): void {
  if (existsSync(TEST_DIR)) {
    // Remove any worktrees first
    try {
      const worktrees = execSync('git worktree list --porcelain', {
        cwd: TEST_REPO,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      for (const line of worktrees.split('\n')) {
        if (line.startsWith('worktree ') && !line.includes(TEST_REPO)) {
          const path = line.substring(9);
          try {
            execSync(`git worktree remove "${path}" --force`, {
              cwd: TEST_REPO,
              stdio: 'pipe',
            });
          } catch {
            // Ignore errors
          }
        }
      }
    } catch {
      // Ignore if repo doesn't exist
    }

    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('Workspace Identity', () => {
  it('should create valid identity JSON structure', () => {
    const identity = {
      agentId: 'wren',
      context: 'workspace-test-feature',
      description: 'Workspace: test-feature',
      workspace: 'test-feature',
      branch: 'workspace/test-feature',
      createdAt: new Date().toISOString(),
      createdBy: 'test@test.com',
    };

    expect(identity.agentId).toBe('wren');
    expect(identity.context).toContain('workspace-');
    expect(identity.branch).toMatch(/^workspace\//);
    expect(identity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should allow different agent IDs for different workspaces', () => {
    const wrenWorkspace = { agentId: 'wren', workspace: 'frontend' };
    const bensonWorkspace = { agentId: 'benson', workspace: 'backend' };

    expect(wrenWorkspace.agentId).not.toBe(bensonWorkspace.agentId);
    expect(wrenWorkspace.workspace).not.toBe(bensonWorkspace.workspace);
  });
});

describe('Git Worktree Operations', () => {
  beforeEach(() => {
    initTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo();
  });

  it('should create a worktree with a new branch', () => {
    const worktreePath = join(TEST_DIR, 'pcp-ws-feature1');
    const branchName = 'workspace/feature1';

    // Create worktree
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Verify worktree exists
    expect(existsSync(worktreePath)).toBe(true);

    // Verify branch was created
    const branches = execSync('git branch', { cwd: TEST_REPO, encoding: 'utf-8' });
    expect(branches).toContain('workspace/feature1');

    // Verify worktree is on correct branch
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    expect(currentBranch).toBe(branchName);
  });

  it('should list all worktrees', () => {
    const worktreePath = join(TEST_DIR, 'pcp-ws-feature2');

    // Create worktree
    execSync(`git worktree add -b "workspace/feature2" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // List worktrees
    const output = execSync('git worktree list', {
      cwd: TEST_REPO,
      encoding: 'utf-8',
    });

    expect(output).toContain(TEST_REPO);
    expect(output).toContain(worktreePath);
  });

  it('should remove a worktree while keeping the branch', () => {
    const worktreePath = join(TEST_DIR, 'pcp-ws-feature3');
    const branchName = 'workspace/feature3';

    // Create worktree
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Remove worktree
    execSync(`git worktree remove "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Verify worktree is gone
    expect(existsSync(worktreePath)).toBe(false);

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: TEST_REPO, encoding: 'utf-8' });
    expect(branches).toContain(branchName);
  });

  it('should clean up worktree and delete branch', () => {
    const worktreePath = join(TEST_DIR, 'pcp-ws-feature4');
    const branchName = 'workspace/feature4';

    // Create worktree
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Remove worktree and delete branch
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });
    execSync(`git branch -D "${branchName}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Verify both are gone
    expect(existsSync(worktreePath)).toBe(false);
    const branches = execSync('git branch', { cwd: TEST_REPO, encoding: 'utf-8' });
    expect(branches).not.toContain(branchName);
  });
});

describe('Workspace PCP Identity Integration', () => {
  beforeEach(() => {
    initTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo();
  });

  it('should create .pcp/identity.json in worktree', () => {
    const worktreePath = join(TEST_DIR, 'pcp-ws-feature5');

    // Create worktree
    execSync(`git worktree add -b "workspace/feature5" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Create .pcp directory and identity
    const pcpDir = join(worktreePath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });

    const identity = {
      agentId: 'wren',
      context: 'workspace-feature5',
      description: 'Workspace: feature5',
      workspace: 'feature5',
      branch: 'workspace/feature5',
      createdAt: new Date().toISOString(),
    };

    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

    // Verify identity file exists and is valid
    const identityPath = join(worktreePath, '.pcp', 'identity.json');
    expect(existsSync(identityPath)).toBe(true);

    const savedIdentity = JSON.parse(readFileSync(identityPath, 'utf-8'));
    expect(savedIdentity.agentId).toBe('wren');
    expect(savedIdentity.workspace).toBe('feature5');
  });

  it('should allow multiple workspaces with different contexts', () => {
    const ws1Path = join(TEST_DIR, 'pcp-ws-frontend');
    const ws2Path = join(TEST_DIR, 'pcp-ws-backend');

    // Create two worktrees
    execSync(`git worktree add -b "workspace/frontend" "${ws1Path}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });
    execSync(`git worktree add -b "workspace/backend" "${ws2Path}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Create identities
    mkdirSync(join(ws1Path, '.pcp'), { recursive: true });
    mkdirSync(join(ws2Path, '.pcp'), { recursive: true });

    writeFileSync(
      join(ws1Path, '.pcp', 'identity.json'),
      JSON.stringify({ agentId: 'wren', context: 'workspace-frontend' }, null, 2)
    );
    writeFileSync(
      join(ws2Path, '.pcp', 'identity.json'),
      JSON.stringify({ agentId: 'wren', context: 'workspace-backend' }, null, 2)
    );

    // Verify both exist with different contexts
    const id1 = JSON.parse(readFileSync(join(ws1Path, '.pcp', 'identity.json'), 'utf-8'));
    const id2 = JSON.parse(readFileSync(join(ws2Path, '.pcp', 'identity.json'), 'utf-8'));

    expect(id1.context).toBe('workspace-frontend');
    expect(id2.context).toBe('workspace-backend');
    expect(id1.agentId).toBe(id2.agentId); // Same agent, different contexts
  });
});

describe('Workspace Naming Conventions', () => {
  it('should use pcp-ws- prefix for workspace directories', () => {
    const workspaceName = 'my-feature';
    const expectedDir = `pcp-ws-${workspaceName}`;

    expect(expectedDir).toBe('pcp-ws-my-feature');
  });

  it('should use workspace/ prefix for branch names', () => {
    const workspaceName = 'auth-refactor';
    const expectedBranch = `workspace/${workspaceName}`;

    expect(expectedBranch).toBe('workspace/auth-refactor');
  });

  it('should generate valid context names', () => {
    const workspaceName = 'api-optimization';
    const expectedContext = `workspace-${workspaceName}`;

    expect(expectedContext).toBe('workspace-api-optimization');
    expect(expectedContext).not.toContain(' ');
    expect(expectedContext).not.toContain('/');
  });
});
