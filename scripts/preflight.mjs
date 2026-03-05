#!/usr/bin/env node
/**
 * Preflight checks for dev mode.
 *
 * Runs before API + web servers start. Exits non-zero to abort startup.
 * Currently checks:
 *   1. Migration status (warns only — doesn't block)
 *
 * This replaces the preflight logic that was embedded in dev-direct.sh.
 * Running as a node script (not bash) ensures it inherits the user's
 * shell context (nvm, homebrew, etc.) when invoked via `yarn dev`.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const rootDir = resolve(__dirname, '..');

// 1. Migration status check (warn-only — never blocks startup)
try {
  const hasSupa = (() => {
    try {
      execFileSync('which', ['supabase'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  if (hasSupa) {
    execFileSync('node', [resolve(rootDir, 'scripts/migration-status.mjs'), '--workdir', rootDir, '--warn-only'], {
      stdio: 'inherit',
    });
  } else {
    console.log('[preflight] ⚠ Supabase CLI not found; skipping migration check.');
  }
} catch {
  // migration-status exits 0 with --warn-only, so this shouldn't fire,
  // but don't let preflight failures block dev startup.
  console.log('[preflight] ⚠ Migration check failed (non-blocking).');
}

console.log('[preflight] ✓ Ready.');
