/**
 * Workspace Command Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { planInit, getWorktreePaths, type InitResult } from './workspace.js';

type Move = InitResult['moves'][number];

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
      git(`worktree add -b wren/workspace/test "${worktreePath}"`, TEST_REPO);

      // Create .pcp identity like the CLI would
      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'wren',
        context: 'workspace-test',
        description: 'Test workspace',
        workspace: 'test',
        branch: 'wren/workspace/test',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      // Verify identity was created
      expect(existsSync(join(pcpDir, 'identity.json'))).toBe(true);

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('wren');
      expect(savedIdentity.workspace).toBe('test');
      expect(savedIdentity.branch).toBe('wren/workspace/test');
    });

    it('should support custom agent ID', () => {
      // New format: <repo-name>--<workspace-name>
      const worktreePath = join(TEST_DIR, 'test-repo--myra');
      git(`worktree add -b myra/workspace/myra "${worktreePath}"`, TEST_REPO);

      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'myra',
        context: 'workspace-myra',
        description: 'Myra workspace',
        workspace: 'myra',
        branch: 'myra/workspace/myra',
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

      git(`worktree add -b wren/workspace/${workspaceName} "${expectedPath}"`, TEST_REPO);

      expect(existsSync(expectedPath)).toBe(true);
    });

    it('should use agentId/workspace/ prefix for branches', () => {
      const workspaceName = 'bugfix-y';
      const branchName = `wren/workspace/${workspaceName}`;
      // New format: <repo-name>--<workspace-name>
      const worktreePath = join(TEST_DIR, `test-repo--${workspaceName}`);

      git(`worktree add -b "${branchName}" "${worktreePath}"`, TEST_REPO);

      const branches = git('branch', TEST_REPO);
      expect(branches).toContain(branchName);
    });
  });
});

describe('Workspace init', () => {
  // macOS resolves /var -> /private/var, so we need the real path
  let realTestDir: string;
  let realTestRepo: string;

  beforeEach(() => {
    mkdirSync(TEST_REPO, { recursive: true });
    git('init', TEST_REPO);
    git('config user.email "test@test.com"', TEST_REPO);
    git('config user.name "Test User"', TEST_REPO);
    writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
    git('add .', TEST_REPO);
    git('commit -m "Initial commit"', TEST_REPO);

    // Get the real resolved path (handles /var -> /private/var on macOS)
    realTestRepo = git('rev-parse --show-toplevel', TEST_REPO);
    realTestDir = join(realTestRepo, '..');
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('planInit', () => {
    it('should plan moving main repo into parent directory', () => {
      const result = planInit(realTestRepo, 'myproject');

      expect(result.parentDir).toBe(join(realTestDir, 'myproject'));
      expect(result.moves).toHaveLength(1);
      expect(result.moves[0].from).toBe(realTestRepo);
      expect(result.moves[0].to).toBe(join(realTestDir, 'myproject', 'test-repo'));
    });

    it('should include existing worktrees in the plan', () => {
      const wtPath = join(realTestDir, 'test-repo--myra');
      git(`worktree add -b myra/workspace/myra "${wtPath}"`, realTestRepo);

      const result = planInit(realTestRepo, 'pcp');

      expect(result.moves).toHaveLength(2);
      expect(result.moves[0].from).toBe(realTestRepo);
      expect(result.moves[1].from).toBe(wtPath);
      expect(result.moves[1].to).toBe(join(realTestDir, 'pcp', 'test-repo--myra'));
    });

    it('should ignore worktrees that do not follow naming convention', () => {
      // Create a worktree with a non-standard name
      const wtPath = join(realTestDir, 'unrelated-worktree');
      git(`worktree add -b feature/unrelated "${wtPath}"`, realTestRepo);

      const result = planInit(realTestRepo, 'pcp');

      // Should only have the main repo move, not the unrelated worktree
      expect(result.moves).toHaveLength(1);
      expect(result.moves[0].from).toBe(realTestRepo);
    });
  });

  describe('getWorktreePaths', () => {
    it('should return empty array when no worktrees exist', () => {
      const paths = getWorktreePaths(realTestRepo);
      expect(paths).toHaveLength(0);
    });

    it('should return worktree paths excluding main', () => {
      const wt1 = join(realTestDir, 'test-repo--alpha');
      const wt2 = join(realTestDir, 'test-repo--beta');
      git(`worktree add -b wren/workspace/alpha "${wt1}"`, realTestRepo);
      git(`worktree add -b wren/workspace/beta "${wt2}"`, realTestRepo);

      const paths = getWorktreePaths(realTestRepo);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(wt1);
      expect(paths).toContain(wt2);
    });
  });

  describe('full init workflow', () => {
    it('should move repo and worktrees into parent directory', () => {
      // Create a worktree
      const wtPath = join(realTestDir, 'test-repo--wren');
      git(`worktree add -b wren/workspace/wren "${wtPath}"`, realTestRepo);

      // Plan the init
      const { parentDir, moves } = planInit(realTestRepo, 'pcp');

      // Execute the moves (same logic as initWorkspace but without spinner/process.exit)
      mkdirSync(parentDir, { recursive: true });

      // Move worktrees first
      const worktreeMoves = moves.filter((m: Move) => m.from !== realTestRepo);
      for (const move of worktreeMoves) {
        renameSync(move.from, move.to);
      }

      // Move main repo
      const mainMove = moves.find((m: Move) => m.from === realTestRepo)!;
      renameSync(mainMove.from, mainMove.to);

      // Repair
      const newWtPaths = worktreeMoves.map((m: Move) => `"${m.to}"`).join(' ');
      git(`worktree repair ${newWtPaths}`, mainMove.to);

      // Verify old paths are gone
      expect(existsSync(realTestRepo)).toBe(false);
      expect(existsSync(wtPath)).toBe(false);

      // Verify new paths exist
      expect(existsSync(mainMove.to)).toBe(true);
      expect(existsSync(worktreeMoves[0].to)).toBe(true);

      // Verify git still works from new main location
      const branches = git('branch', mainMove.to);
      expect(branches).toContain('main');
      expect(branches).toContain('wren/workspace/wren');

      // Verify worktree list shows correct new paths
      const worktreeList = git('worktree list', mainMove.to);
      expect(worktreeList).toContain(mainMove.to);
      expect(worktreeList).toContain(worktreeMoves[0].to);
    });

    it('should handle repo with no worktrees', () => {
      const { parentDir, moves } = planInit(realTestRepo, 'solo');

      expect(moves).toHaveLength(1);

      // Execute
      mkdirSync(parentDir, { recursive: true });
      renameSync(moves[0].from, moves[0].to);

      // Verify
      expect(existsSync(realTestRepo)).toBe(false);
      expect(existsSync(moves[0].to)).toBe(true);

      const branches = git('branch', moves[0].to);
      expect(branches).toContain('main');
    });

    it('should handle multiple worktrees', () => {
      const wt1 = join(realTestDir, 'test-repo--alpha');
      const wt2 = join(realTestDir, 'test-repo--beta');
      const wt3 = join(realTestDir, 'test-repo--gamma');
      git(`worktree add -b wren/workspace/alpha "${wt1}"`, realTestRepo);
      git(`worktree add -b wren/workspace/beta "${wt2}"`, realTestRepo);
      git(`worktree add -b wren/workspace/gamma "${wt3}"`, realTestRepo);

      const { parentDir, moves } = planInit(realTestRepo, 'multi');

      // 1 main + 3 worktrees = 4 moves
      expect(moves).toHaveLength(4);

      // Execute
      mkdirSync(parentDir, { recursive: true });
      const worktreeMoves = moves.filter((m: Move) => m.from !== realTestRepo);
      for (const move of worktreeMoves) {
        renameSync(move.from, move.to);
      }
      const mainMove = moves.find((m: Move) => m.from === realTestRepo)!;
      renameSync(mainMove.from, mainMove.to);
      const newWtPaths = worktreeMoves.map((m: Move) => `"${m.to}"`).join(' ');
      git(`worktree repair ${newWtPaths}`, mainMove.to);

      // Verify all worktrees are accessible
      const worktreeList = git('worktree list', mainMove.to);
      expect(worktreeList).toContain(mainMove.to);
      for (const wm of worktreeMoves) {
        expect(worktreeList).toContain(wm.to);
      }
    });
  });
});
