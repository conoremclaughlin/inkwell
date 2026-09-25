#!/usr/bin/env node
/**
 * Preflight for `yarn dev` and `yarn prod:direct`: runs before the servers
 * start, and exits non-zero to keep them from starting.
 *
 * The restart is the deploy. On 2026-09-24 the main server was restarted on a
 * release whose migrations had not been applied; this script printed the
 * pending list as a warning and let it start, and every channel poll then
 * failed on a renamed function until the window was run. So, from the main
 * checkout against the local stack, pending migrations are now APPLIED here,
 * in version order, through scripts/db-migrate.sh (one transaction per file,
 * recorded under the file's own version), and a failure stops the start.
 *
 *   - A window migration (`-- db-migrate: window <runbook>` in its first ten
 *     lines) is never applied at startup: the start is refused and the runbook
 *     named. Run the window, then start.
 *   - A worktree checkout (a branch's test server) never applies anything to
 *     the shared stack; it warns, as before.
 *   - A linked (hosted) target is not driven by the wrapper: pending there
 *     refuses the start and points at `yarn linked:migrate`.
 *   - INK_SKIP_MIGRATIONS=1 (`yarn dev:no-migrations`) skips all of it on
 *     purpose, prints what is pending, and starts: the escape hatch for running
 *     old code against the old schema knowingly.
 *
 * Runs as node, not bash, so it inherits the user's shell context (nvm,
 * homebrew) when invoked via `yarn dev`.
 */

import { spawnSync } from 'child_process';
import { accessSync, constants, readFileSync, statSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..');
const rootDir = resolve(scriptsDir, '..');
const statusScript = resolve(scriptsDir, 'migration-status.mjs');
const wrapper = resolve(scriptsDir, 'db-migrate.sh');

const log = (line) => console.log(`[preflight] ${line}`);
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

function onPath(command) {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // not here; keep looking
    }
  }
  return false;
}

// A linked worktree's .git is a file naming the main checkout's gitdir.
// Mirrors isGitWorktree in packages/api/src/config/heartbeat-flags.ts.
function isGitWorktree(dir) {
  const gitPath = join(dir, '.git');
  try {
    if (statSync(gitPath).isFile()) {
      return readFileSync(gitPath, 'utf-8').trimStart().startsWith('gitdir:');
    }
  } catch {
    // no .git here: not a worktree
  }
  return false;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    log(`✗ could not run ${command}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

function statusTarget() {
  const result = spawnSync('node', [statusScript, '--workdir', rootDir, '--print-target'], {
    encoding: 'utf-8',
  });
  const target = String(result.stdout || '').trim();
  // Unknown means "not the local stack": never apply on a guess.
  return target === 'local' ? 'local' : 'linked';
}

const skip = truthy(process.env.INK_SKIP_MIGRATIONS);
const escape =
  'to start anyway, knowingly: yarn dev:no-migrations (INK_SKIP_MIGRATIONS=1 for prod:direct)';

if (!onPath('supabase')) {
  if (skip) {
    log('⚠ Supabase CLI not found and migrations skipped by request; starting without a check.');
  } else {
    log('✗ Supabase CLI not found; pending migrations cannot be checked or applied.');
    log(`  Install it (https://supabase.com/docs/guides/cli/getting-started), or ${escape}`);
    process.exit(1);
  }
} else if (skip) {
  run('node', [statusScript, '--workdir', rootDir, '--warn-only']);
  log(
    '⚠ Migrations SKIPPED by request (INK_SKIP_MIGRATIONS). Anything listed above stays pending;'
  );
  log('  the server is starting against the schema as it is.');
} else if (isGitWorktree(rootDir)) {
  run('node', [statusScript, '--workdir', rootDir, '--warn-only']);
  log('worktree checkout: nothing is applied to the shared stack from a branch server.');
  log(
    '  Apply a pending file from the checkout that holds it: yarn db:migrate supabase/migrations/<file>'
  );
} else if (statusTarget() !== 'local') {
  const code = run('node', [statusScript, '--workdir', rootDir]);
  if (code !== 0) {
    log('✗ the linked target has pending (or unknown) migration status; not starting on it.');
    log(`  Apply with: yarn linked:migrate   or ${escape}`);
    process.exit(1);
  }
} else {
  const code = run('sh', [wrapper, 'pending']);
  if (code === 3) {
    log("✗ a window migration is pending. It is applied inside its runbook's window (writers");
    log(`  stopped, snapshot taken), never at startup. Run the window, then start; or ${escape}`);
    process.exit(1);
  }
  if (code !== 0) {
    log(`✗ pending migrations could not be applied (exit ${code}); not starting a server on a`);
    log(`  schema behind its code. Fix the cause above, or ${escape}`);
    process.exit(1);
  }
}

log('✓ Ready.');
