/**
 * Complete a studio worktree from the server (task c3b34be8).
 *
 * The server no longer writes studio files itself. `ink init`, run inside
 * the worktree, is the one routine every creator uses — identity, the
 * studio row, permissions, hooks and backend config for every backend — and
 * `auditStudio` (@inklabs/shared) is the one checklist that says whether a
 * worktree is complete. Before this, `create_studio` wrote `.mcp.json` and
 * Claude hooks but no identity file and no Codex or Gemini hooks, the
 * strategy service wrote Claude settings only, and a session spawned into
 * such a studio found it had no tools or booked its work to the root
 * studio.
 *
 * The CLI is this checkout's own build, resolved the way the hooks are
 * (`resolveInkCli`; `INK_CLI_PATH` overrides), never the global link. The
 * server passes the studio row id it already holds, so nothing registers
 * twice, and the CLI's registration path (create_studio with the git work
 * done) is only for studios the CLI created itself.
 */

import { execFile } from 'child_process';
import { lstatSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { auditStudio, type StudioCheckId } from '@inklabs/shared';
import { resolveInkCli, inkCliSpawn } from './ink-cli';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface CompleteStudioViaCliOptions {
  sbSlug: string;
  /**
   * The studio's owner, consulted by `ensureStudioComplete` only when the
   * checklist is incomplete: the SB being spawned into a studio is not always
   * the SB the studio belongs to, and the identity file names the owner.
   * Three answers: a slug; null when there is CONFIRMED no owner to consult
   * (no studio row, or a row that names none), in which case `sbSlug` is
   * written; a thrown error when the question could not be asked, in which
   * case nothing that names an owner is written — the routine runs with
   * studio setup off, because a guess is durable: completeStudio keeps an
   * owner it finds, so a transient lookup failure that wrote the spawning
   * SB would have kept it after the lookup recovered (Lumen, PR #699).
   */
  owner?: () => Promise<string | null | undefined>;
  /** The studio row this worktree is; recorded into identity.json, never re-registered. */
  studioId?: string;
  /**
   * The owner's backend (`claude`, `codex`, `gemini`, `ink`), recorded in
   * identity.json so the studio knows what its owner runs on. `ink init`
   * resolves it itself when absent.
   */
  backend?: string;
  purpose?: string;
  /** Default true: copy .mcp.json, .env.local and permissions from the main worktree. */
  rootSync?: boolean;
  /** Default true: write identity.json and record the studio row. */
  studioSetup?: boolean;
  timeoutMs?: number;
  /** For tests: the environment the CLI is resolved from and run with. */
  env?: NodeJS.ProcessEnv;
  /** For tests: where the resolver looks for this checkout's build (default: this module's checkout). */
  cliStartDir?: string;
}

export interface CompleteStudioViaCliResult {
  /** The CLI ran and reported. */
  ok: boolean;
  /** The checklist passed afterwards. */
  complete: boolean;
  missing: StudioCheckId[];
  error?: string;
}

interface InitReport {
  audit?: { complete?: boolean; missing?: StudioCheckId[] };
}

function parseReport(stdout: string): InitReport | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? (parsed as InitReport) : null;
  } catch {
    return null;
  }
}

/**
 * A linked worktree keeps a `.git` FILE pointing at the main repository's
 * `.git/worktrees/<name>`. Synchronous on purpose, like the checklist read
 * that follows it: the pre-spawn fast path (a complete studio, or a main
 * worktree) must confirm itself without a turn of the event loop. It sits
 * between the takeover write and the runner, where an awaited stat was
 * enough for a queued turn to reach the runner a tick later than the
 * turn-boundary tests expect (green here, red on the CI runner), and where
 * every real await widens the window nothing else is watching. One lstat
 * is microseconds; the repair itself, when needed, stays asynchronous.
 */
