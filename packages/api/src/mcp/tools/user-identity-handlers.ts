/**
 * User Identity MCP Tool Handlers
 *
 * Tools for managing shared user-level documents (user, values, process)
 * that are shared across all agents for a user.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { resolveUserOrThrow } from '../../services/user-resolver';

// User identification fields
// Usually unnecessary — userId and email are auto-resolved from OAuth token.
const userIdentifierFields = {
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  phone: z.string().optional().describe('Phone number in E.164 format'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
};

// =====================================================
// SCHEMAS
// =====================================================

export const saveUserIdentitySchema = z.object({
  ...userIdentifierFields,
  userProfile: z.string().optional().describe('About-you document content'),
  userProfileMd: z
    .string()
    .optional()
    .describe('[Deprecated] About-you document content (legacy key)'),
  sharedValues: z.string().optional().describe('Shared values document content'),
  sharedValuesMd: z
    .string()
    .optional()
    .describe('[Deprecated] Shared values document content (legacy key)'),
  process: z.string().optional().describe('Shared collaboration process document content'),
  processMd: z
    .string()
    .optional()
    .describe('[Deprecated] Shared collaboration process document content (legacy key)'),
});

export const getUserIdentitySchema = z.object({
  ...userIdentifierFields,
});

export const getUserIdentityHistorySchema = z.object({
  ...userIdentifierFields,
  limit: z.number().min(1).max(50).optional().describe('Max versions to return (default: 10)'),
});

export const restoreUserIdentitySchema = z.object({
  ...userIdentifierFields,
  version: z.number().min(1).describe('Version number to restore'),
});

// =====================================================
// HANDLERS
// =====================================================

function withWorkspaceFilter<T>(query: T, workspaceId?: string): T {
  if (!workspaceId) return query;
  return (query as { eq: (column: string, value: string) => T }).eq('workspace_id', workspaceId);
}

function resolveIdentityDocs(params: z.infer<typeof saveUserIdentitySchema>) {
  return {
    userProfile: params.userProfile ?? params.userProfileMd,
    sharedValues: params.sharedValues ?? params.sharedValuesMd,
    process: params.process ?? params.processMd,
  };
}

async function syncWorkspaceSharedDocs(
  supabase: ReturnType<DataComposer['getClient']>,
  {
    userId,
    workspaceId,
    sharedValues,
    process,
  }: {
    userId: string;
    workspaceId?: string;
    sharedValues?: string;
    process?: string;
  }
) {
  if (!workspaceId) return;

  const workspaceUpdateData: Record<string, unknown> = {};
  if (sharedValues !== undefined) {
    workspaceUpdateData.shared_values = sharedValues;
  }
  if (process !== undefined) {
    workspaceUpdateData.process = process;
  }

  if (Object.keys(workspaceUpdateData).length === 0) return;

  const { error } = await supabase
    .from('workspaces')
    .update(workspaceUpdateData)
    .eq('id', workspaceId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to update workspace shared docs: ${error.message}`);
  }
}

async function getWorkspaceSharedDocs(
  supabase: ReturnType<DataComposer['getClient']>,
  userId: string,
  workspaceId?: string
) {
  if (!workspaceId) return null;

  const { data, error } = await supabase
    .from('workspaces')
    .select('shared_values, process')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get workspace shared docs: ${error.message}`);
  }

  return data || null;
}

/**
 * Save or update shared user-level documents
 */
