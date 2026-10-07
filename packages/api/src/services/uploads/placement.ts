/**
 * The directories the uploads root must be clear of (layout.ts,
 * prepareUploadsRoot). Each is somewhere another path reads without asking
 * who is reading, or where a turn runs:
 *
 * - `served`: what `/api/admin/media` serves (evidenceMediaRoots);
 * - the studios root, which ClaudeRunner grants every spawn, as it does
 *   `~/.ink/files` (already in `served`);
 * - the inklings' own folders, where an inkling's turn runs;
 * - the server's checkout, where a turn without a studio runs.
 *
 * A studio's registered worktree can be anywhere and is not listed; layout.ts
 * says what that leaves.
 */

import { inklingsRoot } from '../inklings/inkling-folder';
import { inkStudiosRoot } from '../studio-paths';

export function uploadsRootNeighbours(
  served: readonly string[],
  defaultWorkingDirectory: string
): string[] {
  return [...served, inkStudiosRoot(), inklingsRoot(), defaultWorkingDirectory];
}
