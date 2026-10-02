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
 * Merges the overlay rules into the existing settings (deduplicating).
 * Returns a restore function that writes back the original content.
 * Call the restore function when the session process exits.
 *
 * ADDITIVE ONLY: an overlay never lifts a deny. Existing denies are kept
 * and overlay denies are added; an overlay allow that matches a kept deny
 * does nothing, because Claude Code evaluates deny before allow. So a
 * studio profile's denies (push, installs, PR and database writes) cannot
 * be granted away through here, and that is deliberate (design v3, item 2;
 * Lumen, 056b36e7). This overlay edits one worktree-wide file and restores
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
