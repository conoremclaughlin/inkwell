/**
 * Cross-Agent Session Isolation Integration Tests
 *
 * Regression coverage against a real database for the 2026-08-16 incident:
 * myra's heartbeat called update_session_state(context) with no sessionId and
 * the write landed on lumen's `pr:500` session, in a different studio.
 *
 * The unit tests in memory-handlers.test.ts stub the repository, so they prove
 * the handler asks for the right thing. These tests prove the thing it asks for
 * is right: a real `sessions` table, real recency ordering, and an assertion on
 * the foreign row's actual contents after the call.
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import {
  handleUpdateSessionState,
  handleGetSession,
  handleCompactSession,
} from './memory-handlers';

describe('Cross-agent session isolation', () => {
  let dataComposer: DataComposer;
  let testUserId: string;

  /** A peer agent's session, started most recently — it wins any unscoped recency query. */
  let foreignSessionId: string;
  const FOREIGN_CONTEXT = 'peer-agent scratch context — must survive untouched';

  /** The caller's own session, started earlier, as a long-lived bridge session would be. */
  let ownSessionId: string;

  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;

    const supabase = dataComposer.getClient();

    // Older session, owned by the caller.
    const { data: own, error: ownError } = await supabase
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'iso-test-caller',
        started_at: new Date('2026-08-05T18:42:09Z').toISOString(),
        context: 'caller original context',
        metadata: { test: true },
      })
      .select()
      .single();
    if (ownError) throw new Error(`Failed to seed caller session: ${ownError.message}`);
    ownSessionId = own.id;
    createdSessionIds.push(ownSessionId);

    // Newer session, owned by a different agent in a different studio.
    const { data: foreign, error: foreignError } = await supabase
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'iso-test-peer',
        started_at: new Date('2026-08-15T04:58:11Z').toISOString(),
        context: FOREIGN_CONTEXT,
        current_phase: 'reviewing',
        metadata: { test: true },
      })
      .select()
      .single();
    if (foreignError) throw new Error(`Failed to seed peer session: ${foreignError.message}`);
    foreignSessionId = foreign.id;
    createdSessionIds.push(foreignSessionId);
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      const supabase = dataComposer.getClient();
      await supabase.from('session_logs').delete().in('session_id', createdSessionIds);
      await supabase.from('sessions').delete().in('id', createdSessionIds);
    }
  });

  /** Read a session's context straight from the table, bypassing any handler logic. */
  async function readSession(id: string) {
    const { data } = await dataComposer
      .getClient()
      .from('sessions')
      .select('context, current_phase')
      .eq('id', id)
      .single();
    return data;
  }

  it('confirms the peer session is the newer of the two seeded sessions', async () => {
    // Guards the premise of the whole suite: the peer must out-rank the caller's
    // own session on recency, or the tests below would pass for the wrong reason.
    //
    // Scoped to the rows this fixture created, deliberately. The first version
    // asked for "the newest open session for this user" across the whole table
    // and broke in CI: these rows are seeded with dates in the past, so any
    // session a sibling suite creates for the shared fixture user is newer and
    // wins. That is the same unscoped-recency defect this PR fixes in
    // production — a query that answers "the newest row" when the question was
    // "the newest of mine". It passed locally only because the file ran alone.
    const { data } = await dataComposer
      .getClient()
      .from('sessions')
      .select('id')
      .in('id', createdSessionIds)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    expect(data?.id).toBe(foreignSessionId);
  });

  it('refuses an implicit write it cannot attribute, leaving the peer session intact', async () => {
    // No request context and no bootstrap pin exist in this process, so the
    // caller has no established identity. The old code fell back to an
    // unscoped recency query and wrote to whichever session came back.
    const result = await handleUpdateSessionState(
      { userId: testUserId, context: 'heartbeat notes that must not escape' },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/no agent identity/i);

    // The damage assertion: the peer's row is byte-for-byte what we seeded.
    const foreign = await readSession(foreignSessionId);
    expect(foreign?.context).toBe(FOREIGN_CONTEXT);
    expect(foreign?.current_phase).toBe('reviewing');
  });

  it('routes an agent-scoped implicit write to that agent, not to the newest session', async () => {
    const result = await handleUpdateSessionState(
      {
        userId: testUserId,
        agentId: 'iso-test-caller',
        context: 'caller updated context',
      },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.session.id).toBe(ownSessionId);

    const own = await readSession(ownSessionId);
    expect(own?.context).toBe('caller updated context');

    const foreign = await readSession(foreignSessionId);
    expect(foreign?.context).toBe(FOREIGN_CONTEXT);
  });

  it('lets a user-authority caller repair a peer session by explicit id', async () => {
    // No pinned agent identity in this process, so this is the user/admin path.
    // Agent-bound callers are denied the same write — covered in the unit suite,
    // where the pinned identity can be controlled.
    const marker = '[marker written by user authority]';
    const result = await handleUpdateSessionState(
      { userId: testUserId, sessionId: foreignSessionId, context: marker },
      dataComposer
    );

    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const foreign = await readSession(foreignSessionId);
    expect(foreign?.context).toBe(marker);
  });

  // ── The other two handlers on the shared resolver ──
  // The resolver change touches all three; compaction is the destructive one.

  it('get_session does not disclose a peer session on an unattributable call', async () => {
    const result = await handleGetSession({ userId: testUserId }, dataComposer);
    const parsed = JSON.parse(result.content[0].text);

    // Without an identity it must not answer with whatever started last.
    expect(parsed.session).toBeNull();
  });

  it('get_session scopes to the named agent rather than the newest session', async () => {
    const result = await handleGetSession(
      { userId: testUserId, agentId: 'iso-test-caller' },
      dataComposer
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.session?.id).toBe(ownSessionId);
    expect(parsed.session?.id).not.toBe(foreignSessionId);
  });

  it('compact_session refuses an unattributable call, leaving peer logs intact', async () => {
    const supabase = dataComposer.getClient();
    await supabase.from('session_logs').insert({
      session_id: foreignSessionId,
      content: 'peer log entry that must not be compacted away',
      salience: 'high',
    });

    const result = await handleCompactSession({ userId: testUserId }, dataComposer);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/no agent identity/i);

    // The destructive assertion: the peer's logs are still live, not soft-deleted.
    const { data: logs } = await supabase
      .from('session_logs')
      .select('id, compacted_at')
      .eq('session_id', foreignSessionId);
    expect(logs?.length).toBe(1);
    expect(logs?.[0].compacted_at).toBeNull();
  });

  it('compact_session scoped to an identity does not touch the peer session', async () => {
    const supabase = dataComposer.getClient();
    const result = await handleCompactSession(
      { userId: testUserId, agentId: 'iso-test-caller' },
      dataComposer
    );

    // Either it compacts the caller's own (log-less) session or reports nothing
    // to do — both are fine. What matters is the peer's logs are untouched.
    expect(JSON.parse(result.content[0].text).sessionId ?? ownSessionId).toBe(ownSessionId);

    const { data: logs } = await supabase
      .from('session_logs')
      .select('id, compacted_at')
      .eq('session_id', foreignSessionId);
    expect(logs?.[0]?.compacted_at ?? null).toBeNull();
  });
});
