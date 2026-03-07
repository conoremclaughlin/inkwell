/**
 * Studio Command Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  renameSync,
  lstatSync,
  symlinkSync,
  mkdtempSync,
} from 'fs';
import { join, basename, delimiter as pathDelimiter } from 'path';
import { tmpdir } from 'os';
import {
  planInit,
  getWorktreePaths,
  getWorktreeBranchMap,
  removeStudioWorktreeOrFolder,
  removeExistingLink,
  listStudios,
  getStudioPrefix,
  resolveCopySourceRoot,
  updateIdentityForStudioRename,
  getCliLinkTargets,
  shouldWarnMissingCliBinPath,
  resolveRoleTemplate,
  listRoleTemplates,
  isValidTemplateName,
  BUILTIN_ROLE_TEMPLATES,
  getDefaultStudioMainBranch,
  planStudioHomeBranchRename,
  slugifyStudioNameForBranch,
  type InitResult,
} from './studio.js';

type Move = InitResult['moves'][number];

// Create a temporary test directory
const TEST_DIR = join(tmpdir(), 'pcp-cli-test-' + Date.now());
const TEST_REPO = join(TEST_DIR, 'test-repo');

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { encoding: 'utf-8', cwd }).trim();
}

describe('Studio Commands', () => {
  beforeEach(() => {
    // Create test directory and git repo
    mkdirSync(TEST_REPO, { recursive: true });
    git('init -b main', TEST_REPO);
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

    it('should ignore stale prefixed folders in studio list', () => {
      const realRepo = git('rev-parse --show-toplevel', TEST_REPO);
      const parent = join(realRepo, '..');

      const validName = 'active';
      const validPath = join(parent, `test-repo--${validName}`);
      git(`worktree add -b wren/studio/${validName} "${validPath}"`, realRepo);

      // Simulate stale folder left behind by rename/remove mismatch.
      const stalePath = join(parent, 'test-repo--stale');
      mkdirSync(stalePath, { recursive: true });

      const studios = listStudios(realRepo);
      const names = studios.map((s) => s.name);

      expect(names).toContain(validName);
      expect(names).not.toContain('stale');
    });

    it('removes stale non-worktree folders without throwing', () => {
      const realRepo = git('rev-parse --show-toplevel', TEST_REPO);
      const parent = join(realRepo, '..');
      const stalePath = join(parent, 'test-repo--stale');
      mkdirSync(stalePath, { recursive: true });

      const removedKind = removeStudioWorktreeOrFolder(realRepo, stalePath, true);
      expect(removedKind).toBe('folder');
      expect(existsSync(stalePath)).toBe(false);
    });

    it('removes registered worktrees via git worktree remove', () => {
      const realRepo = git('rev-parse --show-toplevel', TEST_REPO);
      const parent = join(realRepo, '..');
      const wtPath = join(parent, 'test-repo--remove-me');
      git(`worktree add -b wren/studio/remove-me "${wtPath}"`, realRepo);

      const before = getWorktreeBranchMap(realRepo);
      expect(before.has(wtPath)).toBe(true);

      const removedKind = removeStudioWorktreeOrFolder(realRepo, wtPath, true);
      expect(removedKind).toBe('worktree');
      expect(existsSync(wtPath)).toBe(false);

      const after = getWorktreeBranchMap(realRepo);
      expect(after.has(wtPath)).toBe(false);
    });

    it('treats detached HEAD worktrees as registered and removes via git', () => {
      const realRepo = git('rev-parse --show-toplevel', TEST_REPO);
      const parent = join(realRepo, '..');
      const wtPath = join(parent, 'test-repo--detached');
      git(`worktree add -b wren/studio/detached "${wtPath}"`, realRepo);
      git('checkout --detach', wtPath);

      const before = getWorktreeBranchMap(realRepo);
      expect(before.get(wtPath)).toBe('(detached)');

      const removedKind = removeStudioWorktreeOrFolder(realRepo, wtPath, true);
      expect(removedKind).toBe('worktree');
      expect(existsSync(wtPath)).toBe(false);

      const after = getWorktreeBranchMap(realRepo);
      expect(after.has(wtPath)).toBe(false);
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

  describe('Studio identity', () => {
    it('should create identity.json in .pcp directory', () => {
      const worktreePath = join(TEST_DIR, 'test-repo--test');
      git(`worktree add -b wren/studio/test "${worktreePath}"`, TEST_REPO);

      // Create .pcp identity like the CLI would
      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'wren',
        context: 'studio-test',
        description: 'Test studio',
        studio: 'test',
        branch: 'wren/studio/test',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      // Verify identity was created
      expect(existsSync(join(pcpDir, 'identity.json'))).toBe(true);

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('wren');
      expect(savedIdentity.studio).toBe('test');
      expect(savedIdentity.branch).toBe('wren/studio/test');
    });

    it('should support custom agent ID', () => {
      const worktreePath = join(TEST_DIR, 'test-repo--myra');
      git(`worktree add -b myra/studio/myra "${worktreePath}"`, TEST_REPO);

      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      const identity = {
        agentId: 'myra',
        context: 'studio-myra',
        description: 'Myra studio',
        studio: 'myra',
        branch: 'myra/studio/myra',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('myra');
    });

    it('should read legacy identity.json with workspace field', () => {
      const worktreePath = join(TEST_DIR, 'test-repo--legacy');
      git(`worktree add -b wren/workspace/legacy "${worktreePath}"`, TEST_REPO);

      const pcpDir = join(worktreePath, '.pcp');
      mkdirSync(pcpDir, { recursive: true });

      // Old format with workspace field
      const identity = {
        agentId: 'wren',
        context: 'workspace-legacy',
        description: 'Legacy workspace',
        workspace: 'legacy',
        branch: 'wren/workspace/legacy',
        createdAt: new Date().toISOString(),
      };

      writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

      const savedIdentity = JSON.parse(readFileSync(join(pcpDir, 'identity.json'), 'utf-8'));
      expect(savedIdentity.agentId).toBe('wren');
      expect(savedIdentity.workspace).toBe('legacy');
    });
  });

  describe('Studio naming convention', () => {
    it('should use repo-name-- prefix for studio directories', () => {
      const studioName = 'feature-x';
      const expectedPath = join(TEST_DIR, `test-repo--${studioName}`);

      git(`worktree add -b wren/studio/${studioName} "${expectedPath}"`, TEST_REPO);

      expect(existsSync(expectedPath)).toBe(true);
    });

    it('should use agentId/studio/ prefix for branches', () => {
      const studioName = 'bugfix-y';
      const branchName = `wren/studio/${studioName}`;
      const worktreePath = join(TEST_DIR, `test-repo--${studioName}`);

      git(`worktree add -b "${branchName}" "${worktreePath}"`, TEST_REPO);

      const branches = git('branch', TEST_REPO);
      expect(branches).toContain(branchName);
    });
  });
});

describe('Studio default branch naming', () => {
  it('builds per-studio main branch names to avoid worktree branch collisions', () => {
    expect(getDefaultStudioMainBranch('lumen', 'review')).toBe('lumen/studio/main-review');
    expect(getDefaultStudioMainBranch('wren', 'my-feature')).toBe('wren/studio/main-my-feature');
  });

  it('slugifies studio names for safe branch suffixes', () => {
    expect(slugifyStudioNameForBranch('  API Review  ')).toBe('api-review');
    expect(slugifyStudioNameForBranch('ux/polish')).toBe('ux-polish');
    expect(slugifyStudioNameForBranch('***')).toBe('studio');
  });
});

describe('CLI link path helpers', () => {
  it('should resolve ~/.pcp/bin as primary and ~/.local/bin as compatibility path', () => {
    const targets = getCliLinkTargets('/tmp/home', 'sb-lumen');
    expect(targets.primaryBinDir).toBe('/tmp/home/.pcp/bin');
    expect(targets.compatBinDir).toBe('/tmp/home/.local/bin');
    expect(targets.primaryLinkPath).toBe('/tmp/home/.pcp/bin/sb-lumen');
    expect(targets.compatLinkPath).toBe('/tmp/home/.local/bin/sb-lumen');
  });

  it('should not warn when PATH includes primary bin dir', () => {
    const targets = getCliLinkTargets('/tmp/home', 'sb-lumen');
    expect(
      shouldWarnMissingCliBinPath(['/usr/bin', targets.primaryBinDir].join(pathDelimiter), targets)
    ).toBe(false);
  });

  it('should not warn when PATH includes compatibility bin dir', () => {
    const targets = getCliLinkTargets('/tmp/home', 'sb-lumen');
    expect(
      shouldWarnMissingCliBinPath(['/usr/bin', targets.compatBinDir].join(pathDelimiter), targets)
    ).toBe(false);
  });

  it('should warn when PATH includes neither PCP nor compatibility bin dirs', () => {
    const targets = getCliLinkTargets('/tmp/home', 'sb-lumen');
    expect(shouldWarnMissingCliBinPath(['/usr/bin', '/bin'].join(pathDelimiter), targets)).toBe(
      true
    );
  });

  it('removes broken symlinks before re-linking', () => {
    const tmpLinkDir = mkdtempSync(join(tmpdir(), 'sb-link-test-'));
    const linkPath = join(tmpLinkDir, 'broken-sb-link');
    symlinkSync('/tmp/nonexistent-target', linkPath);
    expect(() => lstatSync(linkPath)).not.toThrow();

    removeExistingLink(linkPath);
    expect(() => lstatSync(linkPath)).toThrow();

    rmSync(tmpLinkDir, { recursive: true, force: true });
  });
});

describe('Studio init', () => {
  // macOS resolves /var -> /private/var, so we need the real path
  let realTestDir: string;
  let realTestRepo: string;

  beforeEach(() => {
    mkdirSync(TEST_REPO, { recursive: true });
    git('init -b main', TEST_REPO);
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
      git(`worktree add -b myra/studio/myra "${wtPath}"`, realTestRepo);

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
      git(`worktree add -b wren/studio/alpha "${wt1}"`, realTestRepo);
      git(`worktree add -b wren/studio/beta "${wt2}"`, realTestRepo);

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
      git(`worktree add -b wren/studio/wren "${wtPath}"`, realTestRepo);

      // Plan the init
      const { parentDir, moves } = planInit(realTestRepo, 'pcp');

      // Execute the moves (same logic as initStudio but without spinner/process.exit)
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
      expect(branches).toContain('wren/studio/wren');

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
      git(`worktree add -b wren/studio/alpha "${wt1}"`, realTestRepo);
      git(`worktree add -b wren/studio/beta "${wt2}"`, realTestRepo);
      git(`worktree add -b wren/studio/gamma "${wt3}"`, realTestRepo);

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

describe('resolveCopySourceRoot', () => {
  beforeEach(() => {
    mkdirSync(TEST_REPO, { recursive: true });
    git('init -b main', TEST_REPO);
    git('config user.email "test@test.com"', TEST_REPO);
    git('config user.name "Test User"', TEST_REPO);
    writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
    git('add .', TEST_REPO);
    git('commit -m "Initial commit"', TEST_REPO);
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('returns canonical main repo by default, even when called from a worktree path', () => {
    const mainRepo = git('rev-parse --show-toplevel', TEST_REPO);
    const studioPath = join(mainRepo, '..', 'test-repo--alpha');
    git(`worktree add -b wren/studio/alpha "${studioPath}"`, mainRepo);

    expect(resolveCopySourceRoot(studioPath)).toBe(mainRepo);
  });

  it('supports --copy-from as a named studio', () => {
    const mainRepo = git('rev-parse --show-toplevel', TEST_REPO);
    const studioPath = join(mainRepo, '..', 'test-repo--alpha');
    git(`worktree add -b wren/studio/alpha "${studioPath}"`, mainRepo);

    expect(resolveCopySourceRoot(mainRepo, 'alpha')).toBe(studioPath);
  });

  it('supports --copy-from as an explicit path', () => {
    const mainRepo = git('rev-parse --show-toplevel', TEST_REPO);
    const customSource = join(mainRepo, '..', 'custom-source');
    mkdirSync(customSource, { recursive: true });

    expect(resolveCopySourceRoot(mainRepo, customSource)).toBe(customSource);
  });
});

describe('updateIdentityForStudioRename', () => {
  beforeEach(() => {
    mkdirSync(TEST_REPO, { recursive: true });
    git('init -b main', TEST_REPO);
    git('config user.email "test@test.com"', TEST_REPO);
    git('config user.name "Test User"', TEST_REPO);
    writeFileSync(join(TEST_REPO, 'README.md'), '# Test Repo');
    git('add .', TEST_REPO);
    git('commit -m "Initial commit"', TEST_REPO);
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('updates studio/context/description in identity.json after rename', () => {
    const wsPath = join(TEST_REPO, '..', 'test-repo--old');
    mkdirSync(join(wsPath, '.pcp'), { recursive: true });
    writeFileSync(
      join(wsPath, '.pcp', 'identity.json'),
      JSON.stringify(
        {
          agentId: 'lumen',
          studio: 'old',
          context: 'studio-old',
          description: 'Studio: old',
          branch: 'lumen/studio/main-old',
        },
        null,
        2
      )
    );

    const changed = updateIdentityForStudioRename(wsPath, 'old', 'new', {
      fromBranch: 'lumen/studio/main-old',
      toBranch: 'lumen/studio/main-new',
    });
    expect(changed).toBe(true);

    const updated = JSON.parse(readFileSync(join(wsPath, '.pcp', 'identity.json'), 'utf-8'));
    expect(updated.studio).toBe('new');
    expect(updated.context).toBe('studio-new');
    expect(updated.description).toBe('Studio: new');
    expect(updated.branch).toBe('lumen/studio/main-new');
  });
});

describe('planStudioHomeBranchRename', () => {
  it('plans a rename when current branch is old per-studio default', () => {
    const plan = planStudioHomeBranchRename(
      { agentId: 'lumen', branch: 'lumen/studio/main-old-name' },
      'old-name',
      'new-name'
    );
    expect(plan).toEqual({
      fromBranch: 'lumen/studio/main-old-name',
      toBranch: 'lumen/studio/main-new-name',
    });
  });

  it('plans a rename when current branch is legacy default', () => {
    const plan = planStudioHomeBranchRename(
      { agentId: 'lumen', branch: 'lumen/studio/main' },
      'old-name',
      'new-name'
    );
    expect(plan).toEqual({
      fromBranch: 'lumen/studio/main',
      toBranch: 'lumen/studio/main-new-name',
    });
  });

  it('does not plan rename for custom feature branches', () => {
    const plan = planStudioHomeBranchRename(
      { agentId: 'lumen', branch: 'lumen/feat/my-work' },
      'old-name',
      'new-name'
    );
    expect(plan).toBeNull();
  });
});

describe('Studio prefix resolution', () => {
  it('should derive prefix from canonical repo when running in a worktree', () => {
    const mainRepo = join(TEST_DIR, 'personal-context-protocol');
    const worktree = join(TEST_DIR, 'personal-context-protocol--lumen');
    const gitDir = join(mainRepo, '.git', 'worktrees', 'lumen');

    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);

    expect(getStudioPrefix(worktree)).toBe('personal-context-protocol--');
  });
});

describe('isValidTemplateName', () => {
  it('accepts alphanumeric names', () => {
    expect(isValidTemplateName('reviewer')).toBe(true);
    expect(isValidTemplateName('builder')).toBe(true);
    expect(isValidTemplateName('product')).toBe(true);
    expect(isValidTemplateName('my-template')).toBe(true);
    expect(isValidTemplateName('my_template')).toBe(true);
    expect(isValidTemplateName('Template123')).toBe(true);
  });

  it('rejects path traversal patterns', () => {
    expect(isValidTemplateName('../etc/passwd')).toBe(false);
    expect(isValidTemplateName('../../secret')).toBe(false);
    expect(isValidTemplateName('foo/bar')).toBe(false);
    expect(isValidTemplateName('foo\\bar')).toBe(false);
  });

  it('rejects empty and special characters', () => {
    expect(isValidTemplateName('')).toBe(false);
    expect(isValidTemplateName(' ')).toBe(false);
    expect(isValidTemplateName('foo bar')).toBe(false);
    expect(isValidTemplateName('template.md')).toBe(false);
  });
});

describe('resolveRoleTemplate', () => {
  it('resolves built-in templates', () => {
    for (const name of BUILTIN_ROLE_TEMPLATES) {
      const content = resolveRoleTemplate(name);
      expect(content).toBeTruthy();
      expect(content!.length).toBeGreaterThan(0);
    }
  });

  it('returns null for unknown templates', () => {
    expect(resolveRoleTemplate('nonexistent-template')).toBeNull();
  });

  it('returns null for path traversal attempts', () => {
    expect(resolveRoleTemplate('../../../etc/passwd')).toBeNull();
    expect(resolveRoleTemplate('foo/bar')).toBeNull();
  });

  it('returns content starting with expected role header', () => {
    const reviewer = resolveRoleTemplate('reviewer');
    expect(reviewer).toContain('review mode');

    const builder = resolveRoleTemplate('builder');
    expect(builder).toContain('build mode');

    const product = resolveRoleTemplate('product');
    expect(product).toContain('product thinking mode');
  });
});

describe('listRoleTemplates', () => {
  it('includes all built-in templates', () => {
    const templates = listRoleTemplates();
    for (const name of BUILTIN_ROLE_TEMPLATES) {
      expect(templates).toContain(name);
    }
  });

  it('returns a sorted array', () => {
    const templates = listRoleTemplates();
    const sorted = [...templates].sort();
    expect(templates).toEqual(sorted);
  });
});

describe('ROLE_BLOCK in session-start template', () => {
  it('template file includes ROLE_BLOCK placeholder', () => {
    const templatePath = join(__dirname, '..', 'templates', 'hook-session-start.md');
    const content = readFileSync(templatePath, 'utf-8');
    expect(content).toContain('{{ROLE_BLOCK}}');
  });

  it('ROLE_BLOCK appears after WORKSPACE_LINE and before IDENTITY_BLOCK', () => {
    const templatePath = join(__dirname, '..', 'templates', 'hook-session-start.md');
    const content = readFileSync(templatePath, 'utf-8');
    const roleIdx = content.indexOf('{{ROLE_BLOCK}}');
    const wsIdx = content.indexOf('{{WORKSPACE_LINE}}');
    const idIdx = content.indexOf('{{IDENTITY_BLOCK}}');
    expect(roleIdx).toBeGreaterThan(wsIdx);
    expect(roleIdx).toBeLessThan(idIdx);
  });
});
