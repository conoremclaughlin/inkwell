/**
 * Studio Settings Generator
 *
 * Generates `.claude/settings.local.json` with default permissions and hooks
 * for studio worktrees. Called during studio creation (MCP) and as a safety
 * net before Claude Code spawn.
 */

import { mkdir, readFile, writeFile, rm, lstat } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger';
import { resolveInkCli, inkCliCommand } from './ink-cli';

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
 * Each MCP server is listed explicitly because Claude Code does not support
 * cross-server wildcards like `mcp__*` — only server-scoped patterns
 * (e.g. `mcp__inkwell__*`) are matched by the permission engine.
 */
const DEFAULT_ALLOW_RULES: string[] = [
  'Bash(*)',
  'Edit(*)',
  'Write(*)',
  'Read(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__inkwell__*',
  'mcp__supabase__*',
  'mcp__github__*',
  'mcp__playwright__*',
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
 * The command prefix generated hooks use to reach `ink`: this checkout's own
 * CLI build (or INK_CLI_PATH), never the global `~/.ink/bin/ink` link, which
 * points at whichever checkout the OB last chose. A checkout with no build
 * falls back to bare `ink`, resolved on the PATH of whoever runs the hook.
 */
function inkHookCommand(): string {
  const cli = resolveInkCli();
  return cli ? inkCliCommand(cli) : 'ink';
}

/**
 * Trailing shell comment that tells `ink hooks install` a hook line is ours.
 * The CLI recognizes its own lines by the launcher's shape, but the launcher
 * here may be an arbitrary INK_CLI_PATH, so every line the server writes
 * carries the marker. Must match MANAGED_HOOK_MARKER in
 * packages/cli/src/commands/hooks.ts; studio-settings-cli-install.test.ts
 * runs the real installer on this generator's output to pin the two.
 */
const MANAGED_HOOK_MARKER = '# ink-managed';

/**
 * Build Claude Code lifecycle hooks that mirror `ink hooks install --claude-code`.
 */
function buildHooks(inkCommand: string): Record<string, unknown> {
  const cmd = (hookName: string) =>
    `${inkCommand} hooks ${hookName} --backend claude-code ${MANAGED_HOOK_MARKER}`;

  return {
    PreCompact: [{ hooks: [{ type: 'command', command: cmd('pre-compact') }] }],
    SessionStart: [
      { matcher: 'compact', hooks: [{ type: 'command', command: cmd('post-compact') }] },
      { matcher: 'startup', hooks: [{ type: 'command', command: cmd('on-session-start') }] },
    ],
    PreToolUse: [{ hooks: [{ type: 'command', command: cmd('on-tool-approval') }] }],
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

  // Never write through a link. A checkout can ship `.claude`, or the settings
  // file itself, as a symlink to anywhere; merging and writing would then land
  // outside the worktree (Lumen, PR #604). lstat sees the link, not its target.
  for (const candidate of [join(worktreePath, '.claude'), settingsPath]) {
    const entry = await lstat(candidate).catch(() => null);
    if (entry?.isSymbolicLink()) {
      logger.warn('Refusing to write studio settings through a symlink', {
        worktreePath,
        path: candidate,
      });
      return false;
    }
  }

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

  const inkCommand = inkHookCommand();

  const settings: ClaudeSettings = {
    ...existing,
    permissions: {
      allow: DEFAULT_ALLOW_RULES,
      deny: DEFAULT_DENY_RULES,
    },
    hooks: existing.hooks || buildHooks(inkCommand),
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
