/**
 * Workspace Container Handlers
 *
 * Product-level workspaces (personal/team), distinct from git worktree studios.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import type {
  WorkspaceContainerType,
  WorkspaceMemberRole,
} from '../../data/repositories/workspace-containers.repository';
import type { Json } from '../../data/supabase/types';
import { slugifyWorkspaceName } from '../../utils/workspace-slug';

const workspaceContainerTypeSchema = z.enum(['personal', 'team']);
const workspaceMemberRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const createWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  name: z.string().min(1).describe('Workspace display name (e.g., "Personal", "PCP Team")'),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Stable workspace slug (generated from name when omitted)'),
  type: workspaceContainerTypeSchema
    .optional()
    .default('personal')
    .describe('Workspace type: personal or team'),
  description: z.string().optional().describe('Optional workspace description'),
  metadata: z.record(z.unknown()).optional().describe('Optional workspace metadata'),
});

export const listWorkspaceContainersSchema = userIdentifierBaseSchema.extend({
  type: workspaceContainerTypeSchema.optional().describe('Optional type filter'),
  includeArchived: z.boolean().optional().default(false).describe('Include archived workspaces'),
  ensurePersonal: z
    .boolean()
    .optional()
    .default(true)
    .describe('Ensure a default personal workspace exists'),
});

export const getWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID'),
  includeMembers: z.boolean().optional().default(false).describe('Include workspace members'),
});

export const updateWorkspaceContainerSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID'),
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  type: workspaceContainerTypeSchema.optional(),
  description: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  archived: z.boolean().optional().describe('Set true to archive, false to unarchive'),
});

export const addWorkspaceMemberSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID'),
  inviteeEmail: z.string().email().describe('Email address of collaborator to add'),
  role: workspaceMemberRoleSchema.optional().default('member'),
});

function successResponse(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...data }) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
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
    slug: params.slug || slugifyWorkspaceName(params.name),
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

  const workspaces = await dataComposer.repositories.workspaceContainers.listMembershipsByUser(user.id, {
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
      role: w.role,
      membershipCreatedAt: w.membershipCreatedAt,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      archivedAt: w.archivedAt,
    })),
  });
}

export async function handleGetWorkspaceContainer(args: unknown, dataComposer: DataComposer) {
  const params = getWorkspaceContainerSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaceContainers.findById(
    params.workspaceId,
    user.id
  );
  if (!workspace) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'Workspace not found' }),
        },
      ],
      isError: true,
    };
  }

  const members = params.includeMembers
    ? await dataComposer.repositories.workspaceContainers.listMembersWithUsers(workspace.id)
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
        user: m.user
          ? {
              id: m.user.id,
              email: m.user.email,
              firstName: m.user.firstName,
              username: m.user.username,
              lastLoginAt: m.user.lastLoginAt,
            }
          : null,
      })),
    },
  });
}

export async function handleUpdateWorkspaceContainer(args: unknown, dataComposer: DataComposer) {
  const params = updateWorkspaceContainerSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const updated = await dataComposer.repositories.workspaceContainers.update(
    params.workspaceId,
    user.id,
    {
      name: params.name,
      slug: params.slug,
      type: params.type as WorkspaceContainerType | undefined,
      description: params.description,
      metadata: toJsonObject(params.metadata),
      archivedAt:
        params.archived === undefined
          ? undefined
          : params.archived
            ? new Date().toISOString()
            : null,
    }
  );

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

export async function handleAddWorkspaceMember(args: unknown, dataComposer: DataComposer) {
  const params = addWorkspaceMemberSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaceContainers.findById(
    params.workspaceId,
    user.id
  );
  if (!workspace) {
    return errorResponse('Workspace not found or not accessible');
  }

  const canManage = await dataComposer.repositories.workspaceContainers.canManageWorkspace(
    workspace.id,
    user.id
  );
  if (!canManage) {
    return errorResponse('Only workspace owners/admins can add collaborators');
  }

  const actingRole = await dataComposer.repositories.workspaceContainers.getMemberRole(
    workspace.id,
    user.id
  );
  if (params.role === 'owner' && actingRole !== 'owner') {
    return errorResponse('Only workspace owners can grant owner role');
  }

  const normalizedInviteeEmail = params.inviteeEmail.trim().toLowerCase();
  let invitedUser = await dataComposer.repositories.users.findByEmail(normalizedInviteeEmail);
  let userWasCreated = false;

  if (!invitedUser) {
    invitedUser = await dataComposer.repositories.users.create({
      email: normalizedInviteeEmail,
    });
    userWasCreated = true;
  }

  const member = await dataComposer.repositories.workspaceContainers.addMember(
    workspace.id,
    invitedUser.id,
    (params.role || 'member') as WorkspaceMemberRole
  );

  return successResponse({
    user: { id: user.id, resolvedBy },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      type: workspace.type,
    },
    member: {
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      user: {
        id: invitedUser.id,
        email: invitedUser.email,
      },
      userWasCreated,
    },
  });
}
