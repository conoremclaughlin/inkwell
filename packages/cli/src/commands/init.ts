/**
 * Init Command
 *
 * Set up a repo for Ink: install hooks, create default .mcp.json,
 * ensure .ink/ directory. Idempotent — skips steps already done.
 *
 * In a LINKED worktree (a studio) it is the repair: it runs the same
 * completion routine every creator runs (task c3b34be8), so a studio that
 * came up partial — no identity, no permissions, no Codex hooks — is made
 * whole by `cd`ing into it and running `ink init`. By default it syncs
 * `.mcp.json`, `.env.local` and the Claude permissions from the main
 * worktree (`--no-root-sync` generates defaults instead) and writes the
 * identity file and registers the studio row (`--no-studio-setup` for a
 * checkout deliberately not tracked as a studio). In the main worktree it
 * behaves as it always has: hooks, backend config, skills.
 *
 * Commands:
 *   init    Initialize Ink in the current repo
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { basename, dirname } from 'path';
import { loadAuth, decodeJwtPayload, isTokenExpired } from '../auth/tokens.js';
import { readIdentityJson, resolveSlug } from '../backends/identity.js';
import { lookupAgentBackend } from '../backends/agent-backend.js';
import {
  completeStudio,
  type CompleteStudioOptions,
  type CompleteStudioReport,
  type StepResult,
} from '../lib/studio-complete.js';

// ============================================================================
// Where are we: the main worktree, a linked worktree, or no repository
// ============================================================================

export interface WorktreePlacement {
  /** The git toplevel of cwd, or null outside a repository. */
  toplevel: string | null;
  /** The main worktree when cwd is a linked worktree; null otherwise. */
  mainRoot: string | null;
  linked: boolean;
  branch?: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A linked worktree has its own git dir under the main worktree's
 * `.git/worktrees/<name>`; the common dir is the main worktree's `.git`.
 * When the two differ, cwd is a studio and the main worktree is the common
 * dir's parent.
 */
export function detectWorktree(cwd: string): WorktreePlacement {
  const toplevel = git(['rev-parse', '--show-toplevel'], cwd);
  if (!toplevel) return { toplevel: null, mainRoot: null, linked: false };
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? undefined;
  const linked = !!gitDir && !!commonDir && gitDir !== commonDir;
  return {
    toplevel,
    mainRoot: linked && commonDir ? dirname(commonDir) : null,
    linked,
    ...(branch ? { branch } : {}),
  };
}

// ============================================================================
// The run
// ============================================================================

export interface InitOptions {
  force?: boolean;
  agent?: string;
  studioId?: string;
  /** The owner's backend for the identity file; resolved from their record when absent. */
  backend?: string;
  purpose?: string;
  /** commander: `--no-root-sync` sets rootSync=false; absent means true. */
  rootSync?: boolean;
  /** commander: `--no-studio-setup` sets studioSetup=false; absent means true. */
  studioSetup?: boolean;
  json?: boolean;
}

export interface InitDeps {
  placement?: (cwd: string) => WorktreePlacement;
  register?: CompleteStudioOptions['register'];
  syncSkills?: CompleteStudioOptions['syncSkills'];
  /**
   * The backend an SB runs on, for the identity file (default: the server's
   * identity record through `lookupAgentBackend`, cached). Undefined when
   * unknown, unrunnable or ambiguous; nothing is recorded then.
   */
  lookupBackend?: (sbSlug: string) => Promise<string | undefined>;
}

/**
 * The owner's backend from their identity record, when this CLI can launch
 * it. A record naming a backend this CLI has no adapter for is not written
 * into identity.json, because `resolveBackend` would hand that name to
 * `getBackend` at the next launch and fail where the record's own lookup
 * falls back instead.
 */
async function lookupOwnerBackend(sbSlug: string): Promise<string | undefined> {
  try {
    return (await lookupAgentBackend(sbSlug)).backend;
  } catch {
    return undefined;
  }
}

/** The studio name a worktree folder carries after the repository's `--`. */
export function studioNameFromPath(worktreePath: string): string | undefined {
  const folder = basename(worktreePath);
  const idx = folder.indexOf('--');
  return idx === -1 ? undefined : folder.slice(idx + 2) || undefined;
}

/**
 * Run init on a directory and return the report. Exported for tests and
 * for the server, which runs `ink init --json` in a studio it created.
 */
