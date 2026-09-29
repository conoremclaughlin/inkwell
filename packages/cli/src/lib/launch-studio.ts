/**
 * The studio checklist at a launch (task 2841c7a9).
 *
 * `ink -a lumen` in a studio looks the studio up by path and scopes the
 * session to its row, but until 2026-09-29 it never read the checklist: a
 * studio created before the checklist existed, or revived onto a fresh
 * worktree, launched with no identity file and the human found out through
 * `ink status` saying "Agent: unresolved" while every hook booked the work
 * to the root studio. The server runs the checklist before each of its own
 * spawns; this is the same step for a launch from a terminal.
 *
 * The owner written into a missing identity file is the studio ROW's SB,
 * never the `-a` slug: `ink -a wren` in Lumen's studio must not make it
 * Wren's. Only a worktree with no row at all takes the launching slug, and
 * then the routine registers a row for it, as `ink init` there would.
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

export interface LaunchStudioDeps {
  placement?: (cwd: string) => WorktreePlacement;
  /** The studio row for a worktree path, or null when there is none or the server is unreachable. */
  lookupStudio?: (worktreePath: string) => Promise<LaunchStudioRow | null>;
  runInit?: typeof runInit;
}

export interface LaunchStudioResult {
  /** The routine ran because the checklist was incomplete. */
  ran: boolean;
  /** Who the identity file names when it was written. */
  owner?: string;
  missingBefore?: StudioCheckId[];
  report?: CompleteStudioReport;
}

/** The launcher's own lookup: get_studio by path, bounded, null on any failure. */
async function lookupStudioByPath(worktreePath: string): Promise<LaunchStudioRow | null> {
  try {
    const result = await callInkTool<{ studio?: { id?: string; sbSlug?: string } }>(
      'get_studio',
      { path: worktreePath },
      { timeoutMs: 3000 }
    );
    return result?.studio?.id
      ? { id: result.studio.id, ...(result.studio.sbSlug ? { sbSlug: result.studio.sbSlug } : {}) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the checklist for the worktree `cwd` is in and, when something is
 * missing from a linked worktree, run the completion routine with the row's
 * owner. The main worktree is never rewritten.
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

  const row = await (deps.lookupStudio ?? lookupStudioByPath)(placement.toplevel);
  const owner = row?.sbSlug || launchSlug;
  const report = await (deps.runInit ?? runInit)(placement.toplevel, {
    agent: owner,
    ...(row?.id ? { studioId: row.id } : {}),
  });
  return { ran: true, owner, missingBefore: audit.missing, report };
}

/** What a run changed, one line per written step. */
export function describeLaunchStudioResult(result: LaunchStudioResult): string[] {
  if (!result.ran || !result.report) return [];
  const changed = result.report.steps
    .filter((step) => step.status === 'created' || step.status === 'updated')
    .map((step) => step.label);
  const lines = [
    `Studio completed for ${result.owner}${changed.length ? `: ${changed.join(', ')}` : ''}`,
  ];
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
export async function completeStudioAtLaunch(cwd: string, launchSlug: string): Promise<void> {
  let result: LaunchStudioResult;
  try {
    result = await completeStudioForLaunch(cwd, launchSlug);
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
    missingBefore: result.missingBefore ?? [],
    complete: result.report?.audit.complete ?? null,
  });
  const [first, ...rest] = describeLaunchStudioResult(result);
  if (first) console.error(chalk.dim(first));
  for (const line of rest) console.error(chalk.yellow(`⚠ ${line}`));
}
