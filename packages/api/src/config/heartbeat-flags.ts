import { readFileSync, statSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

export interface HeartbeatFlagValues {
  ENABLE_HEARTBEATS: string | undefined;
  ENABLE_REMINDERS: string | undefined;
  ENABLE_HEARTBEAT_SERVICE: string | undefined;
  isWorktree?: boolean;
}

export interface HeartbeatProcessingConfig {
  enabled: boolean;
  flags: HeartbeatFlagValues;
}

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase();
}

function isDisabled(value: string | undefined): boolean {
  const normalized = normalize(value);
  if (normalized === undefined) return false;
  return DISABLED_VALUES.has(normalized);
}

/**
 * Is `cwd` inside a git worktree (as opposed to the root repo)?
 *
 * Walks UP to the nearest ancestor holding a `.git`, because the process cwd is
 * almost never the repo root. The API server starts via
 * `yarn workspace @inklabs/api server:dev`, which puts cwd at
 * `<repo>/packages/api` — and `packages/api/.git` does not exist. The original
 * version only stat'd `<cwd>/.git`, so the stat threw, the catch returned
 * false, and this reported "not a worktree" for EVERY server ever started that
 * way, root repo and worktree alike.
 *
 * That is not theoretical. On 2026-09-11 a second server running from
 * personal-context-protocol--wren processed Myra's hourly reminders alongside
 * the main server for thirteen hours — both ticking, racing to claim each due
 * reminder — and killed roughly half her heartbeats, because it spawned her
 * into its own worktree where `ink` was a build dated Apr 9. This guard exists
 * precisely to stop that and had never once fired. The five unit tests covering
 * it all set cwd to a repo ROOT, a directory the server is never in.
 *
 * Nearest `.git` wins: a file containing `gitdir:` means worktree, a directory
 * means root repo. Reaching the filesystem root without finding either means
 * not a git checkout at all.
 */
export function isGitWorktree(cwd: string = process.cwd()): boolean {
  let dir = resolve(cwd);
  const { root } = parse(dir);

  for (;;) {
    const gitPath = join(dir, '.git');
    try {
      // In a worktree, .git is a file containing "gitdir: ..."; in the root repo, it's a directory
      if (statSync(gitPath).isFile()) {
        return readFileSync(gitPath, 'utf-8').trimStart().startsWith('gitdir:');
      }
      return false;
    } catch {
      // No .git here — keep walking toward the root.
    }

    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function getHeartbeatProcessingConfig(
  envSource: NodeJS.ProcessEnv = process.env
): HeartbeatProcessingConfig {
  // ENABLE_HEARTBEAT_SERVICE is the name AGENTS.md has told every SB to set on
  // an isolated server. Nothing read it — `grep` found it in exactly one place,
  // a line in dev-concurrently.mjs that PRINTS it. The operator who started the
  // second server on 2026-09-11 set it correctly and it was a no-op, which is
  // how a documented safety step and an inert worktree guard managed to fail in
  // the same breath. Honour the documented name rather than quietly keep being
  // right about a name nobody uses.
  const flags: HeartbeatFlagValues = {
    ENABLE_HEARTBEATS: envSource.ENABLE_HEARTBEATS,
    ENABLE_REMINDERS: envSource.ENABLE_REMINDERS,
    ENABLE_HEARTBEAT_SERVICE: envSource.ENABLE_HEARTBEAT_SERVICE,
  };

  // Auto-disable in git worktrees unless explicitly enabled. Worktree dev servers
  // should not process reminders — the main server on port 3001 owns those globally.
  const worktree = isGitWorktree();
  if (worktree) {
    flags.isWorktree = true;
  }
  const explicitlyEnabled =
    normalize(flags.ENABLE_HEARTBEATS) === 'true' ||
    normalize(flags.ENABLE_REMINDERS) === 'true' ||
    normalize(flags.ENABLE_HEARTBEAT_SERVICE) === 'true';

  const disabled =
    isDisabled(flags.ENABLE_HEARTBEATS) ||
    isDisabled(flags.ENABLE_REMINDERS) ||
    isDisabled(flags.ENABLE_HEARTBEAT_SERVICE) ||
    (worktree && !explicitlyEnabled);

  return {
    flags,
    enabled: !disabled,
  };
}
