/**
 * Studio Handlers
 *
 * MCP tools for managing git worktree studios. Enables agents to create
 * isolated worktrees for parallel work, track their lifecycle, and link
 * them to sessions for context continuity.
 */

import { z } from 'zod';
import path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { access } from 'fs/promises';

const execFileAsync = promisify(execFile);
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import { bootstrapStudio } from '@inklabs/shared';
import { ensureStudioSettings } from '../../services/studio-settings';
import { resolveMainStudio } from '../../services/sessions/session-service';
import {
  StudioLeaseService,
  captureWorktreeState,
  rescueSucceeded,
  worktreePresent,
} from '../../services/studio-lease.service';

// ============== Helpers ==============

/**
 * Resolve the main git worktree root from any path (worktree or main repo).
 * If the given path is a linked worktree, returns the main worktree root.
 * Falls back to the original path if git fails or isn't available.
 */
function resolveMainWorktree(dir: string): string {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // First entry in `git worktree list` is always the main worktree
    const match = output.match(/^worktree\s+(.+)$/m);
    return match ? match[1] : dir;
  } catch {
    return dir;
  }
}

// ============== Constants ==============

const WORK_TYPE_ABBREV: Record<string, string> = {
  feature: 'feat',
  bugfix: 'fix',
  refactor: 'refactor',
  chore: 'chore',
  experiment: 'exp',
  other: 'other',
};

// ============== Schemas ==============

const createStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID creating the studio (e.g., "wren")'),
  repoRoot: z.string().describe('Absolute path to the main repository root'),
  slug: z
    .string()
    .describe('Short slug for the studio (used in branch name and worktree directory)'),
  workType: z
    .enum(['feature', 'bugfix', 'refactor', 'chore', 'experiment', 'other'])
    .optional()
    .default('feature')
    .describe('Type of work being done in this studio'),
  purpose: z.string().optional().describe('Human-readable description of what this studio is for'),
  baseBranch: z.string().optional().default('main').describe('Branch to base the new worktree on'),
  sessionId: z.string().uuid().optional().describe('Session ID to link to this studio'),
  roleTemplate: z
    .string()
    .optional()
    .describe('Role template name used when creating the studio (e.g., "reviewer", "builder")'),
  defaultProjectId: z
    .string()
    .uuid()
    .optional()
    .describe('Default project ID for task groups created in this studio'),
  skipGitOperations: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, skip git worktree creation (useful when worktree already exists)'),
});

const listStudiosSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Filter by agent ID'),
  status: z
    .enum(['active', 'idle', 'archived', 'cleaned', 'all'])
    .optional()
    .default('all')
    .describe('Filter by studio status'),
  includeAll: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, include all statuses including cleaned'),
});

const getStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().uuid().optional().describe('Studio UUID'),
  branch: z.string().optional().describe('Branch name to look up'),
  path: z.string().optional().describe('Worktree path to look up'),
  agentId: z
    .string()
    .optional()
    .describe('Agent ID to disambiguate when multiple agents share the same branch or path'),
});

const updateStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().uuid().describe('Studio UUID to update'),
  agentId: z.string().describe('Agent ID making the update'),
  status: z.enum(['active', 'idle', 'archived']).optional().describe('New studio status'),
  purpose: z.string().optional().describe('Updated purpose description'),
  roleTemplate: z.string().optional().describe('Role template name to set'),
  worktreePath: z.string().optional().describe('Updated worktree path (after rename/move)'),
  slug: z.string().optional().describe('Updated studio slug'),
  sessionId: z.string().uuid().optional().describe('Session ID to link'),
  unlinkSession: z
    .boolean()
    .optional()
    .describe('If true, unlink the current session and set status to idle'),
  defaultProjectId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('Default project ID for task groups created in this studio. Set to null to clear.'),
  routePatterns: z
    .array(z.string().max(200))
    .optional()
    .describe(
      'ThreadKey glob patterns this studio handles for trigger routing. Examples: "pr:*", "spec:*", "branch:wren/feat/auth". Use "*" for catch-all (one per agent). Replaces existing patterns.'
    ),
  // NOTE: sandbox_bypass is intentionally NOT exposed via MCP tools — it's a
  // security-sensitive setting that should only be changed via admin API
  // endpoints or the web dashboard (future: /individuals/<id> settings page).
});

const closeStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().uuid().describe('Studio UUID to close'),
  agentId: z.string().describe('Agent ID closing the studio'),
  removeWorktree: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true, remove the git worktree from disk'),
  deleteBranch: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, delete the associated git branch'),
});

const adoptStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID adopting the studio'),
  sessionId: z.string().uuid().describe('Session ID to link to the studio'),
  studioId: z.string().uuid().optional().describe('Studio UUID to adopt'),
  branch: z.string().optional().describe('Branch name to look up the studio'),
  worktreePath: z.string().optional().describe('Worktree path to look up the studio'),
  routePatterns: z
    .array(z.string().max(200))
    .optional()
    .describe('ThreadKey glob patterns this studio handles. Sets initial patterns on adoption.'),
});

// ============== Helpers ==============

function successResponse(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, ...data }),
      },
    ],
  };
}

function errorResponse(error: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error }),
      },
    ],
    isError: true,
  };
}

// ============== Handlers ==============

export async function handleCreateStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = createStudioSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    agentId,
    repoRoot,
    slug,
    workType = 'feature',
    purpose,
    baseBranch = 'main',
    sessionId,
    roleTemplate,
    defaultProjectId,
    skipGitOperations = false,
  } = parsed;

  if (defaultProjectId) {
    const project = await dataComposer.repositories.projects.findById(defaultProjectId);
    if (!project || project.user_id !== resolved.user.id) {
      return errorResponse('defaultProjectId not found or does not belong to this user');
    }
  }

  // Resolve to the main worktree root (handles case where repoRoot is a linked worktree)
  const mainRoot = resolveMainWorktree(repoRoot);

  // Derive branch name and worktree path (sibling of the main repo root)
  const abbrev = WORK_TYPE_ABBREV[workType] || 'other';
  const branch = `${agentId}/${abbrev}/${slug}`;
  const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);

  // Perform git operations if not skipped
  if (!skipGitOperations) {
    try {
      logger.info('Creating git worktree', { branch, worktreePath, baseBranch, repoRoot });
      execSync(`git worktree add -b ${branch} ${worktreePath} ${baseBranch}`, {
        cwd: repoRoot,
        stdio: 'pipe',
      });

      // Install dependencies if package.json exists
      if (existsSync(path.join(worktreePath, 'package.json'))) {
        logger.info('Installing dependencies in worktree', { worktreePath });
        execSync('yarn install', {
          cwd: worktreePath,
          stdio: 'pipe',
        });
      }

      // Seed local config the same way `ink studio new` does. .mcp.json and
      // .env.local are gitignored, so `git worktree add` brings neither —
      // without this the studio has no MCP config at all: Claude sessions get
      // no tools, and Codex spawns against a partial [mcp_servers.inkwell]
      // and dies on "invalid transport". Copy from the resolved main root, not
      // the caller's repoRoot — a linked-worktree caller would otherwise seed
      // the new studio from its own (possibly customised or missing) config.
      // Best-effort; a studio that fails to bootstrap is still a usable
      // worktree.
      try {
        const result = bootstrapStudio(mainRoot, worktreePath);
        logger.info('Bootstrapped studio config', {
          worktreePath,
          copied: result.copied,
          codex: result.codex,
          gemini: result.gemini,
        });
      } catch (bootstrapError) {
        logger.warn('Studio config bootstrap failed', {
          worktreePath,
          error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
        });
      }
    } catch (gitError) {
      const errorMessage = gitError instanceof Error ? gitError.message : String(gitError);
      logger.error('Git worktree creation failed', { error: errorMessage, branch, worktreePath });
      return errorResponse(`Failed to create git worktree: ${errorMessage}`);
    }
  }

  // Generate .claude/settings.local.json with default permissions + hooks
  try {
    await ensureStudioSettings(worktreePath);
  } catch (settingsError) {
    // Non-fatal — studio is usable without auto-generated settings
    logger.warn('Failed to generate studio settings', {
      worktreePath,
      error: settingsError instanceof Error ? settingsError.message : String(settingsError),
    });
  }

  // Insert studio record into the database
  let studio;
  try {
    studio = await dataComposer.repositories.studios.create({
      userId: resolved.user.id,
      agentId,
      sessionId,
      repoRoot: mainRoot,
      worktreePath,
      branch,
      baseBranch,
      purpose,
      workType,
      roleTemplate,
      defaultProjectId,
    });
  } catch (dbError) {
    // If DB insert fails but git succeeded, attempt cleanup
    if (!skipGitOperations) {
      try {
        logger.warn('DB insert failed, cleaning up worktree', { worktreePath });
        execSync(`git worktree remove ${worktreePath}`, {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (cleanupError) {
        logger.error('Failed to clean up worktree after DB error', {
          worktreePath,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
    return errorResponse(`Failed to save studio record: ${errorMessage}`);
  }

  logger.info('Studio created', {
    studioId: studio.id,
    branch,
    worktreePath,
    agentId,
  });

  return successResponse({
    message: `Studio created at ${worktreePath}`,
    studio: {
      id: studio.id,
      studioId: studio.id,
      agentId: studio.agentId,
      branch: studio.branch,
      worktreeFolder: path.basename(studio.worktreePath),
      worktreePath: studio.worktreePath,
      repoRoot: studio.repoRoot,
      baseBranch: studio.baseBranch,
      purpose: studio.purpose,
      workType: studio.workType,
      roleTemplate: studio.roleTemplate,
      defaultProjectId: studio.defaultProjectId,
      status: studio.status,
      sessionId: studio.sessionId,
      createdAt: studio.createdAt,
    },
  });
}

export async function handleListStudios(args: unknown, dataComposer: DataComposer) {
  const parsed = listStudiosSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, status = 'all', includeAll = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  let studios;
  if (status !== 'all') {
    studios = await studiosRepo.listByUser(resolved.user.id, {
      status: status as 'active' | 'idle' | 'archived' | 'cleaned',
      agentId: agentId || undefined,
    });
  } else if (includeAll) {
    studios = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
  } else {
    // Default: get all but exclude 'cleaned'
    const all = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
    studios = all.filter((w) => w.status !== 'cleaned');
  }

  return successResponse({
    count: studios.length,
    studios: studios.map((w) => ({
      id: w.id,
      studioId: w.id,
      agentId: w.agentId,
      branch: w.branch,
      worktreePath: w.worktreePath,
      worktreeFolder: path.basename(w.worktreePath),
      path: w.worktreePath,
      purpose: w.purpose,
      status: w.status,
      workType: w.workType,
      roleTemplate: w.roleTemplate,
      defaultProjectId: w.defaultProjectId,
      hasLinkedSession: !!w.sessionId,
      // Occupancy: lease is the authoritative "is someone working here" —
      // status stays 'active' regardless of use and must not be read as such.
      lease: w.lease,
      ephemeral: w.ephemeral,
      parentStudioId: w.parentStudioId,
      expiresAt: w.expiresAt,
      createdAt: w.createdAt,
    })),
  });
}

export async function handleGetStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = getStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  const studiosRepo = dataComposer.repositories.studios;
  const scope = { userId: user.id, agentId: parsed.agentId };
  let studio = null;

  // Try identifiers in order: studioId, branch, path
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch, scope);
  } else if (parsed.path) {
    studio = await studiosRepo.findByPath(parsed.path, scope);
  } else {
    return errorResponse('Must provide at least one of: studioId, branch, or path');
  }

  if (!studio) {
    return errorResponse('Studio not found');
  }

  return successResponse({
    studio: {
      id: studio.id,
      studioId: studio.id,
      agentId: studio.agentId,
      branch: studio.branch,
      worktreeFolder: path.basename(studio.worktreePath),
      worktreePath: studio.worktreePath,
      repoRoot: studio.repoRoot,
      baseBranch: studio.baseBranch,
      purpose: studio.purpose,
      workType: studio.workType,
      roleTemplate: studio.roleTemplate,
      defaultProjectId: studio.defaultProjectId,
      status: studio.status,
      sessionId: studio.sessionId,
      lease: studio.lease,
      ephemeral: studio.ephemeral,
      parentStudioId: studio.parentStudioId,
      expiresAt: studio.expiresAt,
      metadata: studio.metadata,
      createdAt: studio.createdAt,
      updatedAt: studio.updatedAt,
      archivedAt: studio.archivedAt,
      cleanedAt: studio.cleanedAt,
    },
  });
}

export async function handleUpdateStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = updateStudioSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    studioId,
    agentId,
    status,
    purpose,
    roleTemplate,
    worktreePath,
    slug,
    sessionId,
    unlinkSession,
    defaultProjectId,
    routePatterns,
  } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists and belongs to this user
  const existing = await studiosRepo.findById(studioId);
  if (!existing) {
    return errorResponse(`Studio not found: ${studioId}`);
  }
  if (existing.userId !== resolved.user.id) {
    return errorResponse(`Studio not found: ${studioId}`);
  }

  if (typeof defaultProjectId === 'string') {
    const project = await dataComposer.repositories.projects.findById(defaultProjectId);
    if (!project || project.user_id !== resolved.user.id) {
      return errorResponse('defaultProjectId not found or does not belong to this user');
    }
  }

  let updated;

  if (unlinkSession) {
    updated = await studiosRepo.unlinkSession(studioId);
  } else if (sessionId) {
    updated = await studiosRepo.linkSession(studioId, sessionId);
  } else {
    const updateObj: Record<string, unknown> = {};
    if (status !== undefined) {
      updateObj.status = status;
    }
    if (purpose !== undefined) {
      updateObj.purpose = purpose;
    }
    if (roleTemplate !== undefined) {
      updateObj.roleTemplate = roleTemplate;
    }
    if (worktreePath !== undefined) {
      updateObj.worktreePath = worktreePath;
    }
    if (slug !== undefined) {
      updateObj.slug = slug;
    }
    if (defaultProjectId !== undefined) {
      updateObj.defaultProjectId = defaultProjectId;
    }
    if (routePatterns !== undefined) {
      updateObj.routePatterns = routePatterns;
    }
    updated = await studiosRepo.update(studioId, updateObj);
  }

  logger.info('Studio updated', { studioId, agentId, status: updated.status });

  return successResponse({
    message: 'Studio updated',
    studio: {
      id: updated.id,
      studioId: updated.id,
      agentId: updated.agentId,
      branch: updated.branch,
      worktreeFolder: path.basename(updated.worktreePath),
      worktreePath: updated.worktreePath,
      purpose: updated.purpose,
      roleTemplate: updated.roleTemplate,
      defaultProjectId: updated.defaultProjectId,
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function handleCloseStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = closeStudioSchema.parse(args);
  const { user: closingUser } = await resolveUserOrThrow(parsed, dataComposer);

  const { studioId, agentId, removeWorktree = true, deleteBranch = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists AND belongs to the closing user — repository lookups
  // are id-only, and close is destructive.
  const studio = await studiosRepo.findById(studioId);
  if (!studio || studio.userId !== closingUser.id) {
    return errorResponse(`Studio not found: ${studioId}`);
  }

  const cleanupResults: { worktreeRemoved: boolean; branchDeleted: boolean; errors: string[] } = {
    worktreeRemoved: false,
    branchDeleted: false,
    errors: [],
  };

  // Release any lease before touching the worktree — closing the studio is a
  // terminal act for its occupant, and release captures final branch/commit
  // state while the worktree still exists. A holder without a safe
  // terminal/stale proof refuses the whole close (lease marked
  // pendingRelease; re-run close after the holder's boundary frees it).
  const leaseService = new StudioLeaseService(dataComposer.getClient());
  const releaseOutcome = await leaseService
    .releaseByStudio(studioId, { userId: closingUser.id, reason: 'studio-closed' })
    .catch((leaseErr: unknown) => {
      logger.warn('[StudioLease] Release on close_studio failed', {
        studioId,
        error: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
      });
      return 'none' as const;
    });
  if (releaseOutcome === 'deferred') {
    return errorResponse(
      `Studio ${studioId} is in use by a live session. Its lease is marked for release at the holder's turn boundary — close the studio again once the session has finished.`
    );
  }
  // 'none' is NOT proof of vacancy — it also covers quarantine, a lost CAS,
  // and the caught release error. Never destroy on ambiguity.
  const residual = await leaseService.getLease(studioId, closingUser.id);
  if (residual?.lease) {
    // Reconciliation (idempotent): a quarantined claim over an ALREADY-ABSENT
    // worktree means destruction happened but the cleaned record didn't land
    // (a prior close's markCleaned failed, or the cwd vanished externally).
    // Nothing is left to protect — record cleaned and clear the exact claim.
    const worktreeGone = !(await access(studio.worktreePath)
      .then(() => true)
      .catch(() => false));
    if (residual.lease.quarantined && worktreeGone) {
      // ONE user+exact-claim-guarded CAS finalizes status/cleaned_at/lease
      // together — a claim replaced between observation and finalization
      // makes this fail, and failure is reported, never masked as success.
      const finalized = await leaseService.finalizeTeardown(
        studioId,
        closingUser.id,
        residual.lease
      );
      if (!finalized) {
        return errorResponse(
          `Studio ${studioId} reconciliation failed: the quarantine claim changed underneath (or the write failed). Nothing was recorded; retry close_studio.`
        );
      }
      logger.info('[StudioLease] close_studio reconciled an interrupted teardown', { studioId });
      return successResponse({
        message: 'Studio close reconciled: worktree already absent; cleaned state recorded',
        studioId,
        status: 'cleaned',
        cleanup: { worktreeRemoved: true, branchDeleted: false, errors: [] },
      });
    }
    return errorResponse(
      `Studio ${studioId} has a ${residual.lease.quarantined ? 'quarantined' : 'contended'} lease; refusing to close. Resolve the lease state first.`
    );
  }

  // Fence the destructive window: hold a unique teardown claim across
  // removal and mark-cleaned so no acquire can win the studio between the
  // release above and the removal below.
  const claim = await leaseService.claimForTeardown(studioId, closingUser.id, {
    reason: 'close_studio',
  });
  if (!claim) {
    return errorResponse(
      `Studio ${studioId} became occupied while closing; aborting. Retry once it is free.`
    );
  }

  // Claim lifecycle: cleared ONLY when the studio ends in a coherent state —
  // either nothing destructive happened (aborts below) or the cleaned state
  // is durably recorded. If the worktree was removed but persistence failed,
  // the claim STAYS so routing cannot acquire a studio whose cwd is gone.
  const abortKeepingStudioUsable = async (message: string) => {
    await leaseService.clearTeardownClaim(studioId, closingUser.id, claim).catch(() => undefined);
    return errorResponse(message);
  };

  // Remove the git worktree. Argument arrays (never shell interpolation —
  // stored paths/branches must not reach a shell) and async exec/fs — this
  // is a tool handler on the API server's single event loop.
  if (removeWorktree) {
    // Token revalidation immediately before destruction.
    if (!(await leaseService.verifyClaim(studioId, closingUser.id, claim))) {
      return errorResponse(`Studio ${studioId} teardown claim was lost; aborting close.`);
    }

    // Rescue BEFORE removal, fail closed (Lumen, PR #563 P1). Ephemeral
    // worktrees are detached: a CLEAN tree can still hold commits reachable
    // from no branch, and `git worktree remove` deletes them without
    // complaint — captureWorktreeState anchors those under ink-rescue/* and
    // stashes anything dirty. A failed rescue aborts with the studio intact.
    // An absent worktree has nothing to rescue: its capture error is not a
    // failed rescue, and the removal below already tolerates it.
    if (await worktreePresent(studio.worktreePath)) {
      const rescue = await captureWorktreeState(studio.worktreePath, {
        rescue: true,
        rescueLabel: `close:${studio.slug || studioId}`,
      });
      if (!rescueSucceeded(rescue)) {
        return abortKeepingStudioUsable(
          `Studio ${studioId} close aborted: work rescue failed (${rescue.error || 'unknown'}); worktree untouched.`
        );
      }
    }

    try {
      await execFileAsync('git', ['worktree', 'remove', '--', studio.worktreePath], {
        cwd: studio.repoRoot,
      });
      cleanupResults.worktreeRemoved = true;
    } catch (worktreeError) {
      const errorMessage =
        worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
      logger.warn('Failed to remove worktree (may already be gone)', {
        worktreePath: studio.worktreePath,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Worktree removal: ${errorMessage}`);
    }
    // Only a confirmed-absent worktree may be recorded as cleaned.
    const stillPresent = await access(studio.worktreePath)
      .then(() => true)
      .catch(() => false);
    if (!cleanupResults.worktreeRemoved && stillPresent) {
      // Nothing was destroyed — the studio is still usable; free the claim.
      return abortKeepingStudioUsable(
        `Worktree removal failed and ${studio.worktreePath} still exists; studio NOT marked cleaned. Errors: ${cleanupResults.errors.join('; ')}`
      );
    }
    cleanupResults.worktreeRemoved = true;
  }

  // Delete the branch
  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-d', '--', studio.branch], {
        cwd: studio.repoRoot,
      });
      cleanupResults.branchDeleted = true;
    } catch (branchError) {
      const errorMessage = branchError instanceof Error ? branchError.message : String(branchError);
      logger.warn('Failed to delete branch', {
        branch: studio.branch,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Branch deletion: ${errorMessage}`);
    }
  }

  // Mark as cleaned in the database (ownership verified above). If this
  // write fails AFTER the worktree was destroyed, the claim must survive —
  // an active/vacant row pointing at a deleted cwd would be routable.
  // Re-running close_studio (or the sweep) reconciles via the
  // quarantine+absent-worktree path above. When nothing destructive
  // happened (removeWorktree: false), the claim is freed instead — the
  // studio is fully intact and must stay usable.
  //
  // Finalization is ONE user+exact-claim-guarded CAS setting status,
  // cleaned_at, and lease NULL together — no separate markCleaned + clear
  // steps a claim replacement could interleave with.
  const finalized = await leaseService.finalizeTeardown(studioId, closingUser.id, claim);
  if (!finalized) {
    if (!removeWorktree) {
      await leaseService.clearTeardownClaim(studioId, closingUser.id, claim).catch(() => undefined);
      return errorResponse(
        `Studio ${studioId} could not be marked cleaned (claim changed or write failed). Nothing was removed; the studio remains usable.`
      );
    }
    logger.error(
      '[StudioLease] close_studio destroyed the worktree but could not finalize cleaned; keeping teardown claim as quarantine',
      { studioId }
    );
    return errorResponse(
      `Studio ${studioId} worktree was removed but the cleaned state could not be recorded. The teardown claim is kept so nothing can route here; re-run close_studio to reconcile.`
    );
  }

  logger.info('Studio closed', {
    studioId,
    agentId,
    worktreeRemoved: cleanupResults.worktreeRemoved,
    branchDeleted: cleanupResults.branchDeleted,
  });

  return successResponse({
    message: 'Studio closed and marked as cleaned',
    studioId,
    status: 'cleaned',
    cleanup: cleanupResults,
  });
}

export async function handleAdoptStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = adoptStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, sessionId, routePatterns } = parsed;
  const studiosRepo = dataComposer.repositories.studios;
  const scope = { userId: user.id, agentId };

  // Find studio by ID, branch, or path
  let studio = null;
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch, scope);
  } else if (parsed.worktreePath) {
    studio = await studiosRepo.findByPath(parsed.worktreePath, scope);
  } else {
    return errorResponse('Must provide at least one of: studioId, branch, or worktreePath');
  }

  if (!studio) {
    return errorResponse('Studio not found');
  }

  // Ensure settings exist in the worktree (may be first time adopting an old studio)
  try {
    await ensureStudioSettings(studio.worktreePath);
  } catch (settingsError) {
    logger.warn('Failed to ensure studio settings on adopt', {
      worktreePath: studio.worktreePath,
      error: settingsError instanceof Error ? settingsError.message : String(settingsError),
    });
  }

  // Link session and set to active
  let updated = await studiosRepo.linkSession(studio.id, sessionId);

  // Set route patterns if provided
  if (routePatterns !== undefined) {
    updated = await studiosRepo.update(studio.id, { routePatterns });
  }

  logger.info('Studio adopted', {
    studioId: updated.id,
    agentId,
    sessionId,
  });

  return successResponse({
    message: `Studio adopted by ${agentId} and linked to session ${sessionId}`,
    studio: {
      id: updated.id,
      studioId: updated.id,
      agentId: updated.agentId,
      branch: updated.branch,
      worktreeFolder: path.basename(updated.worktreePath),
      worktreePath: updated.worktreePath,
      purpose: updated.purpose,
      roleTemplate: updated.roleTemplate,
      defaultProjectId: updated.defaultProjectId,
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
  });
}

const registerStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID to own the studio'),
  repoRoot: z.string().describe('Absolute path to the repository root'),
});

export async function handleRegisterStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = registerStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  // Check if studio already exists before auto-create
  const existingId = await resolveMainStudio(
    dataComposer.getClient(),
    user.id,
    parsed.repoRoot,
    parsed.agentId
  );

  const studioId =
    existingId ??
    (await resolveMainStudio(dataComposer.getClient(), user.id, parsed.repoRoot, parsed.agentId, {
      autoCreate: true,
    }));

  if (!studioId) {
    return errorResponse('Failed to register studio — could not create or find studio row');
  }

  const studio = await dataComposer.repositories.studios.findById(studioId);
  if (!studio) {
    return errorResponse('Studio was created but could not be retrieved');
  }

  return successResponse({
    studio: {
      id: studio.id,
      slug: studio.slug,
      repoRoot: studio.repoRoot,
      worktreePath: studio.worktreePath,
      branch: studio.branch,
      agentId: studio.agentId,
      status: studio.status,
    },
    created: !existingId,
  });
}

