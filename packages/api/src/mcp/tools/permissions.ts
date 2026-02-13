/**
 * MCP Tools for Permission Management and Audit Logging
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { getPermissionsService, type PermissionId } from '../../services/permissions';
import { getAuditService, type AuditAction, type AuditCategory } from '../../services/audit';
import { getClaudeCodeAdapter } from '../../agent/adapters';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';

// ============== Schemas ==============

const permissionIdSchema = z.enum([
  'web_search',
  'web_fetch',
  'bash_curl',
  'bash_general',
  'file_read',
  'file_write',
  'mcp_tools',
]);

export const listPermissionsSchema = z.object({});

export const getUserPermissionsSchema = userIdentifierBaseSchema;

export const setPermissionSchema = userIdentifierBaseSchema.extend({
  permissionId: permissionIdSchema.describe('The permission to enable/disable'),
  enabled: z.boolean().describe('Whether to enable or disable the permission'),
  reason: z.string().optional().describe('Reason for the change'),
  expiresInHours: z.number().positive().optional().describe('Auto-expire after N hours'),
});

export const resetPermissionSchema = userIdentifierBaseSchema.extend({
  permissionId: permissionIdSchema.describe('The permission to reset to default'),
});

export const queryAuditLogSchema = userIdentifierBaseSchema.extend({
  action: z
    .enum([
      'web_search',
      'web_fetch',
      'bash_curl',
      'bash_command',
      'file_read',
      'file_write',
      'permission_change',
      'auth_login',
      'auth_logout',
      'group_authorize',
      'group_revoke',
      'trusted_user_add',
      'trusted_user_remove',
    ])
    .optional()
    .describe('Filter by action type'),
  category: z
    .enum(['network', 'filesystem', 'permission', 'auth', 'execution'])
    .optional()
    .describe('Filter by category'),
  status: z.enum(['success', 'blocked', 'error']).optional().describe('Filter by status'),
  hoursBack: z.number().positive().default(24).describe('How many hours back to query'),
  limit: z.number().positive().max(100).default(50).describe('Max results'),
});

export const getActivitySummarySchema = userIdentifierBaseSchema.extend({
  hours: z.number().positive().default(24).describe('Hours to summarize'),
});

// ============== Handlers ==============

export async function handleListPermissions() {
  const service = getPermissionsService();
  const definitions = await service.getDefinitions();

  const permissions = Array.from(definitions.values()).map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    riskLevel: d.riskLevel,
    defaultEnabled: d.defaultEnabled,
  }));

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            count: permissions.length,
            permissions,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetUserPermissions(args: unknown, dataComposer: DataComposer) {
  const params = getUserPermissionsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const service = getPermissionsService();
  const effective = await service.getEffectivePermissions(user.id);
  const overrides = await service.getUserOverrides(user.id);

  // Get adapter translation for documentation
  const adapter = getClaudeCodeAdapter();
  const backendConfig = adapter.translate(effective);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            permissions: {
              enabled: effective.enabled,
              disabled: effective.disabled,
            },
            overrides: overrides.map((o) => ({
              permissionId: o.permissionId,
              enabled: o.enabled,
              reason: o.reason,
              expiresAt: o.expiresAt?.toISOString(),
            })),
            backendTranslation: {
              backend: backendConfig.backend,
              summary: backendConfig.summary,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleSetPermission(args: unknown, dataComposer: DataComposer) {
  const params = setPermissionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const service = getPermissionsService();
  const auditService = getAuditService();

  const expiresAt = params.expiresInHours
    ? new Date(Date.now() + params.expiresInHours * 60 * 60 * 1000)
    : undefined;

  const result = await service.setPermission(
    user.id,
    params.permissionId as PermissionId,
    params.enabled,
    {
      reason: params.reason,
      expiresAt,
    }
  );

  if (result.success) {
    // Log the permission change
    await auditService.logPermissionChange(user.id, params.permissionId, params.enabled, {
      reason: params.reason,
    });
  }

  logger.info('Permission updated', {
    userId: user.id,
    permissionId: params.permissionId,
    enabled: params.enabled,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: result.success,
            error: result.error,
            user: { id: user.id, resolvedBy },
            permission: {
              id: params.permissionId,
              enabled: params.enabled,
              expiresAt: expiresAt?.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleResetPermission(args: unknown, dataComposer: DataComposer) {
  const params = resetPermissionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const service = getPermissionsService();
  await service.resetPermission(user.id, params.permissionId as PermissionId);

  logger.info('Permission reset to default', {
    userId: user.id,
    permissionId: params.permissionId,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            message: `Permission ${params.permissionId} reset to default`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleQueryAuditLog(args: unknown, dataComposer: DataComposer) {
  const params = queryAuditLogSchema.parse(args);

  // User is optional for audit queries (can query all if admin)
  let userId: string | undefined;
  if (params.userId || params.email || params.phone || (params.platform && params.platformId)) {
    const { user } = await resolveUserOrThrow(params, dataComposer);
    userId = user.id;
  }

  const service = getAuditService();
  const startDate = new Date(Date.now() - (params.hoursBack || 24) * 60 * 60 * 1000);

  const logs = await service.query({
    userId,
    action: params.action as AuditAction | undefined,
    category: params.category as AuditCategory | undefined,
    status: params.status,
    startDate,
    limit: params.limit || 50,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            count: logs.length,
            timeRange: {
              start: startDate.toISOString(),
              end: new Date().toISOString(),
            },
            logs: logs.map((l) => ({
              id: l.id,
              timestamp: l.timestamp.toISOString(),
              action: l.action,
              category: l.category,
              target: l.target,
              status: l.responseStatus,
              summary: l.requestSummary || l.responseSummary,
              userId: l.userId,
              platform: l.platform,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetActivitySummary(args: unknown, dataComposer: DataComposer) {
  const params = getActivitySummarySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const service = getAuditService();
  const summary = await service.getUserActivitySummary(user.id, params.hours || 24);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            hours: params.hours || 24,
            activity: summary,
            total: summary.reduce((sum, s) => sum + s.count, 0),
          },
          null,
          2
        ),
      },
    ],
  };
}
