/**
 * Session Identity Chain — Integration Tests
 *
 * Tests the full session identity chain against a real database:
 *
 * 1. Session with studioId → getSession returns studioId for workspace enrichment
 * 2. Parallel sessions with different studios → correct isolation
 * 3. Deterministic sender resolution: threadKey-scoped (not most-recent session)
 * 4. getActiveSession (most-recent) vs getActiveSessionByThreadKey contrast
 *
 * Run via: yarn test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

describe('Session Identity Chain — Integration', () => {
  let dataComposer: DataComposer;
  let testUserId: string;
  const createdSessionIds: string[] = [];
  const createdStudioIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;
  });

  afterAll(async () => {
    // End all test sessions
    if (createdSessionIds.length > 0) {
      await dataComposer
        .getClient()
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds)
        .is('ended_at', null);
    }

    // Clean up test studios
    if (createdStudioIds.length > 0) {
      await dataComposer.getClient().from('studios').delete().in('id', createdStudioIds);
    }
  });

  /** Create a test studio with required schema fields */
  async function createTestStudio(suffix: string): Promise<string> {
    const uniqueBranch = `test/chain-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await dataComposer
      .getClient()
      .from('studios')
      .insert({
        user_id: testUserId,
        repo_root: '/tmp/integration-test',
        worktree_path: `/tmp/integration-test/${uniqueBranch}`,
        branch: uniqueBranch,
        status: 'active',
        metadata: { test: true, fixture: 'session-identity-chain' },
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create test studio: ${error.message}`);
    createdStudioIds.push(data!.id);
    return data!.id;
  }

  // ── Stage 1: Session stores studioId, getSession returns it ──

  it('should store and retrieve studioId on a session', async () => {
    const studioId = await createTestStudio('store-retrieve');

    const { data: session, error: sessError } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioId,
        metadata: { test: true },
      })
      .select()
      .single();

    expect(sessError).toBeNull();
    expect(session).toBeDefined();
    createdSessionIds.push(session!.id);

    // Verify getSession returns the studioId
    const retrieved = await dataComposer.repositories.memory.getSession(session!.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session!.id);
    expect(retrieved!.studioId).toBe(studioId);
    expect(retrieved!.agentId).toBe('echo');
  });

  it('should return null studioId for sessions without a studio', async () => {
    const { data: session, error } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        metadata: { test: true, noStudio: true },
      })
      .select()
      .single();

    expect(error).toBeNull();
    createdSessionIds.push(session!.id);

    const retrieved = await dataComposer.repositories.memory.getSession(session!.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.studioId).toBeFalsy();
  });

  // ── Stage 2: Parallel sessions with different studios — correct isolation ──

  it('should isolate parallel sessions by studioId', async () => {
    const studioAId = await createTestStudio('studio-a');
    const studioBId = await createTestStudio('studio-b');

    // Create sessions in each studio for the same agent
    const { data: sessionA } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioAId,
        thread_key: 'pr:100',
        metadata: { test: true, studio: 'A' },
      })
      .select()
      .single();

    const { data: sessionB } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioBId,
        thread_key: 'pr:200',
        metadata: { test: true, studio: 'B' },
      })
      .select()
      .single();

    createdSessionIds.push(sessionA!.id, sessionB!.id);

    // Each session resolves to the correct studio
    const retrievedA = await dataComposer.repositories.memory.getSession(sessionA!.id);
    const retrievedB = await dataComposer.repositories.memory.getSession(sessionB!.id);

    expect(retrievedA!.studioId).toBe(studioAId);
    expect(retrievedB!.studioId).toBe(studioBId);
    expect(retrievedA!.studioId).not.toBe(retrievedB!.studioId);
  });

  // ── Stage 3: threadKey-scoped session resolution (deterministic, not most-recent) ──

  it('should resolve session by threadKey, not most-recent', async () => {
    const studioId = await createTestStudio('threadkey-resolve');

    // Create an older session with threadKey 'pr:42'
    const { data: olderSession } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioId,
        thread_key: 'pr:42',
        metadata: { test: true, role: 'older-with-threadkey' },
      })
      .select()
      .single();
    createdSessionIds.push(olderSession!.id);

    // Small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 50));

    // Create a newer session (most recent) WITHOUT the threadKey
    const { data: newerSession } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioId,
        metadata: { test: true, role: 'newer-no-threadkey' },
      })
      .select()
      .single();
    createdSessionIds.push(newerSession!.id);

    // getActiveSessionByThreadKey should return the older session with the matching threadKey
    const resolved = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
      testUserId,
      'echo',
      'pr:42',
      studioId
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(olderSession!.id);
    // NOT the newer session — proves deterministic resolution
    expect(resolved!.id).not.toBe(newerSession!.id);
  });

  it('should return null for threadKey with no matching session', async () => {
    const resolved = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
      testUserId,
      'echo',
      'pr:nonexistent-999',
      undefined
    );

    expect(resolved).toBeNull();
  });

  it('should not match ended sessions by threadKey', async () => {
    const { data: endedSession } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        thread_key: 'pr:ended',
        ended_at: new Date().toISOString(),
        metadata: { test: true, role: 'ended-session' },
      })
      .select()
      .single();
    createdSessionIds.push(endedSession!.id);

    const resolved = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
      testUserId,
      'echo',
      'pr:ended',
      undefined
    );

    expect(resolved).toBeNull();
  });

  // ── Stage 4: getActiveSession (most-recent) vs getActiveSessionByThreadKey ──
  // Proves that getActiveSession is non-deterministic with concurrent sessions.

  it('should demonstrate getActiveSession returns most-recent (non-deterministic)', async () => {
    const studioId = await createTestStudio('nondeterministic');

    // Create first session
    const { data: first } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioId,
        thread_key: 'pr:first',
        metadata: { test: true, order: 'first' },
      })
      .select()
      .single();
    createdSessionIds.push(first!.id);

    // Small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 50));

    // Create second session (newer)
    const { data: second } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'echo',
        studio_id: studioId,
        thread_key: 'pr:second',
        metadata: { test: true, order: 'second' },
      })
      .select()
      .single();
    createdSessionIds.push(second!.id);

    // getActiveSession returns the NEWER one (non-deterministic for thread routing)
    const mostRecent = await dataComposer.repositories.memory.getActiveSession(
      testUserId,
      'echo',
      studioId
    );
    expect(mostRecent).not.toBeNull();
    expect(mostRecent!.id).toBe(second!.id);

    // But getActiveSessionByThreadKey returns the CORRECT one
    const byThread = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
      testUserId,
      'echo',
      'pr:first',
      studioId
    );
    expect(byThread).not.toBeNull();
    expect(byThread!.id).toBe(first!.id);
  });
});