// ============== Tool Registration ==============

export const studioToolDefinitions = [
  {
    name: 'create_studio',
    description:
      'Create a new git worktree studio for isolated parallel work. Sets up the worktree, installs dependencies, and tracks it in the database.',
    schema: createStudioSchema,
    handler: handleCreateStudio,
  },
  {
    name: 'list_studios',
    description:
      'List studios for the current user. By default excludes cleaned studios unless includeAll is true. Can filter by agent and status.',
    schema: listStudiosSchema,
    handler: handleListStudios,
  },
  {
    name: 'get_studio',
    description: 'Get full details of a studio by its ID, branch name, or worktree path.',
    schema: getStudioSchema,
    handler: handleGetStudio,
  },
  {
    name: 'update_studio',
    description:
      'Update a studio status, purpose, or session linkage. Use unlinkSession to detach the current session and set status to idle.',
    schema: updateStudioSchema,
    handler: handleUpdateStudio,
  },
  {
    name: 'close_studio',
    description:
      'Close a studio by removing its git worktree, optionally deleting the branch, and marking it as cleaned in the database.',
    schema: closeStudioSchema,
    handler: handleCloseStudio,
  },
  {
    name: 'adopt_studio',
    description:
      'Adopt an existing studio by linking a new session to it and setting it to active. Useful when resuming work in a previously created worktree.',
    schema: adoptStudioSchema,
    handler: handleAdoptStudio,
  },
  {
    name: 'register_studio',
    description:
      'Register an existing repository as a studio. Creates a studio row for the root repo if one does not exist, or returns the existing one. Use this to make repos visible in the dashboard without starting a session.',
    schema: registerStudioSchema,
    handler: handleRegisterStudio,
  },
];
