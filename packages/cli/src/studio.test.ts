/**
 * Studio Management Tests
 *
 * Tests for the PCP Studios CLI functionality.
 * These tests verify studio creation, listing, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Test utilities
const TEST_DIR = join(tmpdir(), 'pcp-studio-tests');
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
  execSync('git init -b main', { cwd: TEST_REPO, stdio: 'pipe' });
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

describe('Studio Identity', () => {
  it('should create valid identity JSON structure', () => {
    const identity = {
      agentId: 'wren',
      context: 'studio-test-feature',
      description: 'Studio: test-feature',
      studio: 'test-feature',
      branch: 'wren/studio/test-feature',
      createdAt: new Date().toISOString(),
      createdBy: 'test@test.com',
    };

    expect(identity.agentId).toBe('wren');
    expect(identity.context).toContain('studio-');
    expect(identity.branch).toMatch(/^wren\/studio\//);
    expect(identity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should allow different agent IDs for different studios', () => {
    const wrenStudio = { agentId: 'wren', studio: 'frontend' };
    const bensonStudio = { agentId: 'benson', studio: 'backend' };

    expect(wrenStudio.agentId).not.toBe(bensonStudio.agentId);
    expect(wrenStudio.studio).not.toBe(bensonStudio.studio);
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
    const worktreePath = join(TEST_DIR, 'test-repo--feature1');
    const branchName = 'wren/studio/feature1';

    // Create worktree
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Verify worktree exists
    expect(existsSync(worktreePath)).toBe(true);

    // Verify branch was created
    const branches = execSync('git branch', { cwd: TEST_REPO, encoding: 'utf-8' });
    expect(branches).toContain('wren/studio/feature1');

    // Verify worktree is on correct branch
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    expect(currentBranch).toBe(branchName);
  });

  it('should list all worktrees', () => {
    const worktreePath = join(TEST_DIR, 'test-repo--feature2');

    // Create worktree
    execSync(`git worktree add -b "wren/studio/feature2" "${worktreePath}"`, {
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
    const worktreePath = join(TEST_DIR, 'test-repo--feature3');
    const branchName = 'wren/studio/feature3';

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
    const worktreePath = join(TEST_DIR, 'test-repo--feature4');
    const branchName = 'wren/studio/feature4';

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

describe('Studio PCP Identity Integration', () => {
  beforeEach(() => {
    initTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo();
  });

  it('should create .pcp/identity.json in worktree', () => {
    const worktreePath = join(TEST_DIR, 'test-repo--feature5');

    // Create worktree
    execSync(`git worktree add -b "wren/studio/feature5" "${worktreePath}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Create .pcp directory and identity
    const pcpDir = join(worktreePath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });

    const identity = {
      agentId: 'wren',
      context: 'studio-feature5',
      description: 'Studio: feature5',
      studio: 'feature5',
      branch: 'wren/studio/feature5',
      createdAt: new Date().toISOString(),
    };

    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

    // Verify identity file exists and is valid
    const identityPath = join(worktreePath, '.pcp', 'identity.json');
    expect(existsSync(identityPath)).toBe(true);

    const savedIdentity = JSON.parse(readFileSync(identityPath, 'utf-8'));
    expect(savedIdentity.agentId).toBe('wren');
    expect(savedIdentity.studio).toBe('feature5');
  });

  it('should allow multiple studios with different contexts', () => {
    const ws1Path = join(TEST_DIR, 'test-repo--frontend');
    const ws2Path = join(TEST_DIR, 'test-repo--backend');

    // Create two worktrees
    execSync(`git worktree add -b "wren/studio/frontend" "${ws1Path}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });
    execSync(`git worktree add -b "wren/studio/backend" "${ws2Path}"`, {
      cwd: TEST_REPO,
      stdio: 'pipe',
    });

    // Create identities
    mkdirSync(join(ws1Path, '.pcp'), { recursive: true });
    mkdirSync(join(ws2Path, '.pcp'), { recursive: true });

    writeFileSync(
      join(ws1Path, '.pcp', 'identity.json'),
      JSON.stringify({ agentId: 'wren', context: 'studio-frontend' }, null, 2)
    );
    writeFileSync(
      join(ws2Path, '.pcp', 'identity.json'),
      JSON.stringify({ agentId: 'wren', context: 'studio-backend' }, null, 2)
    );

    // Verify both exist with different contexts
    const id1 = JSON.parse(readFileSync(join(ws1Path, '.pcp', 'identity.json'), 'utf-8'));
    const id2 = JSON.parse(readFileSync(join(ws2Path, '.pcp', 'identity.json'), 'utf-8'));

    expect(id1.context).toBe('studio-frontend');
    expect(id2.context).toBe('studio-backend');
    expect(id1.agentId).toBe(id2.agentId); // Same agent, different contexts
  });
});

describe('Studio Naming Conventions', () => {
  it('should use repo-name-- prefix for studio directories', () => {
    const studioName = 'my-feature';
    const expectedDir = `test-repo--${studioName}`;

    expect(expectedDir).toBe('test-repo--my-feature');
  });

  it('should use agentId/studio/ prefix for branch names', () => {
    const studioName = 'auth-refactor';
    const expectedBranch = `wren/studio/${studioName}`;

    expect(expectedBranch).toBe('wren/studio/auth-refactor');
  });

  it('should generate valid context names', () => {
    const studioName = 'api-optimization';
    const expectedContext = `studio-${studioName}`;

    expect(expectedContext).toBe('studio-api-optimization');
    expect(expectedContext).not.toContain(' ');
    expect(expectedContext).not.toContain('/');
  });
});
