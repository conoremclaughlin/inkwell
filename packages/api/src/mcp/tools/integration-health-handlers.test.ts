/**
 * Integration Health Handler Tests
 *
 * The bug these guard against: get_integration_health reported google_calendar
 * and google_gmail as "healthy" off rows written two months earlier, while both
 * services were in fact dead. Myra nearly relayed that to Conor as a liveness
 * signal (thread:integration-health-staleness, 2026-08-14).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { createTableAwareSupabaseMock } from '../../test/table-aware-supabase-mock';
import type { ProviderAccountHealth } from '../../services/oauth';
import {
  handleGetIntegrationHealth,
  handleUpdateIntegrationHealth,
} from './integration-health-handlers';

const USER_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    // Literal, not USER_ID — vi.mock factories are hoisted above const init.
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: '00000000-0000-0000-0000-000000000001' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const inspectAccountHealth = vi.fn<[string, string, unknown?], Promise<ProviderAccountHealth>>();

vi.mock('../../services/oauth', () => ({
  getOAuthService: () => ({ inspectAccountHealth }),
}));

/** The account state Conor's Google row was actually in during the outage. */
const EXPIRED_GOOGLE: ProviderAccountHealth = {
  state: 'unusable',
  accountStatus: 'expired',
  reason: 'No active google account found (stored status: expired)',
  lastError: 'Failed to refresh google token',
  expiresAt: '2026-08-14T18:00:00.000Z',
  lastUsedAt: '2026-08-14T18:00:00.000Z',
  observedAt: '2026-08-15T01:00:00.000Z',
};

const ACTIVE_GOOGLE: ProviderAccountHealth = {
  state: 'active',
  accountStatus: 'active',
  reason: null,
  lastError: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  lastUsedAt: '2026-08-16T17:00:00.000Z',
  observedAt: '2026-08-16T17:00:00.000Z',
};

/** Stored status is still 'active', but the next call has to refresh first. */
const REFRESHING_GOOGLE: ProviderAccountHealth = {
  state: 'refresh_required',
  accountStatus: 'active',
  reason:
    'Access token expires at 2026-08-15T17:02:00.000Z; the next call must refresh it first, and that refresh may fail',
  lastError: null,
  expiresAt: '2026-08-15T17:02:00.000Z',
  lastUsedAt: '2026-08-15T16:00:00.000Z',
  observedAt: '2026-08-15T16:00:00.000Z',
};

/** The account table could not be read at all. */
const UNKNOWN_GOOGLE: ProviderAccountHealth = {
  state: 'unknown',
  accountStatus: null,
  reason: 'Could not read account state: connection reset',
  lastError: null,
  expiresAt: null,
  lastUsedAt: null,
  observedAt: null,
};

/** A row like the one Myra hit: written 2026-06-21, claiming healthy. */
function staleHealthyRow(service: string) {
  return {
    id: `row-${service}`,
    service,
    status: 'healthy',
    error_code: null,
    error_message: null,
    last_check_at: '2026-06-21T09:40:00.000Z',
    last_healthy_at: '2026-06-21T09:40:00.000Z',
    reported_by_agent_id: 'wren',
    metadata: {},
    updated_at: '2026-06-21T09:40:00.000Z',
  };
}

/** An agent-reported service failure, written minutes ago rather than months. */
function freshRow(service: string, overrides: Record<string, unknown> = {}) {
  return {
    ...staleHealthyRow(service),
    status: 'error',
    error_code: 'rate_limited',
    error_message: 'Gmail returned 429',
    reported_by_agent_id: 'myra',
    last_check_at: '2026-08-15T16:45:00.000Z',
    updated_at: '2026-08-15T16:45:00.000Z',
    ...overrides,
  };
}

function serviceIn(body: { integrations: Array<{ service: string }> }, service: string) {
  const found = body.integrations.find((i) => i.service === service);
  if (!found) throw new Error(`no verdict returned for ${service}`);
  return found as Record<string, unknown>;
}