export async function runInit(
  cwd: string,
  options: InitOptions = {},
  deps: InitDeps = {}
): Promise<CompleteStudioReport> {
  const placement = (deps.placement ?? detectWorktree)(cwd);
  // The worktree is completed at its root: run from packages/api, the
  // identity and config belong at the top level, not beside the package
  // (Lumen, PR #692 round 1).
  const target = placement.toplevel ?? cwd;
  const identity = readIdentityJson(target);
  const sbSlug = options.agent || identity?.sbSlug || resolveSlug() || 'sb';
  const studioSetup = options.studioSetup !== false;
  // The studio knows what its owner runs on (Conor, 2026-09-29: a Codex SB's
  // studio should say so, and still carry every backend's config). Given
  // explicitly, or resolved from the owner's identity record once, when the
  // identity file is about to be written or lacks it. Never overwrites.
  const backend =
    options.backend ||
    (placement.linked && studioSetup && !identity?.backend
      ? await (deps.lookupBackend ?? lookupOwnerBackend)(sbSlug)
      : undefined);
  return completeStudio(target, {
    sbSlug,
    mainRoot: placement.mainRoot,
    rootSync: options.rootSync !== false,
    studioSetup,
    ...(placement.linked ? { studioName: studioNameFromPath(target) } : {}),
    ...(placement.branch ? { branch: placement.branch } : {}),
    ...(backend ? { backend } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.studioId ? { studioId: options.studioId } : {}),
    ...(options.force ? { force: true } : {}),
    ...(deps.register ? { register: deps.register } : {}),
    ...(deps.syncSkills ? { syncSkills: deps.syncSkills } : {}),
  });
}

// ============================================================================
// Command
// ============================================================================

function printStep(step: StepResult): void {
  const icon =
    step.status === 'created' || step.status === 'updated'
      ? chalk.green('✓')
      : step.status === 'exists'
        ? chalk.dim('·')
        : step.status === 'failed'
          ? chalk.red('✗')
          : chalk.yellow('○');
  const statusText =
    step.status === 'created'
      ? chalk.green(step.status)
      : step.status === 'updated'
        ? chalk.cyan(step.status)
        : step.status === 'exists'
          ? chalk.dim(step.status)
          : step.status === 'failed'
            ? chalk.red(step.status)
            : chalk.yellow(step.status);
  const detail = step.detail ? chalk.dim(` (${step.detail})`) : '';
  console.log(`  ${icon} ${step.label}: ${statusText}${detail}`);
}

async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const placement = detectWorktree(cwd);

  if (options.json) {
    const report = await runInit(cwd, options, { placement: () => placement });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.audit.complete ? 0 : 1);
  }

  console.log(chalk.bold('\nInitializing Inkwell...\n'));

  const auth = loadAuth();
  const authenticated = Boolean(auth && !isTokenExpired(auth));
  if (authenticated && auth) {
    const payload = decodeJwtPayload(auth.access_token);
    console.log(chalk.dim(`  User: ${payload?.email || 'authenticated'}`));
  } else {
    console.log(chalk.yellow('  Not authenticated. Run: ink auth login'));
    console.log(
      chalk.dim('  No account yet? Same command — the page it opens has a sign-up link.')
    );
  }
  if (placement.linked) {
    console.log(chalk.dim(`  Studio: linked worktree of ${placement.mainRoot}`));
  }
  console.log('');

  const report = await runInit(cwd, options, { placement: () => placement });
  for (const step of report.steps) printStep(step);

  if (placement.linked) {
    console.log('');
    console.log(chalk.bold('Studio checklist'));
    for (const check of report.audit.checks) {
      const icon = check.ok
        ? chalk.green('✓')
        : check.required
          ? chalk.red('✗')
          : chalk.yellow('○');
      console.log(`  ${icon} ${check.label}${chalk.dim(` (${check.detail})`)}`);
    }
    if (!report.audit.complete) {
      console.log(
        chalk.yellow(
          `\nIncomplete: ${report.audit.missing.join(', ')}. Fix the cause above and run ink init again.`
        )
      );
      process.exitCode = 1;
      return;
    }
  }

  if (authenticated) {
    console.log(chalk.dim('\nDone.'));
    if (!placement.linked) {
      console.log(
        chalk.dim('Next: ') + chalk.cyan('ink awaken') + chalk.dim(' to meet your first SB.')
      );
    }
    return;
  }

  // Deliberately not "Done." — the repo is set up but unusable until there is
  // an account behind it, and reporting unqualified success here is what sent
  // the reporter of #331 one command further before anything told them.
  console.log(chalk.yellow('\nRepo is set up, but Inkwell is not signed in yet.'));
  console.log(chalk.dim('  Nothing above talks to the server until you authenticate.'));
  console.log(
    chalk.dim('  Next: ') +
      chalk.cyan('ink auth login') +
      chalk.dim(', then ') +
      chalk.cyan('ink awaken')
  );
  process.exitCode = 1;
}

// ============================================================================
// Register
// ============================================================================

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Initialize Inkwell in the current repo (hooks, .mcp.json, backend configs, skills); in a studio worktree, complete or repair it'
    )
    .option('-f, --force', 'Overwrite existing hooks even if non-Inkwell hooks are present')
    .option('-a, --agent <slug>', 'SB slug for the studio identity (default: resolved identity)')
    .option('--studio-id <uuid>', 'An existing studio row to record instead of registering one')
    .option(
      '-b, --backend <name>',
      "The owner's backend recorded in identity.json (default: their identity record)"
    )
    .option('-p, --purpose <desc>', 'Purpose recorded on the studio identity and row')
    .option(
      '--no-root-sync',
      'Generate default .mcp.json and permissions instead of copying them from the main worktree'
    )
    .option(
      '--no-studio-setup',
      'Skip the identity file and studio registration (a checkout deliberately not tracked as a studio)'
    )
    .option('--json', 'Print the report as JSON (used by the server)')
    .action(initCommand);
}
