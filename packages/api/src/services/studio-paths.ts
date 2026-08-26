/**
 * Ephemeral studio materialization root (spec:studio-materialization v8).
 *
 * All EPHEMERAL studios materialize under one canonical, agent-namespaced
 * root instead of as siblings of the durable checkouts in ~/ws:
 *
 *   ~/.ink/studios/<agent>/<project>/<leaf>
 *
 * Why one root (spec §The ephemeral studio root):
 *   1. Permissions — Claude Code cannot grant a live session a new directory,
 *      so spawn configs grant this root ONCE and every future create works
 *      instantly. (The parent checkout stays in scope regardless: worktree
 *      git operations touch its .git/worktrees metadata.)
 *   2. Per-SB namespacing — the agent-first segment mirrors the per-agent
 *      file-isolation direction and later allows scoping each SB's grant.
 *   3. Multi-repo by construction — the <project> segment.
 *   4. GC — one sweepable root.
 *
 * The <leaf> is the studio's full DB slug (e.g. `lumen-review--pr-537`), not
 * the bare thread slug: the same thread can overflow from two durable
 * parents (`wren-omega` and `wren-cli` both exist for one repo), and a
 * thread-only leaf would collide them on disk while the DB happily holds
 * both rows. Leaf === slug keeps a 1:1 row↔directory mapping.
 *
 * Scope: ephemeral studios only. Durable homes (main studios, feature
 * studios, `create_studio`, persistent strategy studios) stay in ~/ws — they
 * are checkouts a human also lives in.
 *
 * IMPORTANT interaction: `StudiosRepository.create` historically DERIVED the
 * row's slug from the worktree folder name (`<repo>--<slug>`). Paths under
 * this root do not follow that convention, so every caller that mints here
 * MUST pass `slug` explicitly to create() — a derived slug would come back
 * null and silently break reuse-by-slug.
 */

import path from 'path';
import { homedir } from 'os';

/**
 * One path segment: lowercase, hyphen-safe, never empty, never dot-leading.
 * Existing hyphens (including `--` in DB slugs) are preserved — collapsing
 * them would alias distinct slugs (`a--b` vs `a-b`) onto one directory.
 */
export function studioPathSegment(input: string | null | undefined, fallback: string): string {
  const cleaned = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return cleaned || fallback;
}

/**
 * The canonical ephemeral-studio root. `INK_STUDIOS_ROOT` overrides for
 * tests and isolated servers; the default is ~/.ink/studios.
 */
export function inkStudiosRoot(): string {
  return process.env.INK_STUDIOS_ROOT || path.join(homedir(), '.ink', 'studios');
}

/** `<root>/<agent>/<project>/<leaf>` — where an ephemeral studio materializes. */
export function ephemeralWorktreePath(opts: {
  agentId?: string | null;
  repoRoot: string;
  leaf: string;
}): string {
  return path.join(
    inkStudiosRoot(),
    studioPathSegment(opts.agentId, 'agent'),
    studioPathSegment(path.basename(opts.repoRoot), 'project'),
    studioPathSegment(opts.leaf, 'studio')
  );
}
