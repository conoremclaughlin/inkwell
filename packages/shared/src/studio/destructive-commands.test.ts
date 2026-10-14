/**
 * The destructive-command decision (spec automated-turn-permissions §3.4).
 * Detection is broad and the allowance tiny, so most rows here are a
 * construct the check declines. Each row names its reason. The filesystem
 * is an in-memory fixture: the real directories, one symlink out of the
 * studio, and one symlinked alias into it.
 */
import { describe, it, expect } from 'vitest';
import * as destructive from './destructive-commands.js';

const HOME = '/h';
const STUDIO = '/h/ws/repo--alpha';
const SCRATCH = '/h/.ink/files/wren-scratch';

const realDirs = new Set([
  '/',
  '/h',
  '/h/ws',
  '/h/ws/repo',
  STUDIO,
  `${STUDIO}/dist`,
  `${STUDIO}/node_modules`,
  `${STUDIO}/packages`,
  `${STUDIO}/packages/mobile`,
  '/h/.ink',
  '/h/.ink/files',
  SCRATCH,
  `${SCRATCH}/run-1`,
  '/etc',
  '/tmp',
]);
/** Symlinks: path → what it resolves to. */
const links = new Map<string, string>([
  [`${STUDIO}/out`, '/etc'],
  ['/h/alias', STUDIO],
]);

const fs: destructive.DestructiveFs = {
  realpath(path) {
    if (links.has(path)) return links.get(path)!;
    for (const [link, target] of links) {
      if (path.startsWith(`${link}/`)) {
        const resolved = target + path.slice(link.length);
        return realDirs.has(resolved) ? resolved : null;
      }
    }
    return realDirs.has(path) ? path : null;
  },
  isSymlink(path) {
    return links.has(path);
  },
};

const context = (extra: Partial<destructive.DestructiveContext> = {}) => ({
  cwd: STUDIO,
  home: HOME,
  roots: [STUDIO, SCRATCH],
  ...extra,
});
const classify = (command: string, extra: Partial<destructive.DestructiveContext> = {}) =>
  destructive.classifyDestructiveCommand(command, context(extra), fs);

describe('allowed: a single simple rm strictly inside an allowed root', () => {
  it.each([
    ['rm -rf dist', `${STUDIO}/dist`],
    ['rm -rf ./dist', `${STUDIO}/dist`],
    ['rm -fr node_modules', `${STUDIO}/node_modules`],
    ['rm -r -f dist', `${STUDIO}/dist`],
    ['rm --recursive --force dist', `${STUDIO}/dist`],
    ['rm -R dist', `${STUDIO}/dist`],
    [`rm -rf ${STUDIO}/packages/mobile`, `${STUDIO}/packages/mobile`],
    ['rm -rf ~/.ink/files/wren-scratch/run-1', `${SCRATCH}/run-1`],
    ['rm -rf packages/mobile/ios-build', `${STUDIO}/packages/mobile/ios-build`],
    ['rm -rf /h/alias/dist', `${STUDIO}/dist`],
  ])('%s', (command, target) => {
    expect(classify(command)).toEqual({ kind: 'allowed', targets: [target] });
  });

  it('several operands, every one inside', () => {
    expect(classify('rm -rf dist node_modules')).toEqual({
      kind: 'allowed',
      targets: [`${STUDIO}/dist`, `${STUDIO}/node_modules`],
    });
  });

  it('relative operands resolve against the hook cwd, not the root', () => {
    expect(classify('rm -rf run-1', { cwd: SCRATCH })).toEqual({
      kind: 'allowed',
      targets: [`${SCRATCH}/run-1`],
    });
  });
});

