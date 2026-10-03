/**
 * The archive columns against a real database (task T2, session lifecycle
 * v7 §2.2). The migration is additive: two columns, a CHECK that keeps the
 * reason and the timestamp together, and non-unique partial indexes. These
 * cases prove the constraint holds in Postgres and that the repository reads
 * what was stored; the unit tests only check the mapping.
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
const SUITE_AGENT = 'echo-session-archive';
const SUCCESSOR = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';

describe('session archive columns', () => {
  let dataComposer: DataComposer;
  let repo: SessionRepository;
  let suiteSbId: string | undefined;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_AGENT);
    repo = new SessionRepository(dataComposer.getClient());
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    await raw
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE_AGENT);
    if (suiteSbId) await raw.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function insert(fields: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    return raw
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: SUITE_AGENT,
        sb_id: suiteSbId,
        lifecycle: 'idle',
        started_at: new Date().toISOString(),
        ...fields,
      })
      .select('id')
      .single();
  }

  it('stores an archived row and the repository reads it back', async () => {
    const { data, error } = await insert({
      archived_at: '2026-10-02T21:00:00.000Z',
      archived_reason: 'handoff',
      metadata: {
        handedOffTo: SUCCESSOR,
        resumeRefused: {
          reason: 'backend refused resume',
          at: '2026-10-02T21:30:00.000Z',
          backend: 'claude-code',
          backendSessionId: 'backend-transcript-1',
        },
      },
    });
    expect(error).toBeNull();

    const session = await repo.findById(data.id);
    expect(session?.archivedAt?.toISOString()).toBe('2026-10-02T21:00:00.000Z');
    expect(session?.archivedReason).toBe('handoff');
    expect(session?.handedOffTo).toBe(SUCCESSOR);
    expect(session?.resumeRefused?.backendSessionId).toBe('backend-transcript-1');
  });

  it('defaults a new row to not archived', async () => {
    const { data, error } = await insert({});
    expect(error).toBeNull();
    const session = await repo.findById(data.id);
    expect(session?.archivedAt).toBeNull();
    expect(session?.archivedReason).toBeUndefined();
  });

  it('refuses a reason without a timestamp, and the reverse', async () => {
    const reasonOnly = await insert({ archived_reason: 'deliberate' });
    expect(reasonOnly.error?.message).toMatch(/sessions_archived_reason_with_archived_at/);

    const timestampOnly = await insert({ archived_at: '2026-10-02T21:00:00.000Z' });
    expect(timestampOnly.error?.message).toMatch(/sessions_archived_reason_with_archived_at/);
  });

  it('refuses a reason outside the four the spec defines', async () => {
    const { error } = await insert({
      archived_at: '2026-10-02T21:00:00.000Z',
      archived_reason: 'ended',
    });
    expect(error?.message).toMatch(/archived_reason/);
  });

  it('lets two ended, unarchived rows share a session key: the unique index waits for T11', async () => {
    // The 315-row shape: ended holders of one key. Today's key index covers
    // only rows with ended_at NULL. A unique index under archived_at IS NULL
    // installed now would refuse the second insert, which is why it ships
    // in T11, after the manifest resolves these.
    const key = 'echo-session-archive:test:shared';
    const ended = { alias: key, ended_at: '2026-10-02T20:00:00.000Z' };
    const first = await insert(ended);
    const second = await insert(ended);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
  });
});