export function isLinkedWorktree(worktreePath: string): boolean {
  try {
    return lstatSync(join(worktreePath, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * Run `ink init --json` inside the worktree and read back its checklist.
 * Never throws: a missing CLI build or a failed run is reported, with the
 * checklist as it stands, and logged; the caller decides what a partial
 * studio means for it.
 */
export async function completeStudioViaCli(
  worktreePath: string,
  options: CompleteStudioViaCliOptions
): Promise<CompleteStudioViaCliResult> {
  const cli = resolveInkCli({ env: options.env, startDir: options.cliStartDir });
  if (!cli) {
    const audit = auditStudio(worktreePath, { linked: true });
    logger.warn('Studio left incomplete: no ink CLI build to run ink init with', {
      worktreePath,
      missing: audit.missing,
    });
    return {
      ok: false,
      complete: audit.complete,
      missing: audit.missing,
      error:
        'no ink CLI build in this checkout (yarn workspace @inklabs/cli build) and no INK_CLI_PATH',
    };
  }

  const spawn = inkCliSpawn(cli);
  const args = [
    ...spawn.args,
    'init',
    '--json',
    '--agent',
    options.sbSlug,
    ...(options.studioId ? ['--studio-id', options.studioId] : []),
    ...(options.backend ? ['--backend', options.backend] : []),
    ...(options.purpose ? ['--purpose', options.purpose] : []),
    ...(options.rootSync === false ? ['--no-root-sync'] : []),
    ...(options.studioSetup === false ? ['--no-studio-setup'] : []),
  ];

  let stdout = '';
  let failure: string | undefined;
  try {
    const result = await execFileAsync(spawn.command, args, {
      cwd: worktreePath,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    stdout = result.stdout;
  } catch (error) {
    // `ink init --json` exits 1 when the checklist is incomplete and still
    // prints the report; anything else is a failure to run it.
    const err = error as { stdout?: string; message?: string };
    stdout = typeof err.stdout === 'string' ? err.stdout : '';
    failure = err.message ?? String(error);
  }

  const report = parseReport(stdout);
  if (!report?.audit) {
    const audit = auditStudio(worktreePath, { linked: true });
    logger.warn('ink init did not report; studio checklist read directly', {
      worktreePath,
      missing: audit.missing,
      error: failure,
    });
    return {
      ok: false,
      complete: audit.complete,
      missing: audit.missing,
      error: failure ?? 'no report',
    };
  }
  const missing = report.audit.missing ?? [];
  const complete = report.audit.complete === true;
  if (!complete) {
    logger.warn('Studio completed with items missing', { worktreePath, missing });
  } else {
    logger.info('Studio complete', { worktreePath, sbSlug: options.sbSlug });
  }
  return { ok: true, complete, missing };
}

/**
 * The pre-spawn safety net: read the checklist, and only when something is
 * missing run the routine. A complete studio costs a few synchronous file
 * reads and no turn of the event loop (see isLinkedWorktree); the owner
 * lookup, when one is given, is paid only on the incomplete path.
 */
export async function ensureStudioComplete(
  worktreePath: string,
  options: CompleteStudioViaCliOptions
): Promise<CompleteStudioViaCliResult> {
  const linked = isLinkedWorktree(worktreePath);
  const audit = auditStudio(worktreePath, { linked });
  if (audit.complete) return { ok: true, complete: true, missing: [] };
  if (!linked) {
    // The main worktree is the operator's checkout: report, never rewrite it.
    logger.warn('Main worktree is missing studio items; not rewriting it', {
      worktreePath,
      missing: audit.missing,
    });
    return { ok: true, complete: false, missing: audit.missing };
  }
  const { owner, ...rest } = options;
  let ownerSlug: string | null | undefined = null;
  if (owner) {
    try {
      ownerSlug = await owner();
    } catch (err) {
      // No answer is not "no owner". Complete what needs no owner — hooks,
      // permissions, backend config — and leave identity and registration
      // for a spawn that can ask.
      logger.warn(
        'Studio owner could not be looked up; completing without identity or registration',
        {
          worktreePath,
          missing: audit.missing,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      return completeStudioViaCli(worktreePath, { ...rest, studioSetup: false });
    }
  }
  return completeStudioViaCli(worktreePath, {
    ...rest,
    sbSlug: ownerSlug || options.sbSlug,
  });
}
