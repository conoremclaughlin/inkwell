/**
 * One backend conversation is one Inkwell session (task 3d2f2112).
 *
 * Runs start_session against the local database so the repository lookup
 * behind it — a PostgREST `or` filter over both backend-link columns — is
 * exercised for real; the unit tests only check the query shape.
 *
 * The scenario is the one that produced four live rows for a single Claude
 * session on 2026-10-01: a launcher that knows which transcript it will
 * resume asks for a NEW row (forceNew, client-minted id) because its picker
 * had hidden the existing one. The server must hand back the row already
 * linked to that transcript. Controls: an unknown transcript still creates,
 * and an ended row is not revived by resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleStartSession } from '../../mcp/tools/memory-handlers';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  INTEGRATION_TEST_USER_ID,
} from '../../test/integration-fixtures';

/**
 * A suite-owned identity rather than the shared `echo` fixture agent. These
 * tests leave rows live for the duration of a test, and the DB suite runs
 * files in parallel: a live `echo` row here was picked up by another file's
 * "active session for echo" lookup (CI at 10bb171f,
 * session-current-work.integration.test.ts). Rows under this slug are
 * invisible to every `echo` query.
 */
const SUITE_AGENT = 'echo-one-row-per-conversation';

function parse(result: { content: Array<{ text: string }> }): {
  success: boolean;
  session?: { id: string; isExisting?: boolean; reusedBy?: string; backendSessionId?: string };
} {
  return JSON.parse(result.content[0].text);
}

