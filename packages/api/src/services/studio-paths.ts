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
import { mkdir } from 'fs/promises';

/** djb2/base36 of the ORIGINAL input — the anti-aliasing suffix. */
function segmentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * One path segment: lowercase, hyphen-safe, never empty, never dot-leading,
 * at most 100 chars.
 *
 * Already-canonical inputs pass through BYTE-FOR-BYTE — the leaf must stay
 * 1:1 with the DB slug, and collapsing its hyphens would alias `a--b` onto
 * `a-b`. Any input that sanitization transforms or truncation shortens gets
 * a digest of the ORIGINAL appended: normalization is many-to-one
 * (`'A-b'`/`'a-b'`, `'pr:1'`/`'pr-1'`, two 100+-char slugs sharing a prefix
 * — Lumen, PR #544 r1), so without the digest, distinct studios could
 * collide on one directory.
 */
export function studioPathSegment(input: string | null | undefined, fallback: string): string {
  const raw = input || '';
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return fallback;
  if (cleaned === raw && raw.length <= 100) return cleaned;
  const base = cleaned.slice(0, 91).replace(/-+$/g, '');
  return `${base}-h${segmentHash(raw)}`;
}

/**
 * The canonical ephemeral-studio root. `INK_STUDIOS_ROOT` overrides for
 * tests and isolated servers; the default is ~/.ink/studios.
 */
export function inkStudiosRoot(): string {
  return process.env.INK_STUDIOS_ROOT || path.join(homedir(), '.ink', 'studios');
}

/**
 * Ensure the root exists (async — server code must never block the event
 * loop) and return it. Spawn paths call this before granting the root:
 * backends ignore or reject grants on nonexistent directories.
 */
export async function ensureInkStudiosRoot(): Promise<string> {
  const root = inkStudiosRoot();
  try {
    // try/catch rather than .catch(): a mocked or broken fs module can make
    // mkdir throw synchronously, and the grant must never fail a spawn.
    await mkdir(root, { recursive: true });
  } catch {
    // Non-fatal — worst case the grant is a no-op until the dir exists.
  }
  return root;
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
