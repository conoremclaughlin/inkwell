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
import { handleGetIntegrationHealth } from './integration-health-handlers';

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
    const cal = body.integrations[0];

    expect(cal.supersededCachedStatus).toBe('healthy');
    expect(cal.lastHealthyAt).toBe('2026-06-21T09:40:00.000Z');
  });

  it('resolves the five google_* services from a single account lookup', async () => {
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

    expect(body.integrations).toHaveLength(3);
    expect(body.integrations.every((i: { status: string }) => i.status === 'error')).toBe(true);
    // Three services, one provider, one query.
    expect(inspectAccountHealth).toHaveBeenCalledTimes(1);
    expect(inspectAccountHealth).toHaveBeenCalledWith(USER_ID, 'google');
  });

  it('reports healthy from live state when the account is usable', async () => {
    inspectAccountHealth.mockResolvedValue(ACTIVE_GOOGLE);
    const { composer } = composerFor({
      integration_health: [{ then: { data: [staleHealthyRow('google_gmail')], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));

    expect(body.integrations[0].status).toBe('healthy');
    expect(body.integrations[0].source).toBe('live');
    expect(body.integrations[0].stale).toBe(false);
    expect(body.integrations[0].supersededCachedStatus).toBeUndefined();
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

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));
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

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));

    expect(body.integrations[0].stale).toBe(false);
    expect(body.integrations[0].lastCheckAgeSeconds).toBe(15 * 60);
  });

  it('treats a row with no lastCheckAt as stale rather than current', async () => {
    const undated = { ...staleHealthyRow('telegram'), service: 'telegram', last_check_at: null };
    const { composer } = composerFor({
      integration_health: [{ then: { data: [undated], error: null } }],
    });

    const body = parse(await handleGetIntegrationHealth({ userId: USER_ID }, composer));

    expect(body.integrations[0].stale).toBe(true);
    expect(body.integrations[0].lastCheckAgeSeconds).toBeNull();
  });
});
