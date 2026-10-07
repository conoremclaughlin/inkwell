/**
 * The conditional reopen against a real database (T4; Lumen's #725 review).
 *
 * An explicit address or a reply reopens an ended session. The write is a
 * compare-and-set on the ended state the caller observed, so a resume that
 * got there first is kept as it stands: its lifecycle and its turn epoch
 * (rotated by the session_running_write trigger) are never overwritten.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { SessionRepository } from './session-repository';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  INTEGRATION_TEST_USER_ID,
} from '../../test/integration-fixtures';

/** Suite-owned identity: rows here stay invisible to every `echo` query. */
const SUITE_AGENT = 'echo-session-reopen';
const RUN = Math.random().toString(36).slice(2, 8);

describe('reopening an ended session is a compare-and-set', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let repo: SessionRepository;
  let suiteSbId: string;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    raw = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_AGENT);
    repo = new SessionRepository(raw);
  });

  afterAll(async () => {
    await raw
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE_AGENT);
    await raw.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function ended(fields: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await raw
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: SUITE_AGENT,
        sb_id: suiteSbId,
        lifecycle: 'completed',
        status: 'completed',
        ended_at: '2026-10-02T20:00:00.000Z',
        started_at: '2026-10-02T19:00:00.000Z',
        ...fields,
      })
      .select('id')
      .single();
    if (error) throw new Error(`session fixture: ${error.message}`);
    return data.id as string;
  }

  async function row(id: string) {
    const { data } = await raw
      .from('sessions')
      .select('ended_at, lifecycle, status, turn_epoch')
      .eq('id', id)
      .single();
    return data as {
      ended_at: string | null;
      lifecycle: string;
      status: string;
      turn_epoch: string | null;
    };
  }

  const observedCompleted = { lifecycle: 'completed' as const, status: 'completed' as const };

  it('reopens what it observed: ended_at cleared, completed reset to idle and active', async () => {
    const id = await ended();
    const result = await repo.reopenEnded(id, observedCompleted);
    expect(result.kind).toBe('reopened');
    expect(await row(id)).toMatchObject({ ended_at: null, lifecycle: 'idle', status: 'active' });
  });

  it('keeps a newer running turn that reopened the session first', async () => {
    const id = await ended();
    // The concurrent resume: reopened and entered running, which rotates the
    // turn epoch in the database.
    await raw.from('sessions').update({ ended_at: null, lifecycle: 'running' }).eq('id', id);
    const before = await row(id);
    expect(before.turn_epoch).not.toBeNull();

    const result = await repo.reopenEnded(id, observedCompleted);

    expect(result.kind).toBe('open');
    expect(await row(id)).toMatchObject({
      ended_at: null,
      lifecycle: 'running',
      turn_epoch: before.turn_epoch,
    });
  });

  it('keeps a newer lifecycle on a row that is still ended, and clears only ended_at', async () => {
    const id = await ended();
    await raw.from('sessions').update({ lifecycle: 'running' }).eq('id', id);
    const before = await row(id);

    const result = await repo.reopenEnded(id, observedCompleted);

    expect(result.kind).toBe('reopened');
    expect(await row(id)).toMatchObject({
      ended_at: null,
      lifecycle: 'running',
      turn_epoch: before.turn_epoch,
    });
  });

  it('reports a key another live session holds, and leaves the row ended', async () => {
    const key = `echo-session-reopen:test:held-${RUN}`;
    await raw.from('sessions').insert({
      user_id: INTEGRATION_TEST_USER_ID,
      agent_id: SUITE_AGENT,
      sb_id: suiteSbId,
      lifecycle: 'idle',
      alias: key,
      started_at: new Date().toISOString(),
    });
    const id = await ended({ alias: key });

    const result = await repo.reopenEnded(id, observedCompleted);

    expect(result.kind).toBe('key-held');
    expect((await row(id)).ended_at).not.toBeNull();
  });
});
