/**
 * Workspace Handlers
 *
 * MCP tools for managing git worktree workspaces. Enables agents to create
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

const createWorkspaceSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID creating the workspace (e.g., "wren")'),
  repoRoot: z.string().describe('Absolute path to the main repository root'),
  slug: z
    .string()
    .describe('Short slug for the workspace (used in branch name and worktree directory)'),
  workType: z
    .enum(['feature', 'bugfix', 'refactor', 'chore', 'experiment', 'other'])
    .optional()
    .default('feature')
    .describe('Type of work being done in this workspace'),
  purpose: z
    .string()
    .optional()
    .describe('Human-readable description of what this workspace is for'),
  baseBranch: z.string().optional().default('main').describe('Branch to base the new worktree on'),
  sessionId: z.string().uuid().optional().describe('Session ID to link to this workspace'),
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

const listWorkspacesSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Filter by agent ID'),
  status: z
    .enum(['active', 'idle', 'archived', 'cleaned', 'all'])
    .optional()
    .default('all')
    .describe('Filter by workspace status'),
  includeAll: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, include all statuses including cleaned'),
});

const getWorkspaceSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Workspace UUID'),
  branch: z.string().optional().describe('Branch name to look up'),
  path: z.string().optional().describe('Worktree path to look up'),
});

const updateWorkspaceSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID to update'),
  agentId: z.string().describe('Agent ID making the update'),
  status: z.enum(['active', 'idle', 'archived']).optional().describe('New workspace status'),
  purpose: z.string().optional().describe('Updated purpose description'),
  roleTemplate: z.string().optional().describe('Role template name to set'),
  sessionId: z.string().uuid().optional().describe('Session ID to link'),
  unlinkSession: z
    .boolean()
    .optional()
    .describe('If true, unlink the current session and set status to idle'),
});

const closeWorkspaceSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID to close'),
  agentId: z.string().describe('Agent ID closing the workspace'),
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

const adoptWorkspaceSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID adopting the workspace'),
  sessionId: z.string().uuid().describe('Session ID to link to the workspace'),
  workspaceId: z.string().uuid().optional().describe('Workspace UUID to adopt'),
  branch: z.string().optional().describe('Branch name to look up the workspace'),
  worktreePath: z.string().optional().describe('Worktree path to look up the workspace'),
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

export async function handleCreateWorkspace(args: unknown, dataComposer: DataComposer) {
  const parsed = createWorkspaceSchema.parse(args);
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

  // Derive branch name and worktree path
  const abbrev = WORK_TYPE_ABBREV[workType] || 'other';
  const branch = `${agentId}/${abbrev}/${slug}`;
  const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}--${slug}`);

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

  // Insert workspace record into the database
  let workspace;
  try {
    workspace = await dataComposer.repositories.studios.create({
      userId: resolved.user.id,
      agentId,
      sessionId,
      repoRoot,
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
    return errorResponse(`Failed to save workspace record: ${errorMessage}`);
  }

  logger.info('Workspace created', {
    workspaceId: workspace.id,
    branch,
    worktreePath,
    agentId,
  });

  return successResponse({
    message: `Workspace created at ${worktreePath}`,
    workspace: {
      id: workspace.id,
      studioId: workspace.id,
      agentId: workspace.agentId,
      branch: workspace.branch,
      worktreeFolder: path.basename(workspace.worktreePath),
      worktreePath: workspace.worktreePath,
      repoRoot: workspace.repoRoot,
      baseBranch: workspace.baseBranch,
      purpose: workspace.purpose,
      workType: workspace.workType,
      roleTemplate: workspace.roleTemplate,
      status: workspace.status,
      sessionId: workspace.sessionId,
      createdAt: workspace.createdAt,
    },
  });
}

export async function handleListWorkspaces(args: unknown, dataComposer: DataComposer) {
  const parsed = listWorkspacesSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, status = 'all', includeAll = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  let workspaces;
  if (status !== 'all') {
    workspaces = await studiosRepo.listByUser(resolved.user.id, {
      status: status as 'active' | 'idle' | 'archived' | 'cleaned',
      agentId: agentId || undefined,
    });
  } else if (includeAll) {
    workspaces = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
  } else {
    // Default: get all but exclude 'cleaned'
    const all = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
    workspaces = all.filter((w) => w.status !== 'cleaned');
  }

  return successResponse({
    count: workspaces.length,
    workspaces: workspaces.map((w) => ({
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

export async function handleGetWorkspace(args: unknown, dataComposer: DataComposer) {
  const parsed = getWorkspaceSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const studiosRepo = dataComposer.repositories.studios;
  let workspace = null;

  // Try identifiers in order: workspaceId, branch, path
  if (parsed.workspaceId) {
    workspace = await studiosRepo.findById(parsed.workspaceId);
  } else if (parsed.branch) {
    workspace = await studiosRepo.findByBranch(parsed.branch);
  } else if (parsed.path) {
    workspace = await studiosRepo.findByPath(parsed.path);
  } else {
    return errorResponse('Must provide at least one of: workspaceId, branch, or path');
  }

  if (!workspace) {
    return errorResponse('Workspace not found');
  }

  return successResponse({
    workspace: {
      id: workspace.id,
      studioId: workspace.id,
      agentId: workspace.agentId,
      branch: workspace.branch,
      worktreeFolder: path.basename(workspace.worktreePath),
      worktreePath: workspace.worktreePath,
      repoRoot: workspace.repoRoot,
      baseBranch: workspace.baseBranch,
      purpose: workspace.purpose,
      workType: workspace.workType,
      roleTemplate: workspace.roleTemplate,
      status: workspace.status,
      sessionId: workspace.sessionId,
      metadata: workspace.metadata,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      archivedAt: workspace.archivedAt,
      cleanedAt: workspace.cleanedAt,
    },
  });
}

export async function handleUpdateWorkspace(args: unknown, dataComposer: DataComposer) {
  const parsed = updateWorkspaceSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const { workspaceId, agentId, status, purpose, roleTemplate, sessionId, unlinkSession } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify workspace exists
  const existing = await studiosRepo.findById(workspaceId);
  if (!existing) {
    return errorResponse(`Workspace not found: ${workspaceId}`);
  }

  let updated;

  if (unlinkSession) {
    updated = await studiosRepo.unlinkSession(workspaceId);
  } else if (sessionId) {
    updated = await studiosRepo.linkSession(workspaceId, sessionId);
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
    updated = await studiosRepo.update(workspaceId, updateObj);
  }

  logger.info('Workspace updated', { workspaceId, agentId, status: updated.status });

  return successResponse({
    message: 'Workspace updated',
    workspace: {
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

export async function handleCloseWorkspace(args: unknown, dataComposer: DataComposer) {
  const parsed = closeWorkspaceSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const { workspaceId, agentId, removeWorktree = true, deleteBranch = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify workspace exists
  const workspace = await studiosRepo.findById(workspaceId);
  if (!workspace) {
    return errorResponse(`Workspace not found: ${workspaceId}`);
  }

  const cleanupResults: { worktreeRemoved: boolean; branchDeleted: boolean; errors: string[] } = {
    worktreeRemoved: false,
    branchDeleted: false,
    errors: [],
  };

  // Remove the git worktree
  if (removeWorktree) {
    try {
      execSync(`git worktree remove ${workspace.worktreePath}`, {
        cwd: workspace.repoRoot,
        stdio: 'pipe',
      });
      cleanupResults.worktreeRemoved = true;
    } catch (worktreeError) {
      const errorMessage =
        worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
      logger.warn('Failed to remove worktree (may already be gone)', {
        worktreePath: workspace.worktreePath,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Worktree removal: ${errorMessage}`);
    }
  }

  // Delete the branch
  if (deleteBranch) {
    try {
      execSync(`git branch -d ${workspace.branch}`, {
        cwd: workspace.repoRoot,
        stdio: 'pipe',
      });
      cleanupResults.branchDeleted = true;
    } catch (branchError) {
      const errorMessage = branchError instanceof Error ? branchError.message : String(branchError);
      logger.warn('Failed to delete branch', {
        branch: workspace.branch,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Branch deletion: ${errorMessage}`);
    }
  }

  // Mark as cleaned in the database
  const updated = await studiosRepo.markCleaned(workspaceId);

  logger.info('Workspace closed', {
    workspaceId,
    agentId,
    worktreeRemoved: cleanupResults.worktreeRemoved,
    branchDeleted: cleanupResults.branchDeleted,
  });

  return successResponse({
    message: 'Workspace closed and marked as cleaned',
    workspaceId: updated.id,
    status: updated.status,
    cleanedAt: updated.cleanedAt,
    cleanup: cleanupResults,
  });
}

export async function handleAdoptWorkspace(args: unknown, dataComposer: DataComposer) {
  const parsed = adoptWorkspaceSchema.parse(args);
  await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, sessionId } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Find workspace by ID, branch, or path
  let workspace = null;
  if (parsed.workspaceId) {
    workspace = await studiosRepo.findById(parsed.workspaceId);
  } else if (parsed.branch) {
    workspace = await studiosRepo.findByBranch(parsed.branch);
  } else if (parsed.worktreePath) {
    workspace = await studiosRepo.findByPath(parsed.worktreePath);
  } else {
    return errorResponse('Must provide at least one of: workspaceId, branch, or worktreePath');
  }

  if (!workspace) {
    return errorResponse('Workspace not found');
  }

  // Link session and set to active
  const updated = await studiosRepo.linkSession(workspace.id, sessionId);

  logger.info('Workspace adopted', {
    workspaceId: updated.id,
    agentId,
    sessionId,
  });

  return successResponse({
    message: `Workspace adopted by ${agentId} and linked to session ${sessionId}`,
    workspace: {
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

export const workspaceToolDefinitions = [
  {
    name: 'create_workspace',
    description:
      'Create a new git worktree workspace for isolated parallel work. Sets up the worktree, installs dependencies, and tracks it in the database.',
    schema: createWorkspaceSchema,
    handler: handleCreateWorkspace,
  },
  {
    name: 'list_workspaces',
    description:
      'List workspaces for the current user. By default excludes cleaned workspaces unless includeAll is true. Can filter by agent and status.',
    schema: listWorkspacesSchema,
    handler: handleListWorkspaces,
  },
  {
    name: 'get_workspace',
    description: 'Get full details of a workspace by its ID, branch name, or worktree path.',
    schema: getWorkspaceSchema,
    handler: handleGetWorkspace,
  },
  {
    name: 'update_workspace',
    description:
      'Update a workspace status, purpose, or session linkage. Use unlinkSession to detach the current session and set status to idle.',
    schema: updateWorkspaceSchema,
    handler: handleUpdateWorkspace,
  },
  {
    name: 'close_workspace',
    description:
      'Close a workspace by removing its git worktree, optionally deleting the branch, and marking it as cleaned in the database.',
    schema: closeWorkspaceSchema,
    handler: handleCloseWorkspace,
  },
  {
    name: 'adopt_workspace',
    description:
      'Adopt an existing workspace by linking a new session to it and setting it to active. Useful when resuming work in a previously created worktree.',
    schema: adoptWorkspaceSchema,
    handler: handleAdoptWorkspace,
  },
];
