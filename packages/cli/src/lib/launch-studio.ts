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
 * owner is written: hooks, permissions and backend config are completed,
 * identity and registration are left for a launch that can ask. A guess
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
import type { CompleteStudioReport } from './studio-complete.js';
import { callInkTool } from './ink-mcp.js';
import { sbDebugLog } from './sb-debug.js';

export interface LaunchStudioRow {
  id?: string;
  sbSlug?: string;
}

/**
 * What the server said about the worktree: a row, confirmed none, or no
 * answer. Only the first two license an identity write.
 */
export type LaunchStudioLookup =
  | { status: 'found'; row: LaunchStudioRow }
  | { status: 'none' }
  | { status: 'unknown'; reason: string };

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

/** The server's own words for a worktree it has no row for. */
const NOT_FOUND = /studio not found/i;

/**
 * The launcher's own lookup: get_studio by path, bounded. A "Studio not
 * found" from the server is the one answer that means none; every other
 * failure is no answer at all.
 */
async function lookupStudioByPath(worktreePath: string): Promise<LaunchStudioLookup> {
  try {
    const result = await callInkTool<{ studio?: { id?: string; sbSlug?: string } }>(
      'get_studio',
      { path: worktreePath },
      { timeoutMs: 3000 }
    );
    if (result?.studio?.id) {
      return {
        status: 'found',
        row: {
          id: result.studio.id,
          ...(result.studio.sbSlug ? { sbSlug: result.studio.sbSlug } : {}),
        },
      };
    }
    return { status: 'unknown', reason: 'the server returned no studio and no error' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (NOT_FOUND.test(message)) return { status: 'none' };
    return { status: 'unknown', reason: message };
  }
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
    const report = await init(placement.toplevel, { agent: launchSlug, studioSetup: false });
    return { ran: true, ownerUnknown: lookup.reason, missingBefore: audit.missing, report };
  }
  const owner = (lookup.status === 'found' && lookup.row.sbSlug) || launchSlug;
  const report = await init(placement.toplevel, {
    agent: owner,
    ...(lookup.status === 'found' && lookup.row.id ? { studioId: lookup.row.id } : {}),
  });
  return { ran: true, owner, missingBefore: audit.missing, report };
}

/** What a run changed, one line per written step, and what it left for later. */
export function describeLaunchStudioResult(result: LaunchStudioResult): string[] {
  if (!result.ran || !result.report) return [];
  const changed = result.report.steps
    .filter((step) => step.status === 'created' || step.status === 'updated')
    .map((step) => step.label);
  const lines: string[] = [];
  if (result.ownerUnknown) {
    lines.push(
      `Studio partly completed${changed.length ? ` (${changed.join(', ')})` : ''}; its owner is unknown because the server could not be asked (${result.ownerUnknown}). Identity and registration were left alone: run ink init when the server is reachable`
    );
    return lines;
  }
  lines.push(
    `Studio completed for ${result.owner}${changed.length ? `: ${changed.join(', ')}` : ''}`
  );
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
