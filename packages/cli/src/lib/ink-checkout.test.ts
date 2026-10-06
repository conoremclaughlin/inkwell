/**
 * The main worktree of a checkout, read from git's own files (task
 * 5cabaeeb). Hand-built layouts pin each branch; one real `git worktree add`
 * pins the parser to what git actually writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { inkCliMainWorktree, mainWorktreeOf } from './ink-checkout.js';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-checkout-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A main worktree and a linked one, laid out as git lays them out. */
function seedWorktrees() {
  const main = join(root, 'repo');
  const linked = join(root, 'repo--alpha');
  mkdirSync(join(main, '.git', 'worktrees', 'alpha'), { recursive: true });
  writeFileSync(join(main, '.git', 'worktrees', 'alpha', 'commondir'), '../..\n');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'alpha')}\n`);
  return { main, linked };
}

describe('mainWorktreeOf', () => {
  it('a main worktree is its own', () => {
    const { main } = seedWorktrees();
    expect(mainWorktreeOf(main)).toBe(main);
  });

  it("a linked worktree resolves to the worktree that owns git's common dir", () => {
    const { main, linked } = seedWorktrees();
    expect(mainWorktreeOf(linked)).toBe(main);
  });

  it('a relative gitdir is read from the worktree', () => {
    const { main, linked } = seedWorktrees();
    writeFileSync(join(linked, '.git'), 'gitdir: ../repo/.git/worktrees/alpha\n');
    expect(mainWorktreeOf(linked)).toBe(main);
  });

  it('a submodule (a gitdir with no commondir) is not a worktree', () => {
    const sub = join(root, 'sub');
    mkdirSync(join(root, 'parent', '.git', 'modules', 'sub'), { recursive: true });
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), `gitdir: ${join(root, 'parent', '.git', 'modules', 'sub')}\n`);
    expect(mainWorktreeOf(sub)).toBeNull();
  });

  it("a bare repository's worktree has no main worktree", () => {
    const bare = join(root, 'repo.git');
    const linked = join(root, 'wt');
    mkdirSync(join(bare, 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(bare, 'worktrees', 'wt', 'commondir'), '../..\n');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(bare, 'worktrees', 'wt')}\n`);
    expect(mainWorktreeOf(linked)).toBeNull();
  });

  it('no checkout, or a symlinked .git, is null', () => {
    const { main } = seedWorktrees();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(mainWorktreeOf(plain)).toBeNull();
    const linkedGit = join(root, 'linked-git');
    mkdirSync(linkedGit);
    symlinkSync(join(main, '.git'), join(linkedGit, '.git'));
    expect(mainWorktreeOf(linkedGit)).toBeNull();
  });

  it('agrees with what git itself writes for `git worktree add`', () => {
    const main = join(root, 'real');
    const linked = join(root, 'real--wt');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(
      main,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root'
    );
    git(main, 'worktree', 'add', '-q', '-b', 'wt', linked);
    expect(mainWorktreeOf(main)).toBe(main);
    expect(mainWorktreeOf(linked)).toBe(main);
  });
});

describe('inkCliMainWorktree', () => {
  it('is the main worktree of the checkout this CLI is in, which carries the channel plugin', () => {
    const checkout = inkCliMainWorktree();
    expect(checkout).not.toBeNull();
    expect(existsSync(join(checkout!, 'packages', 'channel-plugin', 'index.ts'))).toBe(true);
    expect(mainWorktreeOf(checkout!)).toBe(checkout);
  });
});
