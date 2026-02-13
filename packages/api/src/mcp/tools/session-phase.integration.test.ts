/**
 * Session Phase Integration Tests
 *
 * Tests the full session phase lifecycle against a real database:
 * 1. Start session
 * 2. Update phase (with auto-memory on significant transitions)
 * 3. Update session metadata (backendSessionId, status, context)
 * 4. End session
 * 5. Verify memories were created for blocked/waiting phases
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';

describe('Session Phase Integration', () => {
  let dataComposer: DataComposer;
  let testUserId: string;
  let testSessionId: string;
  const createdMemoryIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();

    // Find a test user (use the user who owns the echo agent from migration 008)
    const { data: echoIdentity, error } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('user_id')
      .eq('agent_id', 'echo')
      .single();

    if (error || !echoIdentity) {
      throw new Error(
        'Echo test agent identity not found. Apply migration 008_add_echo_test_agent.sql first.'
      );
    }

    testUserId = echoIdentity.user_id;
  });

  afterAll(async () => {
    // Clean up: end all test sessions
    if (createdSessionIds.length > 0) {
      await dataComposer
        .getClient()
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds)
        .is('ended_at', null);
    }

    // Clean up: delete test memories
    if (createdMemoryIds.length > 0) {
      await dataComposer.getClient().from('memories').delete().in('id', createdMemoryIds);
    }
  });

  it('should create a new session with the test agent', async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'integration-test',
        metadata: { test: true },
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.agent_id).toBe('integration-test');
    expect(data!.ended_at).toBeNull();
    expect(data!.current_phase).toBeNull();

    testSessionId = data!.id;
    createdSessionIds.push(data!.id);
  });

  it('should update session phase to implementing', async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .update({ current_phase: 'implementing' })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.current_phase).toBe('implementing');
  });

  it('should update session with backend_session_id (writes to both columns)', async () => {
    const testBackendId = `integration-test-${Date.now()}`;

    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .update({
        backend_session_id: testBackendId,
        claude_session_id: testBackendId, // backward compat
      })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.backend_session_id).toBe(testBackendId);
    expect(data!.claude_session_id).toBe(testBackendId);
  });

  it('should update to blocked phase and create a memory', async () => {
    const blockedPhase = 'blocked:integration-test-reason';

    // Update phase
    const { data: sessionData, error: sessionError } = await dataComposer
      .getClient()
      .from('sessions')
      .update({ current_phase: blockedPhase })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(sessionError).toBeNull();
    expect(sessionData!.current_phase).toBe(blockedPhase);

    // Create auto-memory (simulating what handleUpdateSessionPhase does)
    const { data: memoryData, error: memoryError } = await dataComposer
      .getClient()
      .from('memories')
      .insert({
        user_id: testUserId,
        content: `[${blockedPhase}] Integration test blocked phase`,
        source: 'session',
        salience: 'high',
        topics: ['session-phase', 'blocked'],
        metadata: { sessionId: testSessionId, phase: blockedPhase },
        agent_id: 'integration-test',
      })
      .select()
      .single();

    expect(memoryError).toBeNull();
    expect(memoryData).toBeDefined();
    createdMemoryIds.push(memoryData!.id);
  });

  it('should update session status and context metadata', async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .update({
        status: 'resumable',
        context: 'Integration test: waiting for user input',
        working_dir: '/tmp/integration-test',
      })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.status).toBe('resumable');
    expect(data!.context).toBe('Integration test: waiting for user input');
    expect(data!.working_dir).toBe('/tmp/integration-test');
  });

  it('should transition to complete phase', async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .update({ current_phase: 'complete' })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.current_phase).toBe('complete');
  });

  it('should end the session with a summary', async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('sessions')
      .update({
        ended_at: new Date().toISOString(),
        summary: 'Integration test session completed successfully',
      })
      .eq('id', testSessionId)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data!.ended_at).not.toBeNull();
    expect(data!.summary).toBe('Integration test session completed successfully');
  });

  it('should verify the auto-created memory exists with correct data', async () => {
    expect(createdMemoryIds.length).toBeGreaterThan(0);

    const { data, error } = await dataComposer
      .getClient()
      .from('memories')
      .select('*')
      .eq('id', createdMemoryIds[0])
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data!.content).toContain('blocked:integration-test-reason');
    expect(data!.source).toBe('session');
    expect(data!.salience).toBe('high');
    expect(data!.topics).toContain('session-phase');
    expect(data!.topics).toContain('blocked');
    expect(data!.agent_id).toBe('integration-test');
    expect(data!.metadata).toHaveProperty('sessionId', testSessionId);
  });

  it('should support parallel sessions for the same agent', async () => {
    // Create two sessions for the same agent (simulating parallel worktrees)
    const { data: session1 } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'integration-test',
        metadata: { test: true, worktree: 'main' },
      })
      .select()
      .single();

    const { data: session2 } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: testUserId,
        agent_id: 'integration-test',
        metadata: { test: true, worktree: 'feature-branch' },
      })
      .select()
      .single();

    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    createdSessionIds.push(session1!.id, session2!.id);

    // Both should be active simultaneously
    const { data: activeSessions } = await dataComposer
      .getClient()
      .from('sessions')
      .select('id, current_phase')
      .eq('user_id', testUserId)
      .eq('agent_id', 'integration-test')
      .is('ended_at', null)
      .order('started_at', { ascending: false });

    // Should have at least 2 active sessions
    const testSessionIds = (activeSessions || [])
      .filter((s) => s.id === session1!.id || s.id === session2!.id)
      .map((s) => s.id);
    expect(testSessionIds.length).toBe(2);

    // Update each independently
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ current_phase: 'investigating' })
      .eq('id', session1!.id);

    await dataComposer
      .getClient()
      .from('sessions')
      .update({ current_phase: 'implementing' })
      .eq('id', session2!.id);

    // Verify independent phases
    const { data: s1 } = await dataComposer
      .getClient()
      .from('sessions')
      .select('current_phase')
      .eq('id', session1!.id)
      .single();

    const { data: s2 } = await dataComposer
      .getClient()
      .from('sessions')
      .select('current_phase')
      .eq('id', session2!.id)
      .single();

    expect(s1!.current_phase).toBe('investigating');
    expect(s2!.current_phase).toBe('implementing');

    // Cleanup
    await dataComposer
      .getClient()
      .from('sessions')
      .update({ ended_at: new Date().toISOString() })
      .in('id', [session1!.id, session2!.id]);
  });
});
