/**
 * Studio Settings Generator
 *
 * Generates `.claude/settings.local.json` with default permissions and hooks
 * for studio worktrees. Called during studio creation (MCP) and as a safety
 * net before Claude Code spawn.
 */

import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger';

const CLAUDE_SETTINGS_REL = '.claude/settings.local.json';

/**
 * Default deny rules — destructive commands that should always require
 * confirmation, even in fully auto-approved studios.
 */
const DEFAULT_DENY_RULES: string[] = [
  'Bash(rm -rf *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git reset --hard *)',
  'Bash(git clean -fd *)',
  'Bash(git clean -f *)',
  'Bash(git checkout -- .)',
];

/**
 * Default allow rules — broad permissions for automated development work.
 * Matches the CLI's `ink permissions auto` defaults plus mcp__* for all MCP
 * servers (not just inkwell/github/supabase individually).
 */
const DEFAULT_ALLOW_RULES: string[] = [
  'Bash(*)',
  'Edit(*)',
  'Write(*)',
  'Read(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__*',
];

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  hooks?: Record<string, unknown>;
  enableAllProjectMcpServers?: boolean;
  [key: string]: unknown;
}

/**
 * Resolve the `ink` CLI binary path for hook commands.
 * Checks well-known locations; falls back to bare `ink` (relies on PATH).
 */
function resolveInkBinaryPath(worktreePath: string): string {
  // 1. Global install location (symlinked by `yarn workspace @personal-context/cli install:cli`)
  const globalPath = join(process.env.HOME || '~', '.local', 'bin', 'ink');
  if (existsSync(globalPath)) return globalPath;

  // 2. Main worktree node_modules (for PM2/server environments)
  //    The main worktree is typically the parent dir without the `--slug` suffix
  const base = dirname(worktreePath);
  const mainName = worktreePath
    .split('/')
    .pop()
    ?.replace(/--[^/]+$/, '');
  if (mainName) {
    const mainBin = join(base, mainName, 'node_modules', '.bin', 'ink');
    if (existsSync(mainBin)) return mainBin;
  }

  // 3. Bare fallback
  return 'ink';
}

/**
 * Build Claude Code lifecycle hooks that mirror `ink hooks install --claude-code`.
 */
function buildHooks(inkPath: string): Record<string, unknown> {
  const cmd = (hookName: string) => `${inkPath} hooks ${hookName} --backend claude-code`;

  return {
    PreCompact: [{ hooks: [{ type: 'command', command: cmd('pre-compact') }] }],
    SessionStart: [
      { matcher: 'compact', hooks: [{ type: 'command', command: cmd('post-compact') }] },
      { matcher: 'startup', hooks: [{ type: 'command', command: cmd('on-session-start') }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('on-prompt') }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('on-stop') }] }],
  };
}

/**
 * Generate or update `.claude/settings.local.json` in a worktree.
 *
 * Merges with existing settings — never overwrites hooks or permissions
 * that are already configured. Returns true if a file was written.
 */
export async function ensureStudioSettings(worktreePath: string): Promise<boolean> {
  const settingsPath = join(worktreePath, CLAUDE_SETTINGS_REL);

  let existing: ClaudeSettings = {};
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't parseable — start fresh
  }

  // Skip if permissions are already configured (user or CLI set them up)
  if (existing.permissions?.allow?.length) {
    logger.debug('Studio settings already have permissions, skipping generation', {
      worktreePath,
      existingAllowCount: existing.permissions.allow.length,
    });
    return false;
  }

  const inkPath = resolveInkBinaryPath(worktreePath);

  const settings: ClaudeSettings = {
    ...existing,
    permissions: {
      allow: DEFAULT_ALLOW_RULES,
      deny: DEFAULT_DENY_RULES,
    },
    hooks: existing.hooks || buildHooks(inkPath),
    enableAllProjectMcpServers: existing.enableAllProjectMcpServers ?? true,
  };

  await mkdir(join(worktreePath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  logger.info('Generated studio settings', {
    worktreePath,
    settingsPath,
    allowRules: DEFAULT_ALLOW_RULES.length,
    denyRules: DEFAULT_DENY_RULES.length,
    hooksGenerated: !existing.hooks,
  });

  return true;
}

/**
 * Read the current settings file content (for backup before overlay).
 */
async function readSettings(worktreePath: string): Promise<string | null> {
  try {
    return await readFile(join(worktreePath, CLAUDE_SETTINGS_REL), 'utf-8');
  } catch {
    return null;
  }
}

export interface PermissionOverlay {
  allow?: string[];
  deny?: string[];
}

/**
 * Apply a temporary permission overlay to `.claude/settings.local.json`.
 *
 * Merges the overlay rules into the existing settings (deduplicating).
 * Returns a restore function that writes back the original content.
 * Call the restore function when the session process exits.
 */
export async function applyPermissionOverlay(
  worktreePath: string,
  overlay: PermissionOverlay
): Promise<() => Promise<void>> {
  const settingsPath = join(worktreePath, CLAUDE_SETTINGS_REL);
  const originalContent = await readSettings(worktreePath);

  let settings: ClaudeSettings = {};
  if (originalContent) {
    try {
      settings = JSON.parse(originalContent);
    } catch {
      // unparseable — start from current defaults
    }
  }

  // Merge overlay rules (deduplicate with Set)
  const existingAllow = settings.permissions?.allow || [];
  const existingDeny = settings.permissions?.deny || [];

  settings.permissions = {
    allow: [...new Set([...existingAllow, ...(overlay.allow || [])])],
    deny: [...new Set([...existingDeny, ...(overlay.deny || [])])],
  };

  await mkdir(join(worktreePath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  logger.info('Applied permission overlay', {
    worktreePath,
    addedAllow: overlay.allow?.length || 0,
    addedDeny: overlay.deny?.length || 0,
  });

  // Return restore function
  return async () => {
    try {
      if (originalContent) {
        await writeFile(settingsPath, originalContent);
      } else {
        // File didn't exist before overlay — remove it
        await rm(settingsPath, { force: true });
      }
      logger.debug('Restored original settings after overlay', { worktreePath });
    } catch (err) {
      logger.warn('Failed to restore settings after overlay', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
