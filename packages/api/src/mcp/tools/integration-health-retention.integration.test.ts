/**
 * last_healthy_at retention, against a real database.
 *
 * The invariant lives in the integration_health_retain_last_healthy_at trigger,
 * so a mocked client cannot test it — the mock would only replay whatever the
 * handler wrote. These run the actual writes, including the interleaving that
 * the previous read-then-write implementation lost.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { handleUpdateIntegrationHealth } from './integration-health-handlers';

const SERVICE = 'integration_test_retention';

describe('integration_health last_healthy_at retention', () => {
  let dataComposer: DataComposer;
  let userId: string;

  async function storedRow() {
    const { data } = await dataComposer
      .getClient()
      .from('integration_health')
      .select('status, last_healthy_at')
      .eq('user_id', userId)
      .eq('service', SERVICE)
      .maybeSingle();
    return data;
  }

  async function report(status: string, extra: Record<string, unknown> = {}) {
    return handleUpdateIntegrationHealth(
      { userId, service: SERVICE, status, agentId: 'integration-test', ...extra },
      dataComposer
    );
  }

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  beforeEach(async () => {
    await dataComposer
      .getClient()
      .from('integration_health')
      .delete()
      .eq('user_id', userId)
      .eq('service', SERVICE);
  });

  afterAll(async () => {
    if (!dataComposer) return;
    await dataComposer
      .getClient()
      .from('integration_health')
      .delete()
      .eq('user_id', userId)
      .eq('service', SERVICE);
  });

  it('keeps the healthy timestamp when a failure is reported', async () => {
    await report('healthy');
    const healthy = await storedRow();
    expect(healthy?.last_healthy_at).not.toBeNull();

    await report('error', { errorCode: 'oauth_expired', errorMessage: 'token refresh failed' });

    const afterFailure = await storedRow();
    expect(afterFailure?.status).toBe('error');
    // The answer to "when did this last work" survives the outage report.
    expect(afterFailure?.last_healthy_at).toBe(healthy?.last_healthy_at);
  });

  it('leaves last_healthy_at null when the very first report is a failure', async () => {
    await report('error', { errorMessage: 'never worked here' });

    const row = await storedRow();
    expect(row?.status).toBe('error');
    expect(row?.last_healthy_at).toBeNull();
  });

  it('advances the timestamp on each healthy report', async () => {
    await report('healthy');
    const first = await storedRow();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await report('healthy');
    const second = await storedRow();

    expect(new Date(second!.last_healthy_at!).getTime()).toBeGreaterThan(
      new Date(first!.last_healthy_at!).getTime()
    );
  });

  it('does not let a late failure report roll back a newer healthy stamp', async () => {
    // The lost update the old read-then-write allowed, replayed deterministically
    // rather than raced: the unhealthy reporter reads the timestamp, a healthy
    // reporter stamps a newer one, and then the unhealthy write lands still
    // carrying the value it read. Ordering it explicitly means the assertion
    // does not depend on which of two concurrent writes happens to win.
    await report('healthy');
    const readByTheFailureReporter = (await storedRow())!.last_healthy_at!;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await report('healthy');
    const advanced = (await storedRow())!.last_healthy_at!;
    expect(new Date(advanced).getTime()).toBeGreaterThan(
      new Date(readByTheFailureReporter).getTime()
    );

    // The write the old implementation would have issued.
    await dataComposer
      .getClient()
      .from('integration_health')
      .update({ status: 'error', last_healthy_at: readByTheFailureReporter })
      .eq('user_id', userId)
      .eq('service', SERVICE);

    const row = await storedRow();
    expect(row?.status).toBe('error');
    expect(row?.last_healthy_at).toBe(advanced);
  });

  it('cannot be erased by writing null directly', async () => {
    await report('healthy');
    const stamped = (await storedRow())!.last_healthy_at;

    // The invariant holds for every writer, not only for the handler.
    await dataComposer
      .getClient()
      .from('integration_health')
      .update({ status: 'degraded', last_healthy_at: null })
      .eq('user_id', userId)
      .eq('service', SERVICE);

    const row = await storedRow();
    expect(row?.status).toBe('degraded');
    expect(row?.last_healthy_at).toBe(stamped);
  });
});