function composerFor(specs: Parameters<typeof createTableAwareSupabaseMock>[0]) {
  const mock = createTableAwareSupabaseMock(specs);
  return {
    composer: { getClient: () => ({ from: mock.from }) } as unknown as DataComposer,
    mock,
  };
}

function parse(result: Awaited<ReturnType<typeof handleGetIntegrationHealth>>) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  inspectAccountHealth.mockReset();
  vi.useFakeTimers();
  // Well past the June 21 rows, so their age is unambiguous.
  vi.setSystemTime(new Date('2026-08-15T17:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleGetIntegrationHealth — live status for OAuth-backed services', () => {
  it('reports error for a dead Google account even though the cached row says healthy', async () => {
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [staleHealthyRow('google_gmail')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = body.integrations.find((i: { service: string }) => i.service === 'google_gmail');

    expect(gmail.status).toBe('error');
    expect(gmail.source).toBe('live');
    expect(gmail.errorMessage).toContain('No active google account found');
    expect(gmail.providerLastError).toBe('Failed to refresh google token');
  });

  it('retains the contradicted cached status instead of silently dropping it', async () => {
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [staleHealthyRow('google_calendar')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const cal = serviceIn(body, 'google_calendar');

    expect(cal.supersededCachedStatus).toBe('healthy');
    expect(cal.lastHealthyAt).toBe('2026-06-21T09:40:00.000Z');
  });

  it('resolves every google_* service from a single account lookup', async () => {
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [
        {
          then: {
            data: [
              staleHealthyRow('google_gmail'),
              staleHealthyRow('google_calendar'),
              staleHealthyRow('google_drive'),
            ],
            error: null,
          },
        },
      ],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));

    expect(body.integrations.map((i: { service: string }) => i.service)).toEqual([
      'google_calendar',
      'google_docs',
      'google_drive',
      'google_gmail',
      'google_sheets',
    ]);
    expect(body.integrations.every((i: { status: string }) => i.status === 'error')).toBe(true);
    // Five services, one provider, one query.
    expect(inspectAccountHealth).toHaveBeenCalledTimes(1);
    expect(inspectAccountHealth).toHaveBeenCalledWith(USER_ID, 'google');
  });

  it('inspects OAuth services the cache has never heard of', async () => {
    // The default heartbeat call on a freshly connected account: zero cached
    // rows. Discovering services from the cache made this return count: 0 —
    // the same ambiguous silence the tool exists to eliminate.
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));

    expect(body.count).toBe(5);
    expect(serviceIn(body, 'google_gmail').status).toBe('error');
    expect(serviceIn(body, 'google_gmail').source).toBe('live');
    expect(serviceIn(body, 'google_gmail').id).toBeNull();
  });

  it('reports healthy from live state when the account is usable', async () => {
    inspectAccountHealth.mockResolvedValue(ACTIVE_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [staleHealthyRow('google_gmail')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('healthy');
    expect(gmail.source).toBe('live');
    expect(gmail.stale).toBe(false);
    expect(gmail.accountHealth).toBe('ok');
    expect(gmail.supersededCachedStatus).toBeUndefined();
  });

  it('answers an explicit service filter that has no cached row at all', async () => {
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(
      await handleGetIntegrationHealth({ userId: USER_ID, service: 'google_gmail' }, composer)
    );

    // An empty list would read as reassuring and mean nothing.
    expect(body.count).toBe(1);
    expect(body.integrations[0].service).toBe('google_gmail');
    expect(body.integrations[0].status).toBe('error');
    expect(body.integrations[0].id).toBeNull();
  });
});

describe('handleGetIntegrationHealth — account health is not service health', () => {
  it('lets a fresh agent-reported failure stand over a perfectly active account', async () => {
    // connected_accounts has no column that can say "Gmail returned 429". An
    // active credential proves auth works and nothing else, so it must not
    // overwrite a service failure someone actually observed minutes ago.
    inspectAccountHealth.mockResolvedValue(ACTIVE_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [freshRow('google_gmail')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('error');
    expect(gmail.source).toBe('cached');
    expect(gmail.errorCode).toBe('rate_limited');
    expect(gmail.stale).toBe(false);
    // The account state travels alongside the verdict rather than replacing it.
    expect(gmail.accountHealth).toBe('ok');
    expect(gmail.accountStatus).toBe('active');
  });

  it('stops deferring to an agent report once it goes stale', async () => {
    inspectAccountHealth.mockResolvedValue(ACTIVE_GOOGLE);
    const { composer } = composerFor({
      integration_health: [
        {
          then: {
            data: [freshRow('google_gmail', { last_check_at: '2026-06-21T09:40:00.000Z' })],
            error: null,
          },
        },
      ],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('healthy');
    expect(gmail.source).toBe('live');
    expect(gmail.supersededCachedStatus).toBe('error');
  });

  it('overrides even a fresh healthy report when the credential is unusable', async () => {
    // The other direction: no call can succeed without a usable account, so
    // this one verdict genuinely is authoritative.
    inspectAccountHealth.mockResolvedValue(EXPIRED_GOOGLE);
    const { composer } = composerFor({
      integration_health: [
        {
          then: {
            data: [freshRow('google_gmail', { status: 'healthy', error_code: null })],
            error: null,
          },
        },
      ],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('error');
    expect(gmail.source).toBe('live');
    expect(gmail.accountHealth).toBe('unusable');
  });

  it('reports an account awaiting refresh as degraded, never healthy', async () => {
    inspectAccountHealth.mockResolvedValue(REFRESHING_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('degraded');
    expect(gmail.status).not.toBe('healthy');
    expect(gmail.accountHealth).toBe('refresh_required');
    expect(gmail.errorCode).toBe('oauth_refresh_required');
    expect(gmail.errorMessage).toContain('may fail');
  });

  it('still defers to a fresh service failure while a refresh is pending', async () => {
    inspectAccountHealth.mockResolvedValue(REFRESHING_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [freshRow('google_gmail')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('error');
    expect(gmail.source).toBe('cached');
    expect(gmail.accountHealth).toBe('refresh_required');
  });

  it('does not turn a failed account lookup into a confident not_configured', async () => {
    inspectAccountHealth.mockResolvedValue(UNKNOWN_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).not.toBe('not_configured');
    expect(gmail.status).toBe('error');
    expect(gmail.errorCode).toBe('oauth_inspection_failed');
    // Not a live reading — the lookup itself is what failed.
    expect(gmail.source).toBe('unknown');
    expect(gmail.stale).toBe(true);
    expect(gmail.accountHealth).toBe('unknown');
  });

  it('reports a genuinely unconnected provider as not_configured', async () => {
    inspectAccountHealth.mockResolvedValue({
      state: 'missing',
      accountStatus: null,
      reason: 'No google account has been connected',
      lastError: null,
      expiresAt: null,
      lastUsedAt: null,
      observedAt: null,
    });
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
    const gmail = serviceIn(body, 'google_gmail');

    expect(gmail.status).toBe('not_configured');
    expect(gmail.source).toBe('live');
    expect(gmail.accountHealth).toBe('not_connected');
  });
});

describe('handleGetIntegrationHealth — staleness for services with no live signal', () => {
  it('flags an old hand-written row as stale and reports its age', async () => {
    const { composer } = composerFor({
      integration_health: [
        {
          then: {
            data: [{ ...staleHealthyRow('telegram'), service: 'telegram' }],
            error: null,
          },
        },
      ],
    });

    const body = parse(
      await handleGetIntegrationHealth({ userId: USER_ID, service: 'telegram' }, composer)
    );
    const telegram = body.integrations[0];

    expect(telegram.source).toBe('cached');
    expect(telegram.stale).toBe(true);
    // 2026-06-21T09:40Z → 2026-08-15T17:00Z is ~55 days.
    expect(telegram.lastCheckAgeSeconds).toBeGreaterThan(54 * 24 * 60 * 60);
    expect(body.staleAfterSeconds).toBe(3600);
    // No account lookup for a service with no OAuth provider.
    expect(inspectAccountHealth).not.toHaveBeenCalled();
  });

  it('does not flag a freshly written row as stale', async () => {
    const fresh = {
      ...staleHealthyRow('telegram'),
      service: 'telegram',
      last_check_at: '2026-08-15T16:45:00.000Z',
    };
    const { composer } = composerFor({
      integration_health: [{ then: { data: [fresh], error: null } }],
    });

    const body = parse(
      await handleGetIntegrationHealth({ userId: USER_ID, service: 'telegram' }, composer)
    );

    expect(body.integrations[0].stale).toBe(false);
    expect(body.integrations[0].lastCheckAgeSeconds).toBe(15 * 60);
  });

  it('treats a row with no lastCheckAt as stale rather than current', async () => {
    const undated = { ...staleHealthyRow('telegram'), service: 'telegram', last_check_at: null };
    const { composer } = composerFor({
      integration_health: [{ then: { data: [undated], error: null } }],
    });

    const body = parse(
      await handleGetIntegrationHealth({ userId: USER_ID, service: 'telegram' }, composer)
    );

    expect(body.integrations[0].stale).toBe(true);
    expect(body.integrations[0].lastCheckAgeSeconds).toBeNull();
  });

  it('answers for a non-OAuth service nobody has ever reported on', async () => {
    const { composer } = composerFor({
      integration_health: [{ then: { data: [], error: null } }],
    });

    const body = parse(
      await handleGetIntegrationHealth({ userId: USER_ID, service: 'telegram' }, composer)
    );

    expect(body.count).toBe(1);
    expect(body.integrations[0].source).toBe('unknown');
    expect(body.integrations[0].errorCode).toBe('never_reported');
    expect(body.integrations[0].stale).toBe(true);
  });
});

describe('handleUpdateIntegrationHealth — last_healthy_at retention', () => {
  it('reports a failure in one statement, with no read to lose a race against', async () => {
    // Retention itself is enforced by the integration_health_retain_last_healthy_at
    // trigger and covered against a real database in the integration suite. What
    // this file guards is that the handler no longer reads-then-writes: that
    // sequence dropped a concurrent healthy stamp, and turned a failed read into
    // an erasure.
    const { composer, mock } = composerFor({
      integration_health: [
        {
          single: [
            {
              data: {
                id: 'row-1',
                service: 'google_gmail',
                status: 'error',
                error_code: 'oauth_expired',
                error_message: 'Failed to refresh google token',
                last_check_at: '2026-08-15T17:00:00.000Z',
                last_healthy_at: '2026-06-21T09:40:00.000Z',
                reported_by_agent_id: 'myra',
              },
              error: null,
            },
          ],
        },
      ],
    });

    const result = await handleUpdateIntegrationHealth(
      {
        userId: USER_ID,
        service: 'google_gmail',
        status: 'error',
        errorCode: 'oauth_expired',
        errorMessage: 'Failed to refresh google token',
        agentId: 'myra',
      },
      composer
    );

    // One statement total — the pre-read is gone.
    expect(mock.calls).toHaveLength(1);
    const written = (mock.calls[0].builder.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.status).toBe('error');

    // The value the database kept is what the caller is told.
    const body = JSON.parse(result.content[0].text);
    expect(body.health.lastHealthyAt).toBe('2026-06-21T09:40:00.000Z');
  });

  it('stamps last_healthy_at as now when reporting healthy', async () => {
    const { composer, mock } = composerFor({
      integration_health: [
        {
          single: [
            {
              data: {
                id: 'row-1',
                service: 'telegram',
                status: 'healthy',
                error_code: null,
                error_message: null,
                last_check_at: '2026-08-15T17:00:00.000Z',
                last_healthy_at: '2026-08-15T17:00:00.000Z',
                reported_by_agent_id: 'wren',
              },
              error: null,
            },
          ],
        },
      ],
    });

    await handleUpdateIntegrationHealth(
      { userId: USER_ID, service: 'telegram', status: 'healthy', agentId: 'wren' },
      composer
    );

    const upsertCall = mock.calls.find(
      (c) => (c.builder.upsert as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    const written = (upsertCall!.builder.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(written.last_healthy_at).toBe('2026-08-15T17:00:00.000Z');
    // No pre-read needed on the healthy path.
    expect(mock.calls).toHaveLength(1);
  });
});
