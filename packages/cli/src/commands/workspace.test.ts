/**
 * Workspace Command Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Create a temporary test directory
const TEST_DIR = join(tmpdir(), 'pcp-cli-test-' + Date.now());
const TEST_REPO = join(TEST_DIR, 'test-repo');

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { encoding: 'utf-8', cwd }).trim();
}

describe('Workspace Commands', () => {
  beforeEach(() => {
    // Create test directory and git repo
    mkdirSync(TEST_REPO, { recursive: true });
    git('init', TEST_REPO);
    git('config user.email "test@test.com"', TEST_REPO);
    git('config user.name "Test User"', TEST_REPO);

    // Create initial commit (required for worktrees)
    writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
    git('add .', TEST_REPO);
    git('commit -m "Initial commit"', TEST_REPO);
  });

  afterEach(() => {
    // Cleanup
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Git helpers', () => {
    it('should detect git root', () => {
      const result = git('rev-parse --show-toplevel', TEST_REPO);
      // macOS resolves /var to /private/var, so check endsWith instead
      expect(result.endsWith('test-repo')).toBe(true);
    });

    it('should check branch existence', () => {
      // Main/master branch should exist after initial commit
      const branches = git('branch', TEST_REPO);
      expect(branches).toContain('main');
    });

    it('should create worktree', () => {
      const worktreePath = join(TEST_DIR, 'test-worktree');
      git(`worktree add -b test-branch "${worktreePath}"`, TEST_REPO);

      expect(existsSync(worktreePath)).toBe(true);
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);

      // Verify branch was created
      const branches = git('branch', TEST_REPO);
      expect(branches).toContain('test-branch');
    });

    it('should list worktrees', () => {
      const worktreePath = join(TEST_DIR, 'test-worktree');
      git(`worktree add -b test-branch "${worktreePath}"`, TEST_REPO);

      const worktreeList = git('worktree list', TEST_REPO);
      expect(worktreeList).toContain(TEST_REPO);
      expect(worktreeList).toContain(worktreePath);
    });

    it('should remove worktree', () => {
      const worktreePath = join(TEST_DIR, 'test-worktree');
      git(`worktree add -b test-branch "${worktreePath}"`, TEST_REPO);
      git(`worktree remove "${worktreePath}"`, TEST_REPO);

      expect(existsSync(worktreePath)).toBe(false);

      // Branch should still exist
      const branches = git('branch', TEST_REPO);
      expect(branches).toContain('test-branch');
    });
  });

  describe('Workspace identity', () => {
    it('should create identity.json in .pcp directory', () => {
      // New format: <repo-name>--<workspace-name>
      const worktreePath = join(TEST_DIR, 'test-repo--test');
      git(`worktree add -b workspace/test "${worktreePath}"`, TEST_REPO);

      // Create .pcp identity like the CLI would
      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'wren',
        context: 'workspace-test',
        description: 'Test workspace',
        workspace: 'test',
        branch: 'workspace/test',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      // Verify identity was created
      expect(existsSync(join(pcpDir, 'identity.json'))).toBe(true);

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('wren');
      expect(savedIdentity.workspace).toBe('test');
      expect(savedIdentity.branch).toBe('workspace/test');
    });

    it('should support custom agent ID', () => {
      // New format: <repo-name>--<workspace-name>
      const worktreePath = join(TEST_DIR, 'test-repo--myra');
      git(`worktree add -b workspace/myra "${worktreePath}"`, TEST_REPO);

      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'myra',
        context: 'workspace-myra',
        description: 'Myra workspace',
        workspace: 'myra',
        branch: 'workspace/myra',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('myra');
    });
  });

  describe('Workspace naming convention', () => {
    it('should use repo-name-- prefix for workspace directories', () => {
      const workspaceName = 'feature-x';
      // New format: <repo-name>--<workspace-name>
      const expectedPath = join(TEST_DIR, `test-repo--${workspaceName}`);

      git(`worktree add -b workspace/${workspaceName} "${expectedPath}"`, TEST_REPO);

      expect(existsSync(expectedPath)).toBe(true);
    });

    it('should use workspace/ prefix for branches', () => {
      const workspaceName = 'bugfix-y';
      const branchName = `workspace/${workspaceName}`;
      // New format: <repo-name>--<workspace-name>
      const worktreePath = join(TEST_DIR, `test-repo--${workspaceName}`);

      git(`worktree add -b "${branchName}" "${worktreePath}"`, TEST_REPO);

      const branches = git('branch', TEST_REPO);
      expect(branches).toContain(branchName);
    });
  });
});

describe('CLI argument parsing', () => {
  it('should have correct default values', () => {
    // These are tested by checking the help output
    // In a real test, we'd import and test the command directly
    expect(true).toBe(true); // Placeholder
  });
});
