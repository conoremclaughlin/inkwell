/**
 * The studio checklist at a launch (task 2841c7a9).
 *
 * `ink -a lumen` in a studio looks the studio up by path and scopes the
 * session to its row, but until 2026-09-29 it never read the checklist: a
 * studio created before the checklist existed, or revived onto a fresh
 * worktree, launched with no identity file and the human found out through
 * `ink status` saying "Agent: unresolved" while every hook booked the work
 * to the root studio. The server runs the checklist before each of its own
 * spawns; this is the same step for a launch from a terminal, and the ink
 * chat runtime (`-b ink`, `ink chat`, `ink alpha`) runs it too.
 *
 * The owner written into a missing identity file is the studio ROW's SB,
 * never the launching slug: `ink -a wren` in Lumen's studio must not make
 * it Wren's. Only a worktree the server CONFIRMS has no row takes the
 * launching slug, and then the routine registers a row for it, as `ink
 * init` there would. When the server cannot say — unreachable, a timeout,
 * a refused credential — the owner is UNKNOWN and nothing that names an
 * owner is written: hooks and backend config are completed; identity,
 * registration and Claude permissions (whose profile is read from the same
 * row, and whose scratch paths name the owner) are left for a launch that
 * can ask. A guess
 * here is durable: completeStudio never replaces an owner it finds, so a
 * transient failure that wrote the visitor's slug would have kept it after
 * the server came back (Lumen, PR #699 round 1).
 *
 * Never throws: a launch is not refused because its repair failed. The
 * report is printed so the person at the terminal sees what changed.
 */

import chalk from 'chalk';
import { auditStudio, type StudioCheckId } from '@inklabs/shared';
import { detectWorktree, runInit, type WorktreePlacement } from '../commands/init.js';
import type { CompleteStudioReport, StepResult } from './studio-complete.js';
import { lookupStudioByPath, type StudioLookup, type StudioRowSummary } from './studio-lookup.js';
import { sbDebugLog } from './sb-debug.js';

/** The studio row a launch completes against (see studio-lookup.ts). */
export type LaunchStudioRow = StudioRowSummary;

/**
 * What the server said about the worktree: a row, confirmed none, or no
 * answer. Only the first two license an identity write, and only the first
 * names a permission profile.
 */
export type LaunchStudioLookup = StudioLookup;

export interface LaunchStudioDeps {
  placement?: (cwd: string) => WorktreePlacement;
  lookupStudio?: (worktreePath: string) => Promise<LaunchStudioLookup>;
  runInit?: typeof runInit;
}

export interface LaunchStudioResult {
  /** The routine ran because the checklist was incomplete. */
  ran: boolean;
  /** Who the identity file names when it was written. */
  owner?: string;
  /** The server could not say who owns the worktree; identity and registration were left alone. */
  ownerUnknown?: string;
  missingBefore?: StudioCheckId[];
  report?: CompleteStudioReport;
}

/**
 * Read the checklist for the worktree `cwd` is in and, when something is
 * missing from a linked worktree, run the completion routine: with the
 * row's owner when the server has one, with the launching slug when the
 * server confirms there is none, and with no identity or registration at
 * all when the server cannot say. The main worktree is never rewritten.
 */
export async function completeStudioForLaunch(
  cwd: string,
  launchSlug: string,
  deps: LaunchStudioDeps = {}
): Promise<LaunchStudioResult> {
  const placement = (deps.placement ?? detectWorktree)(cwd);
  if (!placement.linked || !placement.toplevel) return { ran: false };
  const audit = auditStudio(placement.toplevel, { linked: true });
  if (audit.complete) return { ran: false };

  const lookup = await (deps.lookupStudio ?? lookupStudioByPath)(placement.toplevel);
  const init = deps.runInit ?? runInit;
  if (lookup.status === 'unknown') {
    // No row, no profile: permissions are left for a launch that can ask,
    // as identity is. A guessed profile would be kept by every later run.
    const report = await init(placement.toplevel, {
      agent: launchSlug,
      studioSetup: false,
      permissions: false,
    });
    return { ran: true, ownerUnknown: lookup.reason, missingBefore: audit.missing, report };
  }
  const owner = (lookup.status === 'found' && lookup.row.sbSlug) || launchSlug;
  // Only a row names a profile. A worktree the server confirms has no row
  // gets identity and registration as ink init would, and no permissions:
  // in a detached PR checkout a default would be kept by every later run
  // (review 4177f7fe, P2 1).
  const profile = lookup.status === 'found' ? lookup.row.permissionProfile : undefined;
  const report = await init(placement.toplevel, {
    agent: owner,
    ...(lookup.status === 'found' && lookup.row.id ? { studioId: lookup.row.id } : {}),
    ...(profile ? { permissionProfile: profile } : { permissions: false }),
  });
  return { ran: true, owner, missingBefore: audit.missing, report };
}

/**
 * What a run wrote, created and updated named apart so a repaired file
 * (hooks under an older ink path, an identity with a field filled in) reads
 * as a repair and not as something the studio lacked.
 */
function describeStepsWritten(steps: StepResult[]): string {
  const labels = (status: StepResult['status']) =>
    steps.filter((step) => step.status === status).map((step) => step.label);
  const created = labels('created');
  const updated = labels('updated');
  return [
    created.length ? `created ${created.join(', ')}` : '',
    updated.length ? `updated ${updated.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/** What a run changed, one line per written step, and what it left for later. */
export function describeLaunchStudioResult(result: LaunchStudioResult): string[] {
  if (!result.ran || !result.report) return [];
  const changed = describeStepsWritten(result.report.steps);
  const lines: string[] = [];
  if (result.ownerUnknown) {
    lines.push(
      `Studio partly completed${changed ? ` (${changed})` : ''}; its owner is unknown because the server could not be asked (${result.ownerUnknown}). Identity and registration were left alone: run ink init when the server is reachable`
    );
    return lines;
  }
  lines.push(`Studio completed for ${result.owner}${changed ? `: ${changed}` : ''}`);
  if (!result.report.audit.complete) {
    lines.push(
      `Studio still incomplete (${result.report.audit.missing.join(', ')}). Run: ink init`
    );
  }
  return lines;
}

/**
 * The launcher's call: complete, print, never throw. Prints only when
 * something was done, so a complete studio adds nothing to the launch. The
 * lines go to stderr: `--session-candidates-json` keeps stdout for its
 * payload alone, and this runs before that diversion is installed.
 */
export async function completeStudioAtLaunch(
  cwd: string,
  launchSlug: string,
  deps: LaunchStudioDeps = {}
): Promise<void> {
  let result: LaunchStudioResult;
  try {
    result = await completeStudioForLaunch(cwd, launchSlug, deps);
  } catch (error) {
    sbDebugLog('sb', 'launch_studio_complete_failed', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      chalk.yellow('⚠ Could not complete this studio before launching. Repair: ink init')
    );
    return;
  }
  if (!result.ran) return;
  sbDebugLog('sb', 'launch_studio_completed', {
    cwd,
    owner: result.owner ?? null,
    ownerUnknown: result.ownerUnknown ?? null,
    missingBefore: result.missingBefore ?? [],
    complete: result.report?.audit.complete ?? null,
  });
  const lines = describeLaunchStudioResult(result);
  if (result.ownerUnknown) {
    for (const line of lines) console.error(chalk.yellow(`⚠ ${line}`));
    return;
  }
  const [first, ...rest] = lines;
  if (first) console.error(chalk.dim(first));
  for (const line of rest) console.error(chalk.yellow(`⚠ ${line}`));
}
