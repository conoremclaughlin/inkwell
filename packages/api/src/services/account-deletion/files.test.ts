import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  allAbsent,
  claudeProjectDirName,
  inventoryFor,
  removeTarget,
  type FileTarget,
} from './files';

const SB = '9c9c9c9c-0000-4000-8000-0000000000aa';
const OTHER_SB = '9d9d9d9d-0000-4000-8000-0000000000bb';
const THREAD = 'aaaaaaaa-1111-4222-8333-444444444444';

let base: string;
let roots: { inklings: string; claudeProjects: string; codexSessions: string };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'acct-files-')));
  roots = {
    inklings: join(base, 'inklings'),
    claudeProjects: join(base, 'claude-projects'),
    codexSessions: join(base, 'codex-sessions'),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('claudeProjectDirName', () => {
  it("names a folder the way Claude Code does: every '/' and '.' becomes '-'", () => {
    expect(claudeProjectDirName(`/Users/someone/.ink/inklings/${SB}`)).toBe(
      `-Users-someone--ink-inklings-${SB}`
    );
  });
});

describe('inventoryFor', () => {
  it("lists each inkling's folder, tool policy and Claude projects folder, and its Codex rollouts", async () => {
    const day = join(roots.codexSessions, '2026', '10', '07');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-10-07T10-00-00-${THREAD}.jsonl`), '{}');
    writeFileSync(join(day, `rollout-2026-10-07T11-00-00-${OTHER_SB}.jsonl`), '{}');

    const targets = await inventoryFor(
      roots,
      [SB],
      [
        { id: 's1', backend: 'ink', backendSessionId: THREAD },
        { id: 's2', backend: 'ink', backendSessionId: null },
      ]
    );

    const folder = join(roots.inklings, SB);
    expect(targets).toEqual([
      { kind: 'inkling-folder', path: folder, root: roots.inklings, shape: 'directory' },
      {
        kind: 'tool-policy',
        path: join(roots.inklings, '.tool-policy', `${SB}.json`),
        root: roots.inklings,
        shape: 'file',
      },
      {
        kind: 'claude-projects',
        path: join(roots.claudeProjects, claudeProjectDirName(folder)),
        root: roots.claudeProjects,
        shape: 'directory',
      },
      {
        kind: 'codex-rollout',
        path: join(day, `rollout-2026-10-07T10-00-00-${THREAD}.jsonl`),
        root: roots.codexSessions,
        shape: 'file',
      },
    ]);
  });

  it('refuses an identity id that is not a uuid', async () => {
    await expect(inventoryFor(roots, ['../etc'], [])).rejects.toThrow(/identity id/);
  });
});

describe('removeTarget', () => {
  const dirTarget = (path: string, root = roots.inklings): FileTarget => ({
    kind: 'inkling-folder',
    path,
    root,
    shape: 'directory',
  });

  it('removes a real directory inside its root, with its contents', async () => {
    const dir = join(roots.inklings, SB);
    mkdirSync(join(dir, '.ink', 'runtime', 'repl'), { recursive: true });
    writeFileSync(join(dir, '.ink', 'runtime', 'repl', 's-1.jsonl'), 'log');
    expect(await removeTarget(dirTarget(dir))).toMatchObject({ result: 'removed' });
    expect(existsSync(dir)).toBe(false);
  });

  it('reports an absent target as absent', async () => {
    expect(await removeTarget(dirTarget(join(roots.inklings, SB)))).toMatchObject({
      result: 'absent',
    });
  });

  it('holds a link, never following it', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const link = join(roots.inklings, SB);
    symlinkSync(outside, link);
    expect(await removeTarget(dirTarget(link))).toMatchObject({ result: 'held', reason: 'a link' });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('holds a target whose parent is a link', async () => {
    const outside = join(base, 'outside');
    mkdirSync(join(outside, SB), { recursive: true });
    symlinkSync(outside, join(roots.inklings, 'via'));
    const target = dirTarget(join(roots.inklings, 'via', SB));
    expect(await removeTarget(target)).toMatchObject({ result: 'held' });
    expect(existsSync(join(outside, SB))).toBe(true);
  });

  it('holds a path outside its root, and the root itself', async () => {
    mkdirSync(join(base, 'elsewhere'));
    expect(await removeTarget(dirTarget(join(base, 'elsewhere')))).toMatchObject({
      result: 'held',
      reason: 'outside its root',
    });
    expect(await removeTarget(dirTarget(roots.inklings))).toMatchObject({ result: 'held' });
    expect(existsSync(join(base, 'elsewhere'))).toBe(true);
    expect(existsSync(roots.inklings)).toBe(true);
  });

  it('holds a target of the wrong shape', async () => {
    const file = join(roots.inklings, SB);
    writeFileSync(file, 'not a folder');
    expect(await removeTarget(dirTarget(file))).toMatchObject({
      result: 'held',
      reason: 'not a directory',
    });
    expect(existsSync(file)).toBe(true);
  });

  it('removes a single file target', async () => {
    mkdirSync(join(roots.inklings, '.tool-policy'));
    const file = join(roots.inklings, '.tool-policy', `${SB}.json`);
    writeFileSync(file, '{}');
    expect(
      await removeTarget({ kind: 'tool-policy', path: file, root: roots.inklings, shape: 'file' })
    ).toMatchObject({ result: 'removed' });
    expect(existsSync(file)).toBe(false);
  });

  it("leaves another inkling's folder alone", async () => {
    const mine = join(roots.inklings, SB);
    const theirs = join(roots.inklings, OTHER_SB);
    mkdirSync(mine);
    mkdirSync(theirs);
    await removeTarget(dirTarget(mine));
    expect(existsSync(theirs)).toBe(true);
  });
});

describe('allAbsent', () => {
  it('is true only when no target exists', async () => {
    const dir = join(roots.inklings, SB);
    const targets: FileTarget[] = [
      { kind: 'inkling-folder', path: dir, root: roots.inklings, shape: 'directory' },
    ];
    expect(await allAbsent(targets)).toBe(true);
    mkdirSync(dir);
    expect(await allAbsent(targets)).toBe(false);
  });
});
