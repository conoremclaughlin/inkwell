/**
 * Studio Settings Overlay
 *
 * Layers a session's permission grants onto `.claude/settings.local.json`
 * for the life of a spawn and restores the file afterwards. The settings
 * file itself — default permissions and ink hooks — is written by `ink init`
 * (task c3b34be8), which the server runs through studio-complete.ts; this
 * module no longer generates it.
 */

import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger';

const CLAUDE_SETTINGS_REL = '.claude/settings.local.json';

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    [key: string]: unknown;
  };
  hooks?: Record<string, unknown>;
  enableAllProjectMcpServers?: boolean;
  [key: string]: unknown;
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
 * Merges the overlay rules into the existing `permissions` object
 * (deduplicating), keeping every other key in it, `ask` and `defaultMode`
 * included, and every key outside it. Returns a restore function that
 * writes back the original content. Call the restore function when the
 * session process exits. A settings file that cannot be parsed is refused
 * (throws), never overwritten.
 *
 * It never REMOVES a deny: existing denies are kept and overlay denies are
 * added. An overlay allow that matches a kept deny is inert because Claude
 * Code evaluates deny before allow; that precedence is documented, not
 * measured (Claude Code docs, permissions, "Manage permissions"). So a
 * studio profile's denies (push forms, installs, PR and database writes)
 * cannot be granted away through here, deliberately (design v3, item 2;
 * Lumen, 056b36e7). What the overlay does change is the file for the life
 * of a spawn, and a crash that skips the restore leaves the merged object
 * behind, which `ink init` then keeps as authored policy. This overlay
 * edits one worktree-wide file and restores
 * a snapshot, which is not a per-spawn grant: two overlapping turns can
 * restore each other's snapshots and leave a lift behind, every other turn
 * in the checkout sees it meanwhile, and a server death skips the restore.
 * Deny lifting, if it is ever wanted, is a separate design: process-local
 * effective permissions with explicit grant provenance and expiry.
 */
export async function applyPermissionOverlay(
  worktreePath: string,
  overlay: PermissionOverlay
): Promise<() => Promise<void>> {
  const settingsPath = join(worktreePath, CLAUDE_SETTINGS_REL);
  const originalContent = await readSettings(worktreePath);

  let settings: ClaudeSettings = {};
  if (originalContent) {
    // Fail closed: a file that cannot be read may hold someone's rules.
    const parsed: unknown = JSON.parse(originalContent);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${CLAUDE_SETTINGS_REL} is not a JSON object; overlay not applied`);
    }
    settings = parsed as ClaudeSettings;
  }

  // Merge into the existing object: `ask`, `defaultMode` and any other key
  // stay as authored (review 4177f7fe, P3).
  const existing =
    settings.permissions &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? settings.permissions
      : {};
  const existingAllow = Array.isArray(existing.allow) ? existing.allow : [];
  const existingDeny = Array.isArray(existing.deny) ? existing.deny : [];

  settings.permissions = {
    ...existing,
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