describe('needs approval: destructive, and not the tiny allowance', () => {
  it.each([
    ['rm -rf ..', '.. segment'],
    ['rm -rf ../repo', '.. segment'],
    ['rm -rf dist/../..', '.. segment'],
    // Lexically inside, but the kernel resolves the link before the ..
    // (Lumen, #853): out → /etc, so out/../x is /x.
    ['rm -rf out/../victim', '.. segment'],
    ['rm -rf dist/../node_modules', '.. segment'],
    [`rm -rf ${STUDIO}/out/../victim`, '.. segment'],
    ['rm -rf ~/.ink/files/wren-scratch/../x', '.. segment'],
    ['rm -rf .', 'not inside'],
    [`rm -rf ${STUDIO}`, 'not inside'],
    [`rm -rf ${SCRATCH}`, 'not inside'],
    ['rm -rf /etc', 'not inside'],
    ['rm -rf /', 'ends in a slash'],
    ['rm -rf /h/ws/repo/node_modules', 'not inside'],
    ['rm -rf ~', 'does not expand'],
    ['rm -rf out', 'symbolic link'],
    ['rm -rf out/passwd', 'not inside'],
    ['rm -rf dist/', 'ends in a slash'],
    ['rm -rf dist node_modules /tmp', 'not inside'],
    ['rm -rf dist && rm -rf /etc', 'not one simple command'],
    ['cd /tmp && rm -rf dist', 'not one simple command'],
    ['rm -rf dist; echo done', 'not one simple command'],
    ['rm -rf dist | tee log', 'not one simple command'],
    ['rm -rf dist > log', 'not one simple command'],
    ['rm -rf $HOME/x', 'not one simple command'],
    ['rm -rf `pwd`', 'not one simple command'],
    ['rm -rf $(pwd)/dist', 'not one simple command'],
    ['rm -rf "dist"', 'not one simple command'],
    ["rm -rf 'dist'", 'not one simple command'],
    ['rm -rf dist\\ x', 'not one simple command'],
    ['rm -rf dist/*', 'not one simple command'],
    ['rm -rf dist?', 'not one simple command'],
    ['rm -rf {dist,out}', 'not one simple command'],
    ['rm -rf -- dist', 'flag --'],
    ['rm -rfv dist', 'flag -rfv'],
    ['rm -rf --no-preserve-root /', 'flag --no-preserve-root'],
    ['rm -rf dist -i', 'reads as a flag'],
    ['rm -rf ~root/x', 'does not expand'],
    ['sudo rm -rf dist', 'only a plain rm'],
    ['/bin/rm -rf dist', 'only a plain rm'],
    ['env rm -rf dist', 'only a plain rm'],
    ['git reset --hard', 'only a plain rm'],
    ['git reset --hard HEAD~1', 'only a plain rm'],
    ['git -C /h/ws/repo reset --hard', 'only a plain rm'],
    ['git clean -fd', 'only a plain rm'],
    ['git clean -xdf', 'only a plain rm'],
    ['git checkout -- .', 'only a plain rm'],
    ['rm -rf dist\nrm -rf /etc', 'not one simple command'],
  ])('%j → %s', (command, why) => {
    const verdict = classify(command);
    expect(verdict.kind).toBe('needs-approval');
    expect((verdict as { reason: string }).reason).toContain(why);
  });

  it('a root that does not exist allows nothing', () => {
    expect(classify('rm -rf dist', { roots: ['/nowhere'] }).kind).toBe('needs-approval');
  });

  it('with no roots at all, every destructive command needs approval', () => {
    expect(classify('rm -rf dist', { roots: [] })).toMatchObject({ kind: 'needs-approval' });
  });

  it('runs of spaces between words are only spacing', () => {
    expect(classify('rm  -rf  dist').kind).toBe('allowed');
  });

  it('a relative root is never trusted', () => {
    expect(classify('rm -rf dist', { roots: ['repo--alpha'] }).kind).toBe('needs-approval');
  });
});

describe('not destructive: nothing for the hook to decide', () => {
  it.each([
    'rm file.txt',
    'rm -f dist/a.js',
    'ls -rf',
    'grep -r rm .',
    'git reset --soft HEAD~1',
    'git reset HEAD file',
    'git clean -n',
    'git checkout main',
    'git checkout -- src/file.ts',
    'yarn test',
    'trim -rf x',
  ])('%j', (command) => {
    expect(classify(command)).toEqual({ kind: 'not-destructive' });
  });
});

describe('detection looks through operators and wrappers, as broadly as the denies it replaces', () => {
  it.each([
    'yarn build && rm -rf dist',
    'cd x; rm -rf y',
    '(rm -rf dist)',
    'sudo rm -rf /',
    'xargs rm -rf',
    'nohup rm -r x',
    'echo hi | rm -rf x',
    'git -C /w reset --hard origin/main',
    'git -c core.x=1 clean -fdx',
    '/usr/bin/rm -Rf x',
    'timeout 5 rm --recursive x',
    'bash -c "rm -rf x"',
    'FOO=1 rm -rf x',
    'echo rm -rf /',
  ])('%j is destructive', (command) => {
    expect(classify(command).kind).not.toBe('not-destructive');
  });
});
