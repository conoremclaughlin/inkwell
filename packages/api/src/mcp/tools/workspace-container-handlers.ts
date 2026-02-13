/**
 * Workspace Container Handlers
 *
 * Product-level workspaces (personal/team), distinct from git worktree studios.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import type { WorkspaceContainerType } from '../../data/repositories/workspace-containers.repository';
import type { Json } from '../../data/supabase/types';

const workspaceContainerTypeSchema = z.enum(['personal', 'team']);

export const createWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  name: z.string().min(1).describe('Workspace display name (e.g., "Personal", "PCP Team")'),
  slug: z.string().min(1).optional().describe('Stable workspace slug (generated from name when omitted)'),
  type: workspaceContainerTypeSchema.optional().default('personal')
    .describe('Workspace type: personal or team'),
  description: z.string().optional().describe('Optional workspace description'),
  metadata: z.record(z.unknown()).optional().describe('Optional workspace metadata'),
});

export const listWorkspaceContainersSchema = userIdentifierBaseSchema.extend({
  type: workspaceContainerTypeSchema.optional().describe('Optional type filter'),
  includeArchived: z.boolean().optional().default(false).describe('Include archived workspaces'),
  ensurePersonal: z.boolean().optional().default(true).describe('Ensure a default personal workspace exists'),
});

export const getWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace container UUID'),
  includeMembers: z.boolean().optional().default(false).describe('Include workspace members'),
});

export const updateWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace container UUID'),
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  type: workspaceContainerTypeSchema.optional(),
  description: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  archived: z.boolean().optional().describe('Set true to archive, false to unarchive'),
});

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'workspace';
}

function successResponse(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...data }) }],
  };
}

function toJsonObject(value: Record<string, unknown> | undefined): Json | undefined {
  return value as Json | undefined;
}

export async function handleCreateWorkspaceContainer(args: unknown, dataComposer: DataComposer) {
  const params = createWorkspaceContainerSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaceContainers.create({
    userId: user.id,
    name: params.name,
    slug: params.slug || slugify(params.name),
    type: (params.type || 'personal') as WorkspaceContainerType,
    description: params.description,
    metadata: toJsonObject(params.metadata),
  });

  await dataComposer.repositories.workspaceContainers.addMember(workspace.id, user.id, 'owner');

  return successResponse({
    user: { id: user.id, resolvedBy },
    workspace: {
      id: workspace.id,
      userId: workspace.userId,
      name: workspace.name,
      slug: workspace.slug,
      type: workspace.type,
      description: workspace.description,
      metadata: workspace.metadata,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      archivedAt: workspace.archivedAt,
    },
  });
}

export async function handleListWorkspaceContainers(args: unknown, dataComposer: DataComposer) {
  const params = listWorkspaceContainersSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  if (params.ensurePersonal !== false) {
    await dataComposer.repositories.workspaceContainers.ensurePersonalWorkspace(user.id);
  }

  const workspaces = await dataComposer.repositories.workspaceContainers.listByUser(user.id, {
    type: params.type as WorkspaceContainerType | undefined,
    includeArchived: params.includeArchived,
  });

  return successResponse({
    user: { id: user.id, resolvedBy },
    count: workspaces.length,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      userId: w.userId,
      name: w.name,
      slug: w.slug,
      type: w.type,
      description: w.description,
      metadata: w.metadata,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      archivedAt: w.archivedAt,
    })),
  });
}

export async function handleGetWorkspaceContainer(args: unknown, dataComposer: DataComposer) {
  const params = getWorkspaceContainerSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaceContainers.findById(params.workspaceId, user.id);
  if (!workspace) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Workspace not found' }) }],
      isError: true,
    };
  }

  const members = params.includeMembers
    ? await dataComposer.repositories.workspaceContainers.listMembers(workspace.id)
    : undefined;

  return successResponse({
    user: { id: user.id, resolvedBy },
    workspace: {
      id: workspace.id,
      userId: workspace.userId,
      name: workspace.name,
      slug: workspace.slug,
      type: workspace.type,
      description: workspace.description,
      metadata: workspace.metadata,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      archivedAt: workspace.archivedAt,
      members: members?.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
      })),
    },
  });
}

export async function handleUpdateWorkspaceContainer(args: unknown, dataComposer: DataComposer) {
  const params = updateWorkspaceContainerSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const updated = await dataComposer.repositories.workspaceContainers.update(params.workspaceId, user.id, {
    name: params.name,
    slug: params.slug,
    type: params.type as WorkspaceContainerType | undefined,
    description: params.description,
    metadata: toJsonObject(params.metadata),
    archivedAt: params.archived === undefined ? undefined : (params.archived ? new Date().toISOString() : null),
  });

  return successResponse({
    user: { id: user.id, resolvedBy },
    workspace: {
      id: updated.id,
      userId: updated.userId,
      name: updated.name,
      slug: updated.slug,
      type: updated.type,
      description: updated.description,
      metadata: updated.metadata,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      archivedAt: updated.archivedAt,
    },
  });
}
