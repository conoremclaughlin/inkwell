/**
 * The Inkwell checkout the running ink CLI was built from, as its MAIN
 * worktree (task 5cabaeeb).
 *
 * The inkmail channel plugin lives in Inkwell's own tree. A repo that is not
 * Inkwell, such as an app repo beside it, has no copy, so `ink init` there
 * wrote a `.mcp.json` without inkmail and its sessions never got inbox push.
 * The CLI that is running knows where Inkwell is: it is a file in it.
 *
 * Always the main worktree, never a linked one: a studio can be a checkout
 * of unreviewed code, and a `.mcp.json` entry naming its copy of the plugin
 * would run that code at the next session start (Lumen, PR #604). A CLI run
 * from a studio's build therefore resolves to the main worktree beside it.
 */

import { lstatSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * The main worktree of the git checkout at `dir`, read from the files git
 * writes, with no subprocess: `dir` itself when `.git` is a directory; for
 * a linked worktree (`.git` is a file), the worktree that owns the common
 * git dir. Null for anything else: no checkout, a symlinked `.git`, a
 * submodule (no `commondir`), or a bare repository's worktree.
 */
export function mainWorktreeOf(dir: string): string | null {
  const dotGit = join(dir, '.git');
  let stat;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return resolve(dir);
  if (!stat.isFile()) return null;
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf-8'))?.[1];
    if (!gitdir) return null;
    const gitDir = resolve(dir, gitdir);
    const commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim());
    return basename(commonDir) === '.git' ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/** The repo root of this CLI: `packages/cli/{src,dist}/lib/` is four levels down. */
const CLI_CHECKOUT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/** The main worktree of the Inkwell checkout this CLI runs from, or null. */
export function inkCliMainWorktree(): string | null {
  return mainWorktreeOf(CLI_CHECKOUT);
}
