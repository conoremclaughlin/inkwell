/**
 * Workspace Handlers
 *
 * Product-level workspaces (personal/team), distinct from git worktree studios.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import type {
  WorkspaceType,
  WorkspaceMemberRole,
} from '../../data/repositories/workspaces.repository';
import type { Json } from '../../data/supabase/types';
import { slugifyWorkspaceName } from '../../utils/workspace-slug';

const workspaceTypeSchema = z.enum(['personal', 'team']);
const workspaceMemberRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const createWorkspaceSchema = userIdentifierBaseSchema.extend({
  name: z.string().min(1).describe('Workspace display name (e.g., "Personal", "PCP Team")'),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Stable workspace slug (generated from name when omitted)'),
  type: workspaceTypeSchema
    .optional()
    .default('personal')
    .describe('Workspace type: personal or team'),
  description: z.string().optional().describe('Optional workspace description'),
  metadata: z.record(z.unknown()).optional().describe('Optional workspace metadata'),
});

export const listWorkspacesSchema = userIdentifierBaseSchema.extend({
  type: workspaceTypeSchema.optional().describe('Optional type filter'),
  includeArchived: z.boolean().optional().default(false).describe('Include archived workspaces'),
  ensurePersonal: z
    .boolean()
    .optional()
    .default(true)
    .describe('Ensure a default personal workspace exists'),
});

export const getWorkspaceSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID'),
  includeMembers: z.boolean().optional().default(false).describe('Include workspace members'),
});

export const updateWorkspaceSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().describe('Workspace UUID'),
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  type: workspaceTypeSchema.optional(),
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

export async function handleCreateWorkspace(args: unknown, dataComposer: DataComposer) {
  const params = createWorkspaceSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaces.create({
    userId: user.id,
    name: params.name,
    slug: params.slug || slugifyWorkspaceName(params.name),
    type: (params.type || 'personal') as WorkspaceType,
    description: params.description,
    metadata: toJsonObject(params.metadata),
  });

  await dataComposer.repositories.workspaces.addMember(workspace.id, user.id, 'owner');

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

export async function handleListWorkspaces(args: unknown, dataComposer: DataComposer) {
  const params = listWorkspacesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  if (params.ensurePersonal !== false) {
    await dataComposer.repositories.workspaces.ensurePersonalWorkspace(user.id);
  }

  const workspaces = await dataComposer.repositories.workspaces.listMembershipsByUser(user.id, {
    type: params.type as WorkspaceType | undefined,
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

export async function handleGetWorkspace(args: unknown, dataComposer: DataComposer) {
  const params = getWorkspaceSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaces.findById(
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
    ? await dataComposer.repositories.workspaces.listMembersWithUsers(workspace.id)
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

export async function handleUpdateWorkspace(args: unknown, dataComposer: DataComposer) {
  const params = updateWorkspaceSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const updated = await dataComposer.repositories.workspaces.update(params.workspaceId, user.id, {
    name: params.name,
    slug: params.slug,
    type: params.type as WorkspaceType | undefined,
    description: params.description,
    metadata: toJsonObject(params.metadata),
    archivedAt:
      params.archived === undefined ? undefined : params.archived ? new Date().toISOString() : null,
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

export async function handleAddWorkspaceMember(args: unknown, dataComposer: DataComposer) {
  const params = addWorkspaceMemberSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const workspace = await dataComposer.repositories.workspaces.findById(
    params.workspaceId,
    user.id
  );
  if (!workspace) {
    return errorResponse('Workspace not found or not accessible');
  }

  const canManage = await dataComposer.repositories.workspaces.canManageWorkspace(
    workspace.id,
    user.id
  );
  if (!canManage) {
    return errorResponse('Only workspace owners/admins can add collaborators');
  }

  const actingRole = await dataComposer.repositories.workspaces.getMemberRole(
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

  const member = await dataComposer.repositories.workspaces.addMember(
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
