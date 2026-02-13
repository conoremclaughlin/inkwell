/**
 * Agent Gateway Integration Tests
 *
 * Tests the stateless trigger handler with real database lookups.
 * Uses the echo test agent identity (seeded by migration 008).
 *
 * These tests verify:
 * 1. Agent validation via agent_identities table lookup
 * 2. UserId derivation from inbox messages
 * 3. Unknown agent rejection
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../data/composer';
import { AgentGateway, type AgentTriggerPayload } from './agent-gateway';

describe('AgentGateway Integration (database-driven)', () => {
  let dataComposer: DataComposer;
  let gateway: AgentGateway;
  let testUserId: string;
  let testInboxMessageId: string;

  beforeAll(async () => {
    // Initialize real database connection
    dataComposer = await getDataComposer();
    gateway = new AgentGateway();

    // Resolve test user (owner of echo agent identity)
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

    // Create a test inbox message for userId derivation tests
    const { data: inboxMsg, error: inboxError } = await dataComposer
      .getClient()
      .from('agent_inbox')
      .insert({
        recipient_user_id: testUserId,
        recipient_agent_id: 'echo',
        sender_agent_id: 'test-sender',
        content: 'Integration test message',
        message_type: 'message',
        priority: 'normal',
      })
      .select()
      .single();

    if (inboxError || !inboxMsg) {
      throw new Error(`Failed to create test inbox message: ${inboxError?.message}`);
    }

    testInboxMessageId = inboxMsg.id;
  });

  afterAll(async () => {
    // Cleanup test inbox message
    if (testInboxMessageId) {
      await dataComposer.getClient().from('agent_inbox').delete().eq('id', testInboxMessageId);
    }
  });

  describe('agent validation via database', () => {
    it('should find echo agent in agent_identities table', async () => {
      const { data } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('agent_id, name, role')
        .eq('agent_id', 'echo')
        .single();

      expect(data).toBeDefined();
      expect(data?.agent_id).toBe('echo');
      expect(data?.name).toBe('Echo');
    });

    it('should not find non-existent agent', async () => {
      const { data } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('agent_id')
        .eq('agent_id', 'definitely-not-a-real-agent-xyz')
        .limit(1);

      expect(data).toEqual([]);
    });
  });

  describe('userId derivation from inbox message', () => {
    it('should derive userId from inbox message', async () => {
      const { data: inboxMsg } = await dataComposer
        .getClient()
        .from('agent_inbox')
        .select('recipient_user_id')
        .eq('id', testInboxMessageId)
        .single();

      expect(inboxMsg).toBeDefined();
      expect(inboxMsg?.recipient_user_id).toBe(testUserId);
    });
  });

  describe('default handler with database lookup', () => {
    it('should process trigger for known agent (echo) via default handler', async () => {
      let processedPayload: AgentTriggerPayload | null = null;

      // Set up default handler that validates agent exists
      gateway.setDefaultHandler(async (payload) => {
        // Simulate the server.ts validation logic
        const { data: agentIdentity } = await dataComposer
          .getClient()
          .from('agent_identities')
          .select('agent_id')
          .eq('agent_id', payload.toAgentId)
          .limit(1);

        const knownAgents = ['myra', 'wren', 'benson'];
        const existsInDb = agentIdentity && agentIdentity.length > 0;
        const isKnownAgent = knownAgents.includes(payload.toAgentId);

        if (!existsInDb && !isKnownAgent) {
          throw new Error(`Unknown agent: ${payload.toAgentId}`);
        }

        // Derive userId from inbox message
        if (payload.inboxMessageId) {
          const { data: inboxMsg } = await dataComposer
            .getClient()
            .from('agent_inbox')
            .select('recipient_user_id')
            .eq('id', payload.inboxMessageId)
            .single();

          if (!inboxMsg?.recipient_user_id) {
            throw new Error('Cannot derive userId from inbox message');
          }
        }

        processedPayload = payload;
      });

      const payload: AgentTriggerPayload = {
        fromAgentId: 'test-sender',
        toAgentId: 'echo', // Exists in DB
        inboxMessageId: testInboxMessageId,
        triggerType: 'message',
        summary: 'Integration test trigger',
      };

      const result = await gateway.processTrigger(payload);

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
      expect(processedPayload).toEqual(payload);
    });

    it('should reject trigger for unknown agent', async () => {
      gateway.setDefaultHandler(async (payload) => {
        const { data: agentIdentity } = await dataComposer
          .getClient()
          .from('agent_identities')
          .select('agent_id')
          .eq('agent_id', payload.toAgentId)
          .limit(1);

        const knownAgents = ['myra', 'wren', 'benson'];
        const existsInDb = agentIdentity && agentIdentity.length > 0;
        const isKnownAgent = knownAgents.includes(payload.toAgentId);

        if (!existsInDb && !isKnownAgent) {
          throw new Error(`Unknown agent: ${payload.toAgentId}`);
        }
      });

      const payload: AgentTriggerPayload = {
        fromAgentId: 'test-sender',
        toAgentId: 'fake-agent-does-not-exist',
        triggerType: 'message',
      };

      const result = await gateway.processTrigger(payload);

      expect(result.success).toBe(false);
      expect(result.processed).toBe(false);
      expect(result.error).toContain('Unknown agent');
    });

    it('should process trigger for hardcoded known agent (myra) even without DB entry', async () => {
      let processedAgentId: string | null = null;

      gateway.setDefaultHandler(async (payload) => {
        const { data: agentIdentity } = await dataComposer
          .getClient()
          .from('agent_identities')
          .select('agent_id')
          .eq('agent_id', payload.toAgentId)
          .limit(1);

        const knownAgents = ['myra', 'wren', 'benson'];
        const existsInDb = agentIdentity && agentIdentity.length > 0;
        const isKnownAgent = knownAgents.includes(payload.toAgentId);

        if (!existsInDb && !isKnownAgent) {
          throw new Error(`Unknown agent: ${payload.toAgentId}`);
        }

        processedAgentId = payload.toAgentId;
      });

      // myra is in knownAgents list, should work even if not in agent_identities
      const payload: AgentTriggerPayload = {
        fromAgentId: 'test-sender',
        toAgentId: 'myra',
        triggerType: 'message',
      };

      const result = await gateway.processTrigger(payload);

      expect(result.success).toBe(true);
      expect(processedAgentId).toBe('myra');
    });
  });
});
