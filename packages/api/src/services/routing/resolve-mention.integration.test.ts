/**
 * Mention Resolver Integration Tests
 *
 * Tests resolveAgentFromMention against a real Supabase database.
 * Uses the echo test agent identity (from migration 008) as a fixture.
 * Uses unique names (Zephyr, Kira, Orion) to avoid collisions with real identities.
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { resolveAgentFromMention } from './resolve-mention';

describe('resolveAgentFromMention (integration)', () => {
  let dataComposer: DataComposer;
  let testUserId: string;
  const createdIdentityIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();

    // Find the echo test agent's user
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

    // Create test identities with unique names to avoid collisions with real identities
    const testIdentities = [
      { agent_id: 'test-zephyr', name: 'Zephyr', role: 'test agent', user_id: testUserId },
      { agent_id: 'test-kira', name: 'Kira', role: 'test agent', user_id: testUserId },
      { agent_id: 'test-orion', name: 'Orion Bot', role: 'test agent', user_id: testUserId },
    ];

    for (const identity of testIdentities) {
      const { data, error: insertError } = await dataComposer
        .getClient()
        .from('agent_identities')
        .insert(identity)
        .select('id')
        .single();

      if (insertError) {
        throw new Error(`Failed to create test identity: ${insertError.message}`);
      }
      createdIdentityIds.push(data.id);
    }
  });

  afterAll(async () => {
    // Clean up test identities
    if (createdIdentityIds.length > 0) {
      await dataComposer
        .getClient()
        .from('agent_identities')
        .delete()
        .in('id', createdIdentityIds);
    }
  });

  it('resolves agent by mentioned username matching agent_id', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'hello',
      ['test-zephyr']
    );

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('test-zephyr');
  });

  it('resolves agent by mentioned username matching name (case-insensitive)', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'hello',
      ['kira']
    );

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('test-kira');
  });

  it('resolves agent by text mention with word boundary', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'hey test-zephyr, can you help?',
      []
    );

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('test-zephyr');
  });

  it('resolves agent by name in text (case-insensitive)', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'Hey ZEPHYR, check this out',
      []
    );

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('test-zephyr');
  });

  it('returns null when no agents are mentioned', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'just a normal message with no names',
      ['randomuser']
    );

    expect(result).toBeNull();
  });

  it('returns null for a different user who has no identities', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      '00000000-0000-0000-0000-000000000000', // non-existent user
      'hey zephyr',
      ['zephyr']
    );

    expect(result).toBeNull();
  });

  it('prioritizes mentioned username over text match', async () => {
    // Username says "test-kira", text says "zephyr" — username should win
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'zephyr should do this',
      ['test-kira']
    );

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('test-kira');
  });

  it('returns a valid identityId that exists in the database', async () => {
    const result = await resolveAgentFromMention(
      dataComposer.getClient(),
      testUserId,
      'hello',
      ['test-zephyr']
    );

    expect(result).not.toBeNull();
    expect(createdIdentityIds).toContain(result!.identityId);
  });
});
