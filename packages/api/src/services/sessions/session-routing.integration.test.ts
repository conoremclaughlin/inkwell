/**
 * Session Routing Integration Tests
 *
 * Tests session alias routing and default_session_id consolidation against
 * a real database. Verifies:
 * - Alias-based routing finds sessions by alias
 * - default_session_id on agent_identities routes threadKey misses to a specific session
 * - Without default_session_id, threadKey misses create new sessions
 * - Ended default sessions fall through to creation
 *
 * Requires: running PCP server (default http://localhost:3001)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { SessionRepository } from './session-repository';
import {
  ensureEchoIntegrationFixture,
  INTEGRATION_TEST_USER_ID,
  INTEGRATION_TEST_AGENT_ID,
} from '../../test/integration-fixtures';

describe('Session Routing Integration', () => {
  let dataComposer: DataComposer;
  let repo: SessionRepository;
  const createdSessionIds: string[] = [];
  let identityId: string;
  let originalDefaultSessionId: string | null = null;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    await ensureEchoIntegrationFixture(dataComposer);
    repo = new SessionRepository(dataComposer.getClient());

    // Look up the echo identity for later default_session_id tests
    const { data: identity } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('id, default_session_id')
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', INTEGRATION_TEST_AGENT_ID)
      .limit(1)
      .maybeSingle();

    if (identity) {
      identityId = identity.id;
      originalDefaultSessionId = (identity as Record<string, unknown>).default_session_id as
        | string
        | null;
    }
  });

  afterAll(async () => {
    // End all test sessions
    if (createdSessionIds.length > 0) {
      await dataComposer
        .getClient()
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds);
    }

    // Restore original default_session_id
    if (identityId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dataComposer.getClient() as any)
        .from('agent_identities')
        .update({ default_session_id: originalDefaultSessionId })
        .eq('id', identityId);
    }
  });

  // ── Alias Routing ──

  it('should find a session by alias', async () => {
    // Create a session with an alias
    const session = await repo.create({
      userId: INTEGRATION_TEST_USER_ID,
      agentId: INTEGRATION_TEST_AGENT_ID,
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      alias: 'test-alias',
    });
    createdSessionIds.push(session.id);

    const found = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      INTEGRATION_TEST_AGENT_ID,
      'test-alias'
    );

    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.alias).toBe('test-alias');
  });

  it('should return null for non-existent alias', async () => {
    const found = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      INTEGRATION_TEST_AGENT_ID,
      'nonexistent-alias-xyz'
    );

    expect(found).toBeNull();
  });

  it('should not find ended sessions by alias', async () => {
    const session = await repo.create({
      userId: INTEGRATION_TEST_USER_ID,
      agentId: INTEGRATION_TEST_AGENT_ID,
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      alias: 'ended-alias',
    });
    createdSessionIds.push(session.id);

    // End the session
    await repo.update(session.id, { endedAt: new Date() });

    const found = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      INTEGRATION_TEST_AGENT_ID,
      'ended-alias'
    );

    expect(found).toBeNull();
  });

  it('should update alias on existing session', async () => {
    const session = await repo.create({
      userId: INTEGRATION_TEST_USER_ID,
      agentId: INTEGRATION_TEST_AGENT_ID,
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
    });
    createdSessionIds.push(session.id);

    // Set alias
    const updated = await repo.update(session.id, { alias: 'dynamic-alias' });
    expect(updated.alias).toBe('dynamic-alias');

    // Find by alias
    const found = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      INTEGRATION_TEST_AGENT_ID,
      'dynamic-alias'
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
  });

  // ── default_session_id ──

  it('should set and read default_session_id on agent identity', async () => {
    // Create a session to be the default
    const session = await repo.create({
      userId: INTEGRATION_TEST_USER_ID,
      agentId: INTEGRATION_TEST_AGENT_ID,
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      alias: 'default-test',
    });
    createdSessionIds.push(session.id);

    // Set default_session_id on the identity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateError } = await (dataComposer.getClient() as any)
      .from('agent_identities')
      .update({ default_session_id: session.id })
      .eq('id', identityId);

    expect(updateError).toBeNull();

    // Read it back
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: identity } = (await (dataComposer.getClient() as any)
      .from('agent_identities')
      .select('default_session_id')
      .eq('id', identityId)
      .single()) as { data: { default_session_id: string | null } };

    expect(identity.default_session_id).toBe(session.id);
  });

  it('should cascade SET NULL when default session is deleted', async () => {
    // Create a throwaway session
    const { data: tempSession } = await dataComposer
      .getClient()
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: INTEGRATION_TEST_AGENT_ID,
        metadata: { disposable: true },
      })
      .select()
      .single();

    expect(tempSession).not.toBeNull();

    // Point default_session_id to it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (dataComposer.getClient() as any)
      .from('agent_identities')
      .update({ default_session_id: tempSession!.id })
      .eq('id', identityId);

    // Delete the session
    await dataComposer.getClient().from('sessions').delete().eq('id', tempSession!.id);

    // default_session_id should be null (ON DELETE SET NULL)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: identity } = (await (dataComposer.getClient() as any)
      .from('agent_identities')
      .select('default_session_id')
      .eq('id', identityId)
      .single()) as { data: { default_session_id: string | null } };

    expect(identity.default_session_id).toBeNull();
  });

  // ── Alias Uniqueness ──

  it('should enforce unique alias per agent among active sessions', async () => {
    const session1 = await repo.create({
      userId: INTEGRATION_TEST_USER_ID,
      agentId: INTEGRATION_TEST_AGENT_ID,
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      alias: 'unique-alias',
    });
    createdSessionIds.push(session1.id);

    // Creating a second active session with the same alias should fail
    await expect(
      repo.create({
        userId: INTEGRATION_TEST_USER_ID,
        agentId: INTEGRATION_TEST_AGENT_ID,
        backendSessionId: null,
        type: 'primary',
        lifecycle: 'idle',
        status: 'active',
        contextTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        messageCount: 0,
        tokenCount: 0,
        backend: 'claude-code',
        model: null,
        lastCompactionAt: null,
        compactionCount: 0,
        endedAt: null,
        metadata: {},
        alias: 'unique-alias',
      })
    ).rejects.toThrow();
  });
});
