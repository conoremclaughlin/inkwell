/**
 * OAuthService.inspectAccountHealth
 *
 * The value of this method is entirely that it agrees with getValidAccessToken.
 * These tests pin the places where the two could drift apart: the refresh window
 * (an account one refresh away from a verdict must not be published as healthy)
 * and the difference between "nothing is connected" and "I could not look".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableAwareSupabaseMock } from '../test/table-aware-supabase-mock';

const from = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from }),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  getRequestContext: () => undefined,
  getSessionContext: () => undefined,
}));

const { OAuthService } = await import('./oauth');

const USER_ID = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-08-15T17:00:00.000Z');

function accountRows(rows: Array<Record<string, unknown>>) {
  const mock = createTableAwareSupabaseMock({
    connected_accounts: [{ then: { data: rows, error: null } }],
  });
  from.mockImplementation(mock.from);
}

function accountReadFails(message: string) {
  const mock = createTableAwareSupabaseMock({
    connected_accounts: [{ then: { data: null, error: { message } } }],
  });
  from.mockImplementation(mock.from);
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    last_error: null,
    expires_at: '2026-08-16T17:00:00.000Z',
    last_used_at: '2026-08-15T16:00:00.000Z',
    updated_at: '2026-08-15T16:00:00.000Z',
    refresh_token: 'refresh-abc',
    ...overrides,
  };
}

beforeEach(() => {
  from.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inspectAccountHealth — the refresh window', () => {
  it('reports a comfortably valid token as active', async () => {
    accountRows([activeRow()]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('active');
    expect(health.reason).toBeNull();
  });

  it('does not call an account inside the refresh window active', async () => {
    // getValidAccessToken refreshes anything expiring within five minutes, so the
    // token this method can see is not the token the next call will send.
    accountRows([activeRow({ expires_at: '2026-08-15T17:04:00.000Z' })]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('refresh_required');
    expect(health.reason).toContain('must refresh it first');
  });

  it('reports an already-expired token with a refresh token as refresh_required, not healthy', async () => {
    // The seven-day Google testing-mode expiry lands here: a health check can be
    // the first call after expiry, and answering 'active' would promise a token
    // that the very next call fails to obtain.
    accountRows([activeRow({ expires_at: '2026-08-15T16:00:00.000Z' })]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('refresh_required');
    expect(health.accountStatus).toBe('active');
  });

  it('says so when an account in the refresh window has no refresh token', async () => {
    accountRows([activeRow({ expires_at: '2026-08-15T17:04:00.000Z', refresh_token: null })]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('refresh_required');
    expect(health.reason).toContain('no refresh token is stored');
  });

  it('reports an expired token with no refresh token as unusable', async () => {
    accountRows([activeRow({ expires_at: '2026-08-15T16:00:00.000Z', refresh_token: null })]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('unusable');
  });

  it('treats a null expiry as no expiry rather than as expired', async () => {
    accountRows([activeRow({ expires_at: null })]);

    expect((await new OAuthService().inspectAccountHealth(USER_ID, 'google')).state).toBe('active');
  });
});

describe('inspectAccountHealth — absence versus ignorance', () => {
  it('reports zero rows as missing', async () => {
    accountRows([]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('missing');
    expect(health.reason).toContain('No google account has been connected');
  });

  it('reports a failed lookup as unknown, distinct from missing', async () => {
    accountReadFails('connection reset');

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    // "I could not read the account table" is not a configuration verdict.
    expect(health.state).toBe('unknown');
    expect(health.state).not.toBe('missing');
    expect(health.reason).toContain('connection reset');
  });

  it('explains an inactive account from the newest failed row', async () => {
    accountRows([
      {
        status: 'expired',
        last_error: 'Failed to refresh google token',
        expires_at: '2026-08-14T18:00:00.000Z',
        last_used_at: '2026-08-14T18:00:00.000Z',
        updated_at: '2026-08-14T18:00:00.000Z',
        refresh_token: 'refresh-abc',
      },
    ]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('unusable');
    expect(health.reason).toContain('No active google account found');
    expect(health.lastError).toBe('Failed to refresh google token');
  });

  it('prefers the active row when a failed one also exists, as getValidAccessToken does', async () => {
    accountRows([
      { ...activeRow({ status: 'error', updated_at: '2026-08-15T16:30:00.000Z' }) },
      activeRow(),
    ]);

    const health = await new OAuthService().inspectAccountHealth(USER_ID, 'google');

    expect(health.state).toBe('active');
  });

  it('never throws when the account table is unreadable', async () => {
    accountReadFails('permission denied');

    await expect(new OAuthService().inspectAccountHealth(USER_ID, 'google')).resolves.toBeDefined();
  });
});
