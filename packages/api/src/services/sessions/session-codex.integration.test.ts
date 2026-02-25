/**
 * SessionService Codex Integration Tests
 *
 * Verifies database-driven backend selection using agent_identities.backend.
 * Creates a test identity "echo_codex" and ensures SessionService routes it
 * to Codex runner and persists backend as codex-cli.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer.js';
import { SessionService } from './session-service.js';
import { SessionRepository } from './session-repository.js';
import { ContextBuilder } from './context-builder.js';
import type { IActivityStream } from './session-service.js';
import type { IClaudeRunner } from './types.js';

describe('SessionService Codex backend integration', () => {
  let dataComposer: DataComposer | null = null;
  let testUserId: string;
  let sessionService: SessionService;

  const claudeRunner: IClaudeRunner = {
    run: vi.fn(async () => ({
      success: true,
      claudeSessionId: 'claude-test-session',
      responses: [],
      usage: { contextTokens: 10, inputTokens: 5, outputTokens: 5 },
      finalTextResponse: 'claude response',
      toolCalls: [],
    })),
  };

  const codexRunner: IClaudeRunner = {
    run: vi.fn(async () => ({
      success: true,
      claudeSessionId: 'codex-test-session',
      responses: [],
      usage: { contextTokens: 10, inputTokens: 5, outputTokens: 5 },
      finalTextResponse: 'codex response',
      toolCalls: [],
    })),
  };

  const activityStream: IActivityStream = {
    logMessage: vi.fn(async () => ({ id: 'msg-id' })),
    logActivity: vi.fn(async () => ({ id: 'activity-id' })),
  };

  beforeAll(async () => {
    dataComposer = await getDataComposer();

    // Resolve known test user via existing echo identity (seeded by migration 008)
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

    // Ensure echo_codex identity exists and is configured for codex backend
    const { data: existing } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('id')
      .eq('user_id', testUserId)
      .eq('agent_id', 'echo_codex')
      .single();

    if (existing?.id) {
      const { error: updateError } = await dataComposer
        .getClient()
        .from('agent_identities')
        .update({
          backend: 'codex',
          name: 'Echo Codex',
          role: 'Test agent identity for Codex backend integration',
        })
        .eq('id', existing.id);

      if (updateError) {
        throw new Error(`Failed to update echo_codex identity: ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await dataComposer
        .getClient()
        .from('agent_identities')
        .insert({
          user_id: testUserId,
          agent_id: 'echo_codex',
          name: 'Echo Codex',
          role: 'Test agent identity for Codex backend integration',
          description: 'Created by integration tests',
          backend: 'codex',
          values: [],
          capabilities: [],
          relationships: {},
          metadata: { test: true },
        });

      if (insertError) {
        throw new Error(`Failed to create echo_codex identity: ${insertError.message}`);
      }
    }

    sessionService = new SessionService(
      new SessionRepository(dataComposer.getClient()),
      new ContextBuilder(dataComposer.getClient()),
      claudeRunner,
      activityStream,
      {
        defaultWorkingDirectory: process.cwd(),
        mcpConfigPath: '',
      },
      codexRunner
    );
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!dataComposer) return;
    await dataComposer
      .getClient()
      .from('sessions')
      .delete()
      .eq('user_id', testUserId)
      .eq('agent_id', 'echo_codex');
  });

  afterAll(async () => {
    if (!dataComposer) return;
    await dataComposer
      .getClient()
      .from('sessions')
      .delete()
      .eq('user_id', testUserId)
      .eq('agent_id', 'echo_codex');

    await dataComposer
      .getClient()
      .from('agent_identities')
      .delete()
      .eq('user_id', testUserId)
      .eq('agent_id', 'echo_codex');
  });

  it('creates session with codex-cli backend from agent identity backend=codex', async () => {
    const session = await sessionService.getOrCreateSession(testUserId, 'echo_codex');
    expect(session.backend).toBe('codex-cli');
  });

  it('routes message handling through codex runner for echo_codex', async () => {
    const result = await sessionService.handleMessage({
      userId: testUserId,
      agentId: 'echo_codex',
      channel: 'agent',
      conversationId: 'integration:echo-codex',
      sender: { id: 'integration-test', name: 'Integration Test' },
      content: 'Say hello from integration test',
      metadata: { triggerType: 'agent', chatType: 'direct' },
    });

    expect(result.success).toBe(true);
    expect(codexRunner.run).toHaveBeenCalledTimes(1);
    expect(claudeRunner.run).not.toHaveBeenCalled();

    const { data: persisted } = await dataComposer
      .getClient()
      .from('sessions')
      .select('backend')
      .eq('id', result.sessionId)
      .single();

    expect(persisted?.backend).toBe('codex-cli');
  });
});
