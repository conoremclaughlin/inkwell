import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type { Json } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';

const VALID_STATUSES = ['healthy', 'degraded', 'error', 'not_configured'] as const;

export const updateIntegrationHealthSchema = userIdentifierBaseSchema.extend({
  service: z
    .string()
    .describe('Service name (e.g., "google_calendar", "google_gmail", "telegram")'),
  status: z.enum(VALID_STATUSES).describe('Current health status'),
  errorCode: z
    .string()
    .optional()
    .describe('Structured error code (e.g., "oauth_expired", "rate_limited")'),
  errorMessage: z.string().optional().describe('Human-readable error description'),
  agentId: z.string().optional().describe('Which SB is reporting this'),
  metadata: z.record(z.unknown()).optional().describe('Additional context'),
});

export const getIntegrationHealthSchema = userIdentifierBaseSchema.extend({
  service: z.string().optional().describe('Filter to a specific service (omit for all)'),
});

export async function handleUpdateIntegrationHealth(args: unknown, dataComposer: DataComposer) {
  const params = updateIntegrationHealthSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const now = new Date().toISOString();
  const isHealthy = params.status === 'healthy';

  const upsertData = {
    user_id: user.id,
    service: params.service,
    status: params.status,
    error_code: isHealthy ? null : (params.errorCode ?? null),
    error_message: isHealthy ? null : (params.errorMessage ?? null),
    last_check_at: now,
    last_healthy_at: isHealthy ? now : null,
    reported_by_agent_id: params.agentId ?? null,
    metadata: (params.metadata ?? {}) as Json,
    updated_at: now,
  };

  const { data, error } = await dataComposer
    .getClient()
    .from('integration_health')
    .upsert(upsertData, { onConflict: 'user_id,service' })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to update integration health: ${error?.message ?? 'no data returned'}`);
  }

  logger.info(
    `Integration health updated: ${params.service}=${params.status} for user ${user.id}`,
    { service: params.service, status: params.status, resolvedBy }
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            health: {
              id: data.id,
              service: data.service,
              status: data.status,
              errorCode: data.error_code,
              errorMessage: data.error_message,
              lastCheckAt: data.last_check_at,
              lastHealthyAt: data.last_healthy_at,
              reportedByAgentId: data.reported_by_agent_id,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetIntegrationHealth(args: unknown, dataComposer: DataComposer) {
  const params = getIntegrationHealthSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let query = dataComposer
    .getClient()
    .from('integration_health')
    .select('*')
    .eq('user_id', user.id)
    .order('service');

  if (params.service) {
    query = query.eq('service', params.service);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to get integration health: ${error.message}`);
  }

  logger.info(`Integration health queried: ${data?.length ?? 0} entries for user ${user.id}`, {
    resolvedBy,
    service: params.service,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: data?.length ?? 0,
            integrations: (data ?? []).map((row) => ({
              id: row.id,
              service: row.service,
              status: row.status,
              errorCode: row.error_code,
              errorMessage: row.error_message,
              lastCheckAt: row.last_check_at,
              lastHealthyAt: row.last_healthy_at,
              reportedByAgentId: row.reported_by_agent_id,
              metadata: row.metadata,
              updatedAt: row.updated_at,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}
