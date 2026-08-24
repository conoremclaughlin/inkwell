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

/**
 * What the OAuth account proves, kept separate from what the service is doing.
 * An account is credentials; a service is Gmail answering or not. They fail
 * independently and this tool must not conflate them.
 */
type AccountHealth = 'ok' | 'refresh_required' | 'unusable' | 'not_connected' | 'unknown';

function accountHealthOf(account: ProviderAccountHealth): AccountHealth {
  switch (account.state) {
    case 'active':
      return 'ok';
    case 'refresh_required':
      return 'refresh_required';
    case 'unusable':
      return 'unusable';
    case 'missing':
      return 'not_connected';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * The verdict an account can support on its own, used only when there is no
 * fresher service-level report to defer to. `refresh_required` is degraded and
 * not healthy: the credential works this second and may not on the next call.
 */
function statusFromAccount(account: ProviderAccountHealth): HealthStatus {
  switch (account.state) {
    case 'active':
      return 'healthy';
    case 'refresh_required':
      return 'degraded';
    case 'missing':
      return 'not_configured';
    default:
      return 'error';
  }
}

function errorCodeFromAccount(account: ProviderAccountHealth): string | null {
  switch (account.state) {
    case 'active':
      return null;
    case 'refresh_required':
      return 'oauth_refresh_required';
    case 'unknown':
      return 'oauth_inspection_failed';
    default:
      return `oauth_${account.accountStatus ?? 'missing'}`;
  }
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

  const upsertData = {
    user_id: user.id,
    service: params.service,
    status: params.status,
    error_code: isHealthy ? null : (params.errorCode ?? null),
    error_message: isHealthy ? null : (params.errorMessage ?? null),
    last_check_at: now,
    // "When did this last work?" is at its most useful during an outage, so a
    // non-healthy report must not clear it. The value written here is advisory:
    // the integration_health_retain_last_healthy_at trigger owns the column and
    // keeps the stored timestamp on any non-healthy write. Preserving it here
    // instead would mean a read followed by a write — a lost update whenever a
    // healthy report lands between the two, and an erasure whenever the read
    // fails.
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

  const cachedRows = data ?? [];

  // Which OAuth-backed services to answer for. An explicit `service` filter must
  // always get a verdict, even with no cached row — otherwise "is Gmail up?"
  // returns an empty list, which reads as reassuring and means nothing.
  //
  // The unfiltered call enumerates every OAuth-backed service outright rather
  // than discovering them from the cache. Reading the cache to decide what to
  // inspect made liveness conditional on somebody having hand-written a row
  // first: a freshly connected account with no rows got `count: 0` from the
  // default heartbeat call — the same ambiguous silence this PR exists to end.
  const oauthServices = new Set<string>();
  if (params.service) {
    if (OAUTH_BACKED_SERVICES[params.service]) oauthServices.add(params.service);
  } else {
    for (const service of Object.keys(OAUTH_BACKED_SERVICES)) oauthServices.add(service);
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
  const services = [
    ...new Set([
      ...cachedByService.keys(),
      ...oauthServices,
      // A filter names a service the caller cares about. Answer for it whether or
      // not it is OAuth-backed and whether or not anyone has ever reported on it.
      ...(params.service ? [params.service] : []),
    ]),
  ].sort();

  const integrations = services.map((service) => {
    const row = cachedByService.get(service);
    const provider = OAUTH_BACKED_SERVICES[service];
    const live = provider ? accountHealth.get(provider) : undefined;

    const cachedAge = ageSeconds(row?.last_check_at ?? null);
    const cachedStale = cachedAge === null || cachedAge * 1000 > STALE_AFTER_MS;
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

    const cached = {
      ...base,
      status: (row?.status ?? 'not_configured') as HealthStatus,
      errorCode: row?.error_code ?? null,
      errorMessage: row?.error_message ?? null,
      source: 'cached' as const,
      stale: cachedStale,
    };

    if (!live) {
      // Nothing authoritative to consult — report the cache, but say how old it is.
      if (row) return cached;
      // Asked about a service nobody has ever reported on and that has no live
      // signal to derive one from. Say that, rather than returning nothing and
      // letting the silence be read as good news.
      return {
        ...base,
        status: 'not_configured' as HealthStatus,
        errorCode: 'never_reported',
        errorMessage: `No health has ever been reported for ${service}, and it has no live signal to derive one from`,
        source: 'unknown' as const,
        stale: true,
      };
    }

    const account = {
      accountHealth: accountHealthOf(live),
      accountStatus: live.accountStatus,
      accountObservedAt: live.observedAt,
      accountLastUsedAt: live.lastUsedAt,
      tokenExpiresAt: live.expiresAt,
      providerLastError: live.lastError,
    };

    // A usable credential proves that auth works, and nothing more. Gmail can be
    // rate limited, missing a scope, or simply down while the account stays
    // perfectly active — connected_accounts has no column that could say so. So
    // when an agent has reported a service-level failure *recently*, that report
    // is the better evidence and it stands; the account state travels alongside
    // it as `accountHealth` rather than overwriting it. An unusable credential is
    // the reverse: no call can succeed, so it does override a cached claim.
    const authUsable = live.state === 'active' || live.state === 'refresh_required';
    if (authUsable && row && row.status !== 'healthy' && !cachedStale) {
      return { ...cached, ...account };
    }

    const liveStatus = statusFromAccount(live);
    return {
      ...base,
      status: liveStatus,
      errorCode: errorCodeFromAccount(live),
      errorMessage: live.reason,
      // 'unknown' is not a live reading — the account lookup itself failed, so
      // nothing about the present has been established.
      source: live.state === 'unknown' ? ('unknown' as const) : ('live' as const),
      // Live state is derived from account rows the OAuth service maintains on
      // every call, so it is current by construction.
      stale: live.state === 'unknown',
      ...account,
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
