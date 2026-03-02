/**
 * Studio Handlers
 *
 * MCP tools for managing git worktree studios. Enables agents to create
 * isolated worktrees for parallel work, track their lifecycle, and link
 * them to sessions for context continuity.
 */

import { z } from 'zod';
import path from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';

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
    skipGitOperations = false,
  } = parsed;

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
    } catch (gitError) {
      const errorMessage = gitError instanceof Error ? gitError.message : String(gitError);
      logger.error('Git worktree creation failed', { error: errorMessage, branch, worktreePath });
      return errorResponse(`Failed to create git worktree: ${errorMessage}`);
    }
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
      hasLinkedSession: !!w.sessionId,
      createdAt: w.createdAt,
    })),
  });
}

export async function handleGetStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = getStudioSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const studiosRepo = dataComposer.repositories.studios;
  let studio = null;

  // Try identifiers in order: studioId, branch, path
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch);
  } else if (parsed.path) {
    studio = await studiosRepo.findByPath(parsed.path);
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
      status: studio.status,
      sessionId: studio.sessionId,
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
  await resolveUserOrThrow(parsed, dataComposer);

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
  } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists
  const existing = await studiosRepo.findById(studioId);
  if (!existing) {
    return errorResponse(`Studio not found: ${studioId}`);
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
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function handleCloseStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = closeStudioSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const { studioId, agentId, removeWorktree = true, deleteBranch = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists
  const studio = await studiosRepo.findById(studioId);
  if (!studio) {
    return errorResponse(`Studio not found: ${studioId}`);
  }

  const cleanupResults: { worktreeRemoved: boolean; branchDeleted: boolean; errors: string[] } = {
    worktreeRemoved: false,
    branchDeleted: false,
    errors: [],
  };

  // Remove the git worktree
  if (removeWorktree) {
    try {
      execSync(`git worktree remove ${studio.worktreePath}`, {
        cwd: studio.repoRoot,
        stdio: 'pipe',
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
  }

  // Delete the branch
  if (deleteBranch) {
    try {
      execSync(`git branch -d ${studio.branch}`, {
        cwd: studio.repoRoot,
        stdio: 'pipe',
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

  // Mark as cleaned in the database
  const updated = await studiosRepo.markCleaned(studioId);

  logger.info('Studio closed', {
    studioId,
    agentId,
    worktreeRemoved: cleanupResults.worktreeRemoved,
    branchDeleted: cleanupResults.branchDeleted,
  });

  return successResponse({
    message: 'Studio closed and marked as cleaned',
    studioId: updated.id,
    status: updated.status,
    cleanedAt: updated.cleanedAt,
    cleanup: cleanupResults,
  });
}

export async function handleAdoptStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = adoptStudioSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, sessionId } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Find studio by ID, branch, or path
  let studio = null;
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch);
  } else if (parsed.worktreePath) {
    studio = await studiosRepo.findByPath(parsed.worktreePath);
  } else {
    return errorResponse('Must provide at least one of: studioId, branch, or worktreePath');
  }

  if (!studio) {
    return errorResponse('Studio not found');
  }

  // Link session and set to active
  const updated = await studiosRepo.linkSession(studio.id, sessionId);

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
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
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
];
