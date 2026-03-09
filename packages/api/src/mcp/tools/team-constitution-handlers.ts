/**
 * Team Constitution MCP Tool Handlers
 *
 * Tools for managing the workspace-level values and process documents
 * that define the team's core principles and operational process.
 *
 * These are constitution-level — changes affect all SBs in the workspace.
 * The canonical storage is `workspaces.shared_values` and `workspaces.process`.
 *
 * History is tracked via the `user_identity` table (which is also updated for
 * backwards compatibility) and its `user_identity_history` trigger.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { resolveUserOrThrow } from '../../services/user-resolver';

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
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('Workspace to update. Defaults to personal workspace if omitted.'),
};

// =====================================================
// SCHEMAS
// =====================================================

export const saveTeamConstitutionSchema = z.object({
  ...userIdentifierFields,
  sharedValues: z
    .string()
    .optional()
    .describe(
      'Values document — shared principles and core truths for all SBs. Changes affect the entire team.'
    ),
  process: z
    .string()
    .optional()
    .describe(
      'Process document — team operational process (sessions, memory, handoff, PR conventions). Changes affect the entire team.'
    ),
});

export const getTeamConstitutionSchema = z.object({
  ...userIdentifierFields,
});

// =====================================================
// HELPERS
// =====================================================

async function resolveWorkspaceId(
  supabase: ReturnType<DataComposer['getClient']>,
  userId: string,
  workspaceId?: string
): Promise<string> {
  if (workspaceId) return workspaceId;

  // Fall back to personal workspace
  const { data, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .eq('slug', 'personal')
    .is('archived_at', null)
    .single();

  if (error || !data) {
    throw new Error('No workspace specified and no personal workspace found');
  }

  return data.id;
}

// =====================================================
// HANDLERS
// =====================================================

/**
 * Save or update the values and process documents (part of the team constitution).
 * Writes to workspace-level storage (canonical) and syncs to user_identity for history.
 */
export async function handleSaveTeamConstitution(args: unknown, dataComposer: DataComposer) {
  const params = saveTeamConstitutionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();
  const workspaceId = await resolveWorkspaceId(supabase, user.id, params.workspaceId);

  if (params.sharedValues === undefined && params.process === undefined) {
    throw new Error('At least one of sharedValues or process must be provided');
  }

  // 1. Update workspace (canonical storage)
  const workspaceUpdate: Record<string, unknown> = {};
  if (params.sharedValues !== undefined) {
    workspaceUpdate.shared_values = params.sharedValues;
  }
  if (params.process !== undefined) {
    workspaceUpdate.process = params.process;
  }

  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .update(workspaceUpdate)
    .eq('id', workspaceId)
    .eq('user_id', user.id)
    .select('id, shared_values, process, updated_at')
    .single();

  if (wsError) {
    throw new Error(`Failed to update workspace constitution: ${wsError.message}`);
  }

  // 2. Sync to user_identity for history tracking
  const identityUpdate: Record<string, unknown> = {};
  if (params.sharedValues !== undefined) {
    identityUpdate.shared_values_md = params.sharedValues;
  }
  if (params.process !== undefined) {
    identityUpdate.process_md = params.process;
  }

  const { data: existing } = await supabase
    .from('user_identity')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single();

  if (existing) {
    await supabase.from('user_identity').update(identityUpdate).eq('id', existing.id);
  } else {
    // No workspace-scoped row — insert one for history tracking
    await supabase.from('user_identity').insert({
      user_id: user.id,
      workspace_id: workspaceId,
      shared_values_md: params.sharedValues || null,
      process_md: params.process || null,
    });
  }

  const updated: string[] = [];
  if (params.sharedValues !== undefined) updated.push('values');
  if (params.process !== undefined) updated.push('process');

  logger.info(`Team constitution updated for workspace ${workspaceId}`, {
    updated,
    userId: user.id,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `Team constitution updated: ${updated.join(', ')}`,
            user: { id: user.id, resolvedBy },
            workspace: {
              id: workspaceId,
              hasSharedValues: !!workspace.shared_values,
              hasProcess: !!workspace.process,
              updatedAt: workspace.updated_at,
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
 * Get the values and process documents from workspace storage.
 */
export async function handleGetTeamConstitution(args: unknown, dataComposer: DataComposer) {
  const params = getTeamConstitutionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const supabase = dataComposer.getClient();
  const workspaceId = await resolveWorkspaceId(supabase, user.id, params.workspaceId);

  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('id, shared_values, process, updated_at')
    .eq('id', workspaceId)
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get workspace constitution: ${error.message}`);
  }

  // Fall back to user_identity if workspace columns are empty
  let sharedValues = workspace?.shared_values as string | null;
  let process = workspace?.process as string | null;

  if (!sharedValues || !process) {
    const { data: identity } = await supabase
      .from('user_identity')
      .select('shared_values_md, process_md')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single();

    if (identity) {
      if (!sharedValues) sharedValues = identity.shared_values_md;
      if (!process) process = identity.process_md;
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            workspace: { id: workspaceId },
            constitution: {
              sharedValues,
              process,
              updatedAt: workspace?.updated_at || null,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
