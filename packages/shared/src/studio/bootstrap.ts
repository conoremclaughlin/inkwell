/**
 * Studio bootstrap files
 *
 * `.mcp.json` and `.env.local` are gitignored, so `git worktree add` brings
 * neither — a new studio starts with no MCP configuration at all. Copying
 * them from the main worktree is the first step of completing a studio, and
 * it lives here because both the CLI's completion routine (`ink init`,
 * packages/cli/src/lib/studio-complete.ts) and this package's config sync
 * need it. The routine itself, which every creator runs, is `ink init`; the
 * server reaches it through packages/api/src/services/studio-complete.ts.
 */

import { existsSync, cpSync, lstatSync } from 'fs';
import { join } from 'path';

/** Local-only files a worktree needs but git will never provide. */
export const BOOTSTRAP_FILES = ['.mcp.json', '.env.local'] as const;

export interface BootstrapStudioResult {
  /** Files copied in from the source root (absent ones are skipped). */
  copied: string[];
  /** Whether `.codex/config.toml` was written. */
  codex: boolean;
  /** Whether `.gemini/settings.json` was written. */
  gemini: boolean;
}

/**
 * Copy `.mcp.json` and `.env.local` into a studio when missing.
 *
 * Never overwrites: a studio that has already been customised keeps its own
 * copy. Returns the files actually copied.
 *
 * "Missing" is decided with lstat, not existsSync. existsSync follows links,
 * so a dangling symlink at the target reads as absent — and cpSync would then
 * write THROUGH it to wherever it points, outside the studio. A checkout can
 * ship such a link (Lumen, PR #604). Any entry at the target, link or not,
 * means: leave it alone.
 */
export function copyBootstrapFiles(sourceRoot: string, studioPath: string): string[] {
  if (sourceRoot === studioPath) return [];

  const copied: string[] = [];
  for (const file of BOOTSTRAP_FILES) {
    const source = join(sourceRoot, file);
    const target = join(studioPath, file);
    if (!existsSync(source)) continue;
    let occupied = true;
    try {
      lstatSync(target);
    } catch {
      occupied = false;
    }
    if (occupied) continue;
    cpSync(source, target);
    copied.push(file);
  }
  return copied;
}
