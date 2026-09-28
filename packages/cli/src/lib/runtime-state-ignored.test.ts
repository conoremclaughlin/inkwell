/**
 * The hook runtime state the CLI writes under `.ink/` — turn-epoch records,
 * their temp files, takeover markers — must be ignored by git in every
 * checkout and at every depth, because the hooks create `.ink/` beside
 * whatever cwd they run in (the repo root, packages/api, a studio). Pinned
 * here against the ROOT .gitignore in a disposable repository, because this
 * package's own broad `packages/cli/.ink/` rule would hide a root-level gap
 * (Lumen, PR #691 round 1: the owner-file names went unignored).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cliTurnEpochPath, takeoverMarkerPath } from './takeover-watcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_GITIGNORE = join(here, '..', '..', '..', '..', '.gitignore');

function checkIgnore(repo: string, paths: string[]): Set<string> {
  // `--no-index` judges the paths against the ignore rules alone; a
  // non-zero exit only means some path was not ignored.
  try {
    const out = execFileSync('git', ['check-ignore', '--no-index', ...paths], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch (error) {
    const out = (error as { stdout?: string }).stdout ?? '';
    return new Set(out.split('\n').filter(Boolean));
  }
}

describe('runtime state under .ink/ is ignored at every depth', () => {
  it('turn-epoch records, their temp files and takeover markers, at the root and nested', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ignore-fixture-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      cpSync(ROOT_GITIGNORE, join(repo, '.gitignore'));
      const owner = { sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', wrapperGeneration: 'g1' };
      const names = (base: string) => [
        cliTurnEpochPath(base, { sessionId: owner.sessionId }),
        cliTurnEpochPath(base, owner),
        `${cliTurnEpochPath(base, owner)}.1234.5678.tmp`,
        cliTurnEpochPath(base),
        takeoverMarkerPath(base, 'g1'),
        takeoverMarkerPath(base),
      ];
      const relative = [...names('.'), ...names('packages/api'), ...names('packages/cli/src')].map(
        (p) => p.replace(/^\.\//, '')
      );
      const ignored = checkIgnore(repo, relative);
      const missed = relative.filter((p) => !ignored.has(p));
      expect(missed).toEqual([]);
      // Control: an ordinary source path is not ignored, so the check can see.
      expect(checkIgnore(repo, ['packages/api/src/index.ts']).size).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