describe('start_session: one backend conversation is one Inkwell session', () => {
  let dataComposer: DataComposer;
  let suiteSbId: string | undefined;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_AGENT);
  });

  afterAll(async () => {
    const supabase = dataComposer.getClient();
    if (createdSessionIds.length > 0) {
      await supabase.from('sessions').delete().in('id', createdSessionIds);
    }
    // Belt and braces: nothing under the suite slug may outlive the suite.
    await supabase
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE_AGENT);
    if (suiteSbId) await supabase.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function startLinkedRow(backendSessionId: string): Promise<string> {
    const id = randomUUID();
    const created = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: id,
        },
        dataComposer
      )
    );
    expect(created.success).toBe(true);
    expect(created.session?.id).toBe(id);
    createdSessionIds.push(id);
    // The launcher links the transcript right after starting, as ink claude does.
    await dataComposer.repositories.memory.updateSession(id, { backendSessionId });
    return id;
  }

  it('returns the live row already linked to the transcript, forceNew and a fresh id notwithstanding', async () => {
    const transcript = `it-${randomUUID()}`;
    const linkedId = await startLinkedRow(transcript);

    const relaunchId = randomUUID();
    const relaunch = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: relaunchId,
          backendSessionId: transcript,
        },
        dataComposer
      )
    );

    expect(relaunch.success).toBe(true);
    expect(relaunch.session?.id).toBe(linkedId);
    expect(relaunch.session?.isExisting).toBe(true);
    expect(relaunch.session?.reusedBy).toBe('backendSessionId');
    expect(relaunch.session?.backendSessionId).toBe(transcript);

    const { data: minted } = await dataComposer
      .getClient()
      .from('sessions')
      .select('id')
      .eq('id', relaunchId)
      .maybeSingle();
    expect(minted).toBeNull();
  });

  it('a second start for the same transcript reuses the first row with no link step in between', async () => {
    const transcript = `it-${randomUUID()}`;
    const firstId = randomUUID();
    const first = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: firstId,
          backendSessionId: transcript,
        },
        dataComposer
      )
    );
    createdSessionIds.push(firstId);
    expect(first.session?.id).toBe(firstId);
    expect(first.session?.backendSessionId).toBe(transcript);

    const second = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: randomUUID(),
          backendSessionId: transcript,
        },
        dataComposer
      )
    );

    expect(second.session?.id).toBe(firstId);
    expect(second.session?.reusedBy).toBe('backendSessionId');
  });

  it('control: a lifecycle-completed row with ended_at still null is not reused', async () => {
    const transcript = `it-${randomUUID()}`;
    const completedId = await startLinkedRow(transcript);
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ lifecycle: 'completed' })
      .eq('id', completedId);

    const relaunchId = randomUUID();
    const relaunch = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: relaunchId,
          backendSessionId: transcript,
        },
        dataComposer
      )
    );
    createdSessionIds.push(relaunchId);

    expect(relaunch.session?.id).toBe(relaunchId);
    expect(relaunch.session?.isExisting).toBeUndefined();
  });

  it('a crashed row (lifecycle failed, ended_at null) is the one its relaunch resumes', async () => {
    const transcript = `it-${randomUUID()}`;
    const crashedId = await startLinkedRow(transcript);
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ lifecycle: 'failed' })
      .eq('id', crashedId);

    const relaunch = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: randomUUID(),
          backendSessionId: transcript,
        },
        dataComposer
      )
    );

    expect(relaunch.session?.id).toBe(crashedId);
    expect(relaunch.session?.reusedBy).toBe('backendSessionId');
  });

  // Scoped by a thread key of their own: the suite's other tests leave live
  // rows under the same agent, and a live row rightly outranks a crashed one,
  // so the crash cases need a scope in which the rows they create are the
  // only candidates.
  it('a plain relaunch after a crash, with no backend id, reuses the crashed row', async () => {
    const threadKey = `thread:it-crash-${randomUUID()}`;
    const firstId = randomUUID();
    const first = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: firstId,
          threadKey,
        },
        dataComposer
      )
    );
    createdSessionIds.push(firstId);
    expect(first.session?.id).toBe(firstId);
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ lifecycle: 'failed' })
      .eq('id', firstId);

    const relaunch = parse(
      await handleStartSession(
        { userId: INTEGRATION_TEST_USER_ID, sbSlug: SUITE_AGENT, backend: 'claude', threadKey },
        dataComposer
      )
    );

    expect(relaunch.session?.id).toBe(firstId);
    expect(relaunch.session?.isExisting).toBe(true);
  });

  it('a newer crashed row does not displace an older live row on a plain relaunch', async () => {
    const threadKey = `thread:it-order-${randomUUID()}`;
    const liveId = randomUUID();
    createdSessionIds.push(liveId);
    await handleStartSession(
      {
        userId: INTEGRATION_TEST_USER_ID,
        sbSlug: SUITE_AGENT,
        backend: 'claude',
        forceNew: true,
        sessionId: liveId,
        threadKey,
      },
      dataComposer
    );
    const crashedId = randomUUID();
    createdSessionIds.push(crashedId);
    await handleStartSession(
      {
        userId: INTEGRATION_TEST_USER_ID,
        sbSlug: SUITE_AGENT,
        backend: 'claude',
        forceNew: true,
        sessionId: crashedId,
        threadKey,
      },
      dataComposer
    );
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ lifecycle: 'failed' })
      .eq('id', crashedId);

    const relaunch = parse(
      await handleStartSession(
        { userId: INTEGRATION_TEST_USER_ID, sbSlug: SUITE_AGENT, backend: 'claude', threadKey },
        dataComposer
      )
    );

    expect(relaunch.session?.id).toBe(liveId);
  });

  it('control: a transcript no live row carries still creates the requested row', async () => {
    const transcript = `it-${randomUUID()}`;
    const freshId = randomUUID();
    const started = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: freshId,
          backendSessionId: transcript,
        },
        dataComposer
      )
    );
    createdSessionIds.push(freshId);

    expect(started.success).toBe(true);
    expect(started.session?.id).toBe(freshId);
    expect(started.session?.isExisting).toBeUndefined();
  });

  it('control: an ended row is not revived by resolution', async () => {
    const transcript = `it-${randomUUID()}`;
    const endedId = await startLinkedRow(transcript);
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', endedId);

    const relaunchId = randomUUID();
    const relaunch = parse(
      await handleStartSession(
        {
          userId: INTEGRATION_TEST_USER_ID,
          sbSlug: SUITE_AGENT,
          backend: 'claude',
          forceNew: true,
          sessionId: relaunchId,
          backendSessionId: transcript,
        },
        dataComposer
      )
    );
    createdSessionIds.push(relaunchId);

    expect(relaunch.success).toBe(true);
    expect(relaunch.session?.id).toBe(relaunchId);
    expect(relaunch.session?.isExisting).toBeUndefined();
  });
});
