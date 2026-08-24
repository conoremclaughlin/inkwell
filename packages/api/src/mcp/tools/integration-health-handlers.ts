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
 * What `get_integration_health` reports back. Wider than the four storable
 * statuses by one: `unknown` means no service-level check has been recorded, and
 * it is deliberately not writable — you should not be able to file a report
 * saying you did not look.
 */
type ReportedStatus = HealthStatus | 'unknown';

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

    // The only service-level evidence that exists is what an agent reported.
    // Reported months ago it is still the only evidence there is — `stale` and
    // `lastCheckAgeSeconds` say how much to trust it.
    const reported = row
      ? {
          ...base,
          status: row.status as ReportedStatus,
          errorCode: row.error_code ?? null,
          errorMessage: row.error_message ?? null,
          source: 'cached' as const,
          stale: cachedStale,
        }
      : {
          // Nobody has ever looked. That is not the same as working, and it is
          // not the same as broken.
          ...base,
          status: 'unknown' as ReportedStatus,
          errorCode: 'never_reported',
          errorMessage: `No service-level health has ever been reported for ${service}`,
          source: 'unknown' as const,
          stale: true,
        };

    if (!live) return reported;

    const accountState = accountHealthOf(live);
    const account = {
      accountHealth: accountState,
      accountStatus: live.accountStatus,
      accountReason: live.reason,
      accountObservedAt: live.observedAt,
      accountLastUsedAt: live.lastUsedAt,
      tokenExpiresAt: live.expiresAt,
      providerLastError: live.lastError,
    };

    // One rule decides the rest: account state can LOWER a service verdict,
    // never raise it.
    //
    // A credential that cannot be used rules the service out no matter what
    // anyone observed — no call can succeed — so it is the one case where the
    // account decides `status` outright.
    if (live.state === 'unusable' || live.state === 'missing') {
      const liveStatus: ReportedStatus = live.state === 'missing' ? 'not_configured' : 'error';
      return {
        ...base,
        status: liveStatus,
        errorCode: `oauth_${live.accountStatus ?? 'missing'}`,
        errorMessage: live.reason,
        source: 'live' as const,
        // Derived from account rows the OAuth service maintains on every call,
        // so it is current by construction.
        stale: false,
        ...account,
        // A disagreeing report is kept rather than dropped: an agent may have
        // seen something the account table cannot represent.
        ...(row && row.status !== liveStatus
          ? {
              supersededCachedStatus: row.status,
              lastReportedError: row.error_message ?? row.error_code ?? null,
            }
          : {}),
      };
    }

    // Everything else — a working credential, or one we failed to read — is not
    // evidence about the service. Promoting it to `status: healthy` is what made
    // the original bug possible: an outage would be declared recovered the hour
    // after it was reported, on the strength of an OAuth row nobody had probed.
    // So the reported verdict stands, with the account state alongside it.
    //
    // The single exception is downward: a pending refresh may fail on the next
    // call, so nothing is called healthy while one is outstanding.
    const status: ReportedStatus =
      accountState === 'refresh_required' && reported.status === 'healthy'
        ? 'degraded'
        : reported.status;

    return { ...reported, status, ...account };
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
