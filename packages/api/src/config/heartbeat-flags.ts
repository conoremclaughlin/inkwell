import { readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface HeartbeatFlagValues {
  ENABLE_HEARTBEATS: string | undefined;
  ENABLE_REMINDERS: string | undefined;
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

export function isGitWorktree(cwd: string = process.cwd()): boolean {
  try {
    const gitPath = join(cwd, '.git');
    const s = statSync(gitPath);
    // In a worktree, .git is a file containing "gitdir: ..."; in the root repo, it's a directory
    if (s.isFile()) {
      const content = readFileSync(gitPath, 'utf-8');
      return content.trimStart().startsWith('gitdir:');
    }
    return false;
  } catch {
    return false;
  }
}

export function getHeartbeatProcessingConfig(
  envSource: NodeJS.ProcessEnv = process.env
): HeartbeatProcessingConfig {
  const flags: HeartbeatFlagValues = {
    ENABLE_HEARTBEATS: envSource.ENABLE_HEARTBEATS,
    ENABLE_REMINDERS: envSource.ENABLE_REMINDERS,
  };

  // Auto-disable in git worktrees unless explicitly enabled. Worktree dev servers
  // should not process reminders — the main server on port 3001 owns those globally.
  const worktree = isGitWorktree();
  if (worktree) {
    flags.isWorktree = true;
  }
  const explicitlyEnabled =
    normalize(flags.ENABLE_HEARTBEATS) === 'true' || normalize(flags.ENABLE_REMINDERS) === 'true';

  const disabled =
    isDisabled(flags.ENABLE_HEARTBEATS) ||
    isDisabled(flags.ENABLE_REMINDERS) ||
    (worktree && !explicitlyEnabled);

  return {
    flags,
    enabled: !disabled,
  };
}
