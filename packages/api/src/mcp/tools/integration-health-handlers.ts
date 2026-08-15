import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type { Json } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { getOAuthService, type ProviderAccountHealth } from '../../services/oauth';

const VALID_STATUSES = ['healthy', 'degraded', 'error', 'not_configured'] as const;

type HealthStatus = (typeof VALID_STATUSES)[number];

/**
 * Services whose real availability is decided by an OAuth account rather than by
 * whatever an agent last wrote to integration_health. Listed explicitly so that
 * a future `google_*` service which is not OAuth-backed cannot be swept in by a
 * prefix match.
 */
const OAUTH_BACKED_SERVICES: Record<string, string> = {
  google_calendar: 'google',
  google_gmail: 'google',
  google_docs: 'google',
  google_drive: 'google',
  google_sheets: 'google',
};

/**
 * How old a hand-reported row may be before callers should stop reading it as a
 * statement about the present. Rows carry their age either way; this only decides
 * where the `stale` flag flips.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

function ageSeconds(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

function statusFromAccount(account: ProviderAccountHealth): HealthStatus {
  if (account.state === 'active') return 'healthy';
  if (account.state === 'missing') return 'not_configured';
  return 'error';
}

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

  // "When did this last work?" is at its most useful during an outage, so a
  // non-healthy report must not clear it. Carry the stored value forward.
  let lastHealthyAt: string | null = now;
  if (!isHealthy) {
    const { data: existing } = await dataComposer
      .getClient()
      .from('integration_health')
      .select('last_healthy_at')
      .eq('user_id', user.id)
      .eq('service', params.service)
      .maybeSingle();

    lastHealthyAt = existing?.last_healthy_at ?? null;
  }

  const upsertData = {
    user_id: user.id,
    service: params.service,
    status: params.status,
    error_code: isHealthy ? null : (params.errorCode ?? null),
    error_message: isHealthy ? null : (params.errorMessage ?? null),
    last_check_at: now,
    last_healthy_at: lastHealthyAt,
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

  const cachedRows = data ?? [];

  // Which OAuth-backed services to answer for. An explicit `service` filter must
  // always get a verdict, even with no cached row — otherwise "is Gmail up?"
  // returns an empty list, which reads as reassuring and means nothing.
  const oauthServices = new Set<string>();
  if (params.service) {
    if (OAUTH_BACKED_SERVICES[params.service]) oauthServices.add(params.service);
  } else {
    for (const row of cachedRows) {
      if (OAUTH_BACKED_SERVICES[row.service]) oauthServices.add(row.service);
    }
  }

  // One lookup per provider rather than per service — the five google_* services
  // all share a single connected account.
  const providers = new Set([...oauthServices].map((s) => OAUTH_BACKED_SERVICES[s]));
  const accountHealth = new Map<string, ProviderAccountHealth>();
  await Promise.all(
    [...providers].map(async (provider) => {
      accountHealth.set(provider, await getOAuthService().inspectAccountHealth(user.id, provider));
    })
  );

  const cachedByService = new Map(cachedRows.map((row) => [row.service, row]));
  const services = [...new Set([...cachedByService.keys(), ...oauthServices])].sort();

  const integrations = services.map((service) => {
    const row = cachedByService.get(service);
    const provider = OAUTH_BACKED_SERVICES[service];
    const live = provider ? accountHealth.get(provider) : undefined;

    const cachedAge = ageSeconds(row?.last_check_at ?? null);
    const base = {
      id: row?.id ?? null,
      service,
      lastHealthyAt: row?.last_healthy_at ?? null,
      reportedByAgentId: row?.reported_by_agent_id ?? null,
      metadata: row?.metadata ?? {},
      updatedAt: row?.updated_at ?? null,
      lastCheckAt: row?.last_check_at ?? null,
      lastCheckAgeSeconds: cachedAge,
    };

    if (!live) {
      // Nothing authoritative to consult — report the cache, but say how old it is.
      return {
        ...base,
        status: (row?.status ?? 'not_configured') as HealthStatus,
        errorCode: row?.error_code ?? null,
        errorMessage: row?.error_message ?? null,
        source: 'cached' as const,
        stale: cachedAge === null || cachedAge * 1000 > STALE_AFTER_MS,
      };
    }

    const liveStatus = statusFromAccount(live);
    return {
      ...base,
      status: liveStatus,
      errorCode: live.state === 'active' ? null : `oauth_${live.accountStatus ?? 'missing'}`,
      errorMessage: live.reason,
      source: 'live' as const,
      // Derived from account state the OAuth service maintains on every call, so
      // it is current by construction.
      stale: false,
      accountStatus: live.accountStatus,
      accountObservedAt: live.observedAt,
      accountLastUsedAt: live.lastUsedAt,
      tokenExpiresAt: live.expiresAt,
      providerLastError: live.lastError,
      // A disagreeing hand-written row is kept rather than dropped: an agent may
      // have seen a failure the account table cannot represent.
      ...(row && row.status !== liveStatus
        ? {
            supersededCachedStatus: row.status,
            lastReportedError: row.error_message ?? row.error_code ?? null,
          }
        : {}),
    };
  });

  const unhealthy = integrations.filter((i) => i.status !== 'healthy').map((i) => i.service);

  logger.info(`Integration health queried: ${integrations.length} entries for user ${user.id}`, {
    resolvedBy,
    service: params.service,
    unhealthy,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: integrations.length,
            staleAfterSeconds: STALE_AFTER_MS / 1000,
            integrations,
          },
          null,
          2
        ),
      },
    ],
  };
}
