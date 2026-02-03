/**
 * User Identity MCP Tool Handlers
 *
 * Tools for managing user-level identity files (USER.md, VALUES.md)
 * that are shared across all agents for a user.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { resolveUserOrThrow } from '../../services/user-resolver';

// User identification fields
const userIdentifierFields = {
  userId: z.string().uuid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
  phone: z.string().optional().describe('Phone number in E.164 format'),
  platformId: z.string().optional().describe('Platform-specific user ID'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional().describe('Platform for user lookup'),
};

// =====================================================
// SCHEMAS
// =====================================================

export const saveUserIdentitySchema = z.object({
  ...userIdentifierFields,
  userProfileMd: z.string().optional().describe('USER.md content - who the human is'),
  sharedValuesMd: z.string().optional().describe('VALUES.md content - shared values across all SBs'),
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

/**
 * Save or update user identity (USER.md, VALUES.md)
 */
export async function handleSaveUserIdentity(args: unknown, dataComposer: DataComposer) {
  const params = saveUserIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();

  // Check if identity already exists
  const { data: existing } = await supabase
    .from('user_identity')
    .select('id, version')
    .eq('user_id', user.id)
    .single();

  let result;
  if (existing) {
    // Update existing
    const updateData: Record<string, unknown> = {};
    if (params.userProfileMd !== undefined) {
      updateData.user_profile_md = params.userProfileMd;
    }
    if (params.sharedValuesMd !== undefined) {
      updateData.shared_values_md = params.sharedValuesMd;
    }

    const { data, error } = await supabase
      .from('user_identity')
      .update(updateData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw new Error(`Failed to update user identity: ${error.message}`);
    result = data;
  } else {
    // Insert new
    const { data, error } = await supabase
      .from('user_identity')
      .insert({
        user_id: user.id,
        user_profile_md: params.userProfileMd || null,
        shared_values_md: params.sharedValuesMd || null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create user identity: ${error.message}`);
    result = data;
  }

  logger.info(`User identity saved for user ${user.id}`, {
    version: result.version,
    hasUserProfile: !!result.user_profile_md,
    hasSharedValues: !!result.shared_values_md,
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
              hasSharedValues: !!result.shared_values_md,
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
 * Get user identity (USER.md, VALUES.md)
 */
export async function handleGetUserIdentity(args: unknown, dataComposer: DataComposer) {
  const params = getUserIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();

  const { data, error } = await supabase
    .from('user_identity')
    .select('*')
    .eq('user_id', user.id)
    .single();

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
              userProfileMd: data.user_profile_md,
              sharedValuesMd: data.shared_values_md,
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
  const { data: current } = await supabase
    .from('user_identity')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Get history
  const { data: history, error } = await supabase
    .from('user_identity_history')
    .select('*')
    .eq('user_id', user.id)
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
                  userProfileMd: current.user_profile_md,
                  sharedValuesMd: current.shared_values_md,
                  updatedAt: current.updated_at,
                }
              : null,
            history: (history || []).map((h) => ({
              id: h.id,
              version: h.version,
              userProfileMd: h.user_profile_md,
              sharedValuesMd: h.shared_values_md,
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
  const { data: versionToRestore, error: findError } = await supabase
    .from('user_identity_history')
    .select('*')
    .eq('user_id', user.id)
    .eq('version', params.version)
    .single();

  if (findError || !versionToRestore) {
    throw new Error(`Version ${params.version} not found in history`);
  }

  // Update current identity with the historical values
  const { data: result, error: updateError } = await supabase
    .from('user_identity')
    .update({
      user_profile_md: versionToRestore.user_profile_md,
      shared_values_md: versionToRestore.shared_values_md,
    })
    .eq('user_id', user.id)
    .select()
    .single();

  if (updateError) {
    throw new Error(`Failed to restore user identity: ${updateError.message}`);
  }

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
