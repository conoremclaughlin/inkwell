/**
 * Memory Session Attribution Integration Tests
 *
 * Regression coverage against a real database for the 2026-09-10 incident:
 * routing created myra session d1d105ec with nothing behind it — backend
 * claude-code, `backend_session_id` null, every token counter 0, `context` null,
 * lifecycle 'running' 80 minutes later. No process ever attached to it.
 *
 * Because it was the NEWEST open row for `agent_id = 'myra'`, it captured every
 * `remember()` call that followed. Zero of that day's myra memories reached her
 * live session. `update_session_state` — already on `resolveImplicitSession` —
 * kept writing to the correct session from the same agent in the same minute,
 * which is what isolated the defect to this one writer.
 *
 * The shape is distinct from the 2026-08-16 cross-agent incident covered in
 * session-cross-agent-isolation.integration.test.ts: the row that steals the
 * write here belongs to the CALLER'S OWN identity, so an agent_id filter does
 * not exclude it. Only studio scope or the ambient session would, and the old
 * call passed neither.
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { handleRemember } from './memory-handlers';

/** Unique per run so parallel suites on the shared fixture user cannot collide. */
const AGENT = `attr-test-${Date.now().toString(36)}`;

describe('Memory session attribution', () => {
  let dataComposer: DataComposer;
  let testUserId: string;

  /**
   * The caller's real, long-lived session — the analogue of myra's 88b728cb,
   * open since August.
   */
  let liveSessionId: string;

  /**
   * The phantom: same identity, started later, in a studio the caller is not in.
   * Seeded with the incident's exact signature (no backend session, null context).
   */
  let phantomSessionId: string;

  let studioId: string;
  const createdSessionIds: string[] = [];
  const createdMemoryIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;

    const supabase = dataComposer.getClient();

    const { data: studio, error: studioError } = await supabase
      .from('studios')
      .insert({
        user_id: testUserId,
        agent_id: AGENT,
        slug: `${AGENT}-studio`,
        repo_root: `/tmp/${AGENT}`,
        worktree_path: `/tmp/${AGENT}/wt`,
        branch: `${AGENT}/probe`,
        metadata: { test: true },
      })
      .select()
      .single();
    if (studioError) throw new Error(`Failed to seed studio: ${studioError.message}`);
    studioId = studio.id;

    const { data: live, error: liveError } = await supabase
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: AGENT,
        started_at: new Date('2026-08-04T00:30:52Z').toISOString(),
        backend: 'ink',
        lifecycle: 'running',
        context: 'live bridge session',
        metadata: { test: true },
      })
      .select()
      .single();
    if (liveError) throw new Error(`Failed to seed live session: ${liveError.message}`);
    liveSessionId = live.id;
    createdSessionIds.push(liveSessionId);

    const { data: phantom, error: phantomError } = await supabase
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: AGENT,
        studio_id: studioId,
        started_at: new Date('2026-09-10T20:08:35Z').toISOString(),
        backend: 'claude-code',
        backend_session_id: null,
        lifecycle: 'running',
        context: null,
        metadata: { test: true },
      })
      .select()
      .single();
    if (phantomError) throw new Error(`Failed to seed phantom session: ${phantomError.message}`);
    phantomSessionId = phantom.id;
    createdSessionIds.push(phantomSessionId);
  });

  afterAll(async () => {
    const supabase = dataComposer.getClient();
    if (createdMemoryIds.length > 0) {
      await supabase.from('memories').delete().in('id', createdMemoryIds);
    }
    if (createdSessionIds.length > 0) {
      await supabase.from('session_logs').delete().in('session_id', createdSessionIds);
      await supabase.from('sessions').delete().in('id', createdSessionIds);
    }
    if (studioId) {
      await supabase.from('studios').delete().eq('id', studioId);
    }
  });

  /** Read a memory's stored attribution straight from the table. */
  async function readMemorySession(id: string): Promise<string | null> {
    const { data } = await dataComposer
      .getClient()
      .from('memories')
      .select('metadata')
      .eq('id', id)
      .single();
    return (data?.metadata as { sessionId?: string })?.sessionId ?? null;
  }

  async function remember(args: Record<string, unknown>) {
    const result = await handleRemember(
      { userId: testUserId, agentId: AGENT, content: 'attribution probe', ...args },
      dataComposer
    );
    const parsed = JSON.parse(result.content[0].text);
    if (parsed.memory?.id) createdMemoryIds.push(parsed.memory.id);
    return parsed;
  }

  it('confirms the phantom out-ranks the live session on recency', async () => {
    // Guards the premise: if the phantom were not the newest row for this
    // identity, everything below would pass for the wrong reason. Scoped to
    // this fixture's rows, because sibling suites seed the same user.
    const { data } = await dataComposer
      .getClient()
      .from('sessions')
      .select('id')
      .in('id', createdSessionIds)
      .is('ended_at', null)
      .neq('lifecycle', 'failed')
      .eq('agent_id', AGENT)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    expect(data?.id).toBe(phantomSessionId);
  });

  it('does not attribute a memory to a newer same-identity session in another studio', async () => {
    // The incident itself. The old call — getActiveSession(user, agentId,
    // undefined) — filtered on agent_id but not studio, so the phantom won.
    const parsed = await remember({});

    expect(parsed.success).toBe(true);
    expect(parsed.memory.sessionId).not.toBe(phantomSessionId);

    // Assert on the row, not the response: the response is what the handler
    // says it did, the row is what it did.
    expect(await readMemorySession(parsed.memory.id)).not.toBe(phantomSessionId);
  });

  it('still saves the memory when the session cannot be attributed', async () => {
    // The property that separates this handler from its peers. Two open
    // sessions match this identity and no ambient context names one, so the
    // resolver reports `ambiguous`. Its peers fail closed on that; remember
    // must not — a lost memory is worse than an unattributed one.
    const parsed = await remember({ content: 'must survive an ambiguous session' });

    expect(parsed.success).toBe(true);
    expect(parsed.memory.id).toBeTruthy();
    expect(parsed.memory.sessionId).toBeNull();

    const { data } = await dataComposer
      .getClient()
      .from('memories')
      .select('content')
      .eq('id', parsed.memory.id)
      .single();
    expect(data?.content).toBe('must survive an ambiguous session');
  });

  it('attributes to the session the caller names explicitly', async () => {
    // An explicit sessionId is the caller asserting which session it is, and
    // must beat any lookup — including one that would have found the phantom.
    const parsed = await remember({ sessionId: liveSessionId });

    expect(parsed.memory.sessionId).toBe(liveSessionId);
    expect(await readMemorySession(parsed.memory.id)).toBe(liveSessionId);
  });

  it('attributes to the one session in the studio the caller scopes to', async () => {
    // An explicit studioId disambiguates, so the resolver has exactly one
    // candidate and attribution succeeds rather than falling back to null.
    const parsed = await remember({ studioId });

    expect(parsed.memory.sessionId).toBe(phantomSessionId);
    expect(await readMemorySession(parsed.memory.id)).toBe(phantomSessionId);
  });
});