export async function handleSaveUserIdentity(args: unknown, dataComposer: DataComposer) {
  const params = saveUserIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const docs = resolveIdentityDocs(params);

  const supabase = dataComposer.getClient();
  const workspaceId = params.workspaceId;

  // Check if identity already exists
  let existingQuery = supabase.from('user_identity').select('*').eq('user_id', user.id);
  existingQuery = withWorkspaceFilter(existingQuery, workspaceId);
  const { data: existing } = await existingQuery.single();

  let result;
  if (existing) {
    // Update existing
    const updateData: Record<string, unknown> = {};
    if (docs.userProfile !== undefined) {
      updateData.user_profile_md = docs.userProfile;
    }
    if (docs.sharedValues !== undefined) {
      updateData.shared_values_md = docs.sharedValues;
    }
    if (docs.process !== undefined) {
      updateData.process_md = docs.process;
    }

    if (Object.keys(updateData).length > 0) {
      const { data, error } = await supabase
        .from('user_identity')
        .update(updateData)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw new Error(`Failed to update user identity: ${error.message}`);
      result = data;
    } else {
      result = existing;
    }
  } else {
    // Insert new
    const { data, error } = await supabase
      .from('user_identity')
      .insert({
        user_id: user.id,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        user_profile_md: docs.userProfile || null,
        shared_values_md: docs.sharedValues || null,
        process_md: docs.process || null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create user identity: ${error.message}`);
    result = data;
  }

  await syncWorkspaceSharedDocs(supabase, {
    userId: user.id,
    workspaceId,
    sharedValues: docs.sharedValues,
    process: docs.process,
  });

  const effectiveSharedValues = docs.sharedValues ?? result.shared_values_md;
  const effectiveProcess = docs.process ?? result.process_md;

  logger.info(`User identity saved for user ${user.id}`, {
    version: result.version,
    hasUserProfile: !!result.user_profile_md,
    hasSharedValues: !!effectiveSharedValues,
    hasProcess: !!effectiveProcess,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: existing ? 'User identity updated' : 'User identity created',
            user: { id: user.id, resolvedBy },
            identity: {
              id: result.id,
              version: result.version,
              hasUserProfile: !!result.user_profile_md,
              hasSharedValues: !!effectiveSharedValues,
              hasProcess: !!effectiveProcess,
              updatedAt: result.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Get shared user-level documents
 */
export async function handleGetUserIdentity(args: unknown, dataComposer: DataComposer) {
  const params = getUserIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();

  let identityQuery = supabase.from('user_identity').select('*').eq('user_id', user.id);
  identityQuery = withWorkspaceFilter(identityQuery, params.workspaceId);
  const { data, error } = await identityQuery.single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get user identity: ${error.message}`);
  }

  if (!data) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'No user identity found',
              user: { id: user.id, resolvedBy },
              identity: null,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  logger.info(`User identity retrieved for user ${user.id}`);
  const workspaceDocs = await getWorkspaceSharedDocs(supabase, user.id, params.workspaceId);
  const userProfile = data.user_profile_md;
  const sharedValues = (workspaceDocs?.shared_values as string | null) ?? data.shared_values_md;
  const process = (workspaceDocs?.process as string | null) ?? data.process_md;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            identity: {
              id: data.id,
              version: data.version,
              userProfile,
              sharedValues,
              process,
              // Deprecated aliases kept for compatibility
              userProfileMd: userProfile,
              sharedValuesMd: sharedValues,
              processMd: process,
              createdAt: data.created_at,
              updatedAt: data.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Get user identity version history
 */
export async function handleGetUserIdentityHistory(args: unknown, dataComposer: DataComposer) {
  const params = getUserIdentityHistorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();
  const limit = params.limit || 10;

  // Get current identity
  let currentQuery = supabase.from('user_identity').select('*').eq('user_id', user.id);
  currentQuery = withWorkspaceFilter(currentQuery, params.workspaceId);
  const { data: current } = await currentQuery.single();
  const workspaceDocs = await getWorkspaceSharedDocs(supabase, user.id, params.workspaceId);

  // Get history
  let historyQuery = supabase.from('user_identity_history').select('*').eq('user_id', user.id);
  historyQuery = withWorkspaceFilter(historyQuery, params.workspaceId);
  const { data: history, error } = await historyQuery
    .order('version', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to get user identity history: ${error.message}`);
  }

  logger.info(`User identity history retrieved for user ${user.id}`, {
    historyCount: history?.length || 0,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            current: current
              ? {
                  id: current.id,
                  version: current.version,
                  userProfile: current.user_profile_md,
                  sharedValues:
                    (workspaceDocs?.shared_values as string | null) ?? current.shared_values_md,
                  process: (workspaceDocs?.process as string | null) ?? current.process_md,
                  // Deprecated aliases kept for compatibility
                  userProfileMd: current.user_profile_md,
                  sharedValuesMd:
                    (workspaceDocs?.shared_values as string | null) ?? current.shared_values_md,
                  processMd: (workspaceDocs?.process as string | null) ?? current.process_md,
                  updatedAt: current.updated_at,
                }
              : null,
            history: (history || []).map((h) => ({
              id: h.id,
              version: h.version,
              userProfile: h.user_profile_md,
              sharedValues: h.shared_values_md,
              process: h.process_md,
              // Deprecated aliases kept for compatibility
              userProfileMd: h.user_profile_md,
              sharedValuesMd: h.shared_values_md,
              processMd: h.process_md,
              changeType: h.change_type,
              archivedAt: h.archived_at,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Restore user identity to a previous version
 */
export async function handleRestoreUserIdentity(args: unknown, dataComposer: DataComposer) {
  const params = restoreUserIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();

  // Find the version to restore
  let restoreQuery = supabase
    .from('user_identity_history')
    .select('*')
    .eq('user_id', user.id)
    .eq('version', params.version);
  restoreQuery = withWorkspaceFilter(restoreQuery, params.workspaceId);
  const { data: versionToRestore, error: findError } = await restoreQuery.single();

  if (findError || !versionToRestore) {
    throw new Error(`Version ${params.version} not found in history`);
  }

  // Update current identity with the historical values
  let updateQuery = supabase
    .from('user_identity')
    .update({
      user_profile_md: versionToRestore.user_profile_md,
      shared_values_md: versionToRestore.shared_values_md,
      process_md: versionToRestore.process_md,
    })
    .eq('user_id', user.id);
  updateQuery = withWorkspaceFilter(updateQuery, params.workspaceId);
  const { data: result, error: updateError } = await updateQuery.select().single();

  if (updateError) {
    throw new Error(`Failed to restore user identity: ${updateError.message}`);
  }

  await syncWorkspaceSharedDocs(supabase, {
    userId: user.id,
    workspaceId: params.workspaceId,
    sharedValues: versionToRestore.shared_values_md || undefined,
    process: versionToRestore.process_md || undefined,
  });

  logger.info(`User identity restored to version ${params.version} for user ${user.id}`, {
    newVersion: result.version,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `Restored to version ${params.version}`,
            user: { id: user.id, resolvedBy },
            identity: {
              id: result.id,
              version: result.version,
              restoredFrom: params.version,
              updatedAt: result.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
