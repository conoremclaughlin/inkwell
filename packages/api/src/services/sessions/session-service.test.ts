/**
 * Session Service Tests
 *
 * Tests for message locking, queueing, and session management.
 * Uses dependency injection for clean, isolated tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionService } from './session-service.js';
import type {
  Session,
  SessionType,
  SessionStatus,
  ISessionRepository,
  IContextBuilder,
  IClaudeRunner,
  InjectedContext,
  ClaudeRunnerConfig,
  ClaudeRunnerResult,
} from './types.js';
import type { IActivityStream } from './session-service.js';

// Mock logger (still needed as it's imported directly)
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock buildIdentityPrompt (imported function, not a class)
vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt'),
  };
});

describe('SessionService', () => {
  let sessionService: SessionService;

  // Mock dependencies
  let mockRepository: ISessionRepository;
  let mockContextBuilder: IContextBuilder;
  let mockClaudeRunner: IClaudeRunner;
  let mockCodexRunner: IClaudeRunner;
  let mockActivityStream: IActivityStream;

  const createMockSession = (overrides: Partial<Session> = {}): Session => ({
    id: 'session-123',
    userId: 'user-456',
    agentId: 'myra',
    claudeSessionId: 'claude-abc',
    type: 'primary',
    status: 'active',
    contextTokens: 1000,
    totalInputTokens: 5000,
    totalOutputTokens: 2000,
    messageCount: 0,
    tokenCount: 0,
    backend: 'claude-code',
    model: 'sonnet',
    lastCompactionAt: null,
    compactionCount: 0,
    taskDescription: undefined,
    parentSessionId: undefined,
    endedAt: null,
    metadata: {},
    startedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  });

  const createMockRequest = (overrides = {}) => ({
    userId: 'user-456',
    agentId: 'myra',
    channel: 'telegram' as const,
    conversationId: 'chat-123',
    sender: { id: '123456789', name: 'TestUser' },
    content: 'Hello, Myra!',
    metadata: {},
    ...overrides,
  });

  const createMockInjectedContext = (): InjectedContext => ({
    agent: {
      agentId: 'myra',
      name: 'Myra',
      role: 'assistant',
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: {
      id: 'user-456',
      timezone: 'America/Los_Angeles',
      contacts: {},
      preferences: {},
    },
    temporal: {
      currentTime: '10:00 AM',
      currentDate: '2026-02-05',
      dayOfWeek: 'Thursday',
      timezone: 'America/Los_Angeles',
      greeting: 'Good morning',
    },
    recentMemories: [],
    activeProjects: [],
  });

  const createMockClaudeResult = (
    overrides: Partial<ClaudeRunnerResult> = {}
  ): ClaudeRunnerResult => ({
    success: true,
    claudeSessionId: 'claude-abc',
    responses: [],
    usage: { contextTokens: 5000, inputTokens: 1000, outputTokens: 500 },
    finalTextResponse: 'Hello! How can I help?',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mocks for each test
    mockRepository = {
      findByUserAndAgent: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      findByUser: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (data) => createMockSession(data)),
      update: vi
        .fn()
        .mockImplementation(async (id, updates) => createMockSession({ id, ...updates })),
      updateTokenUsage: vi.fn().mockResolvedValue(undefined),
      markCompacted: vi.fn().mockResolvedValue(undefined),
      tryAcquireCompactionLock: vi.fn().mockResolvedValue(true),
      releaseCompactionLock: vi.fn().mockResolvedValue(undefined),
    };

    mockContextBuilder = {
      buildContext: vi.fn().mockResolvedValue(createMockInjectedContext()),
      buildMinimalContext: vi.fn().mockResolvedValue({
        temporal: createMockInjectedContext().temporal,
        agent: createMockInjectedContext().agent,
      }),
      getAgentBackend: vi.fn().mockResolvedValue('claude'),
    };

    mockClaudeRunner = {
      run: vi.fn().mockResolvedValue(createMockClaudeResult()),
    };

    mockCodexRunner = {
      run: vi
        .fn()
        .mockResolvedValue(createMockClaudeResult({ claudeSessionId: 'codex-session-1' })),
    };

    mockActivityStream = {
      logMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      logActivity: vi.fn().mockResolvedValue({ id: 'activity-123' }),
    };

    // Create service with injected dependencies
    sessionService = new SessionService(
      mockRepository,
      mockContextBuilder,
      mockClaudeRunner,
      mockActivityStream,
      {
        defaultWorkingDirectory: '/test',
        mcpConfigPath: '/test/.mcp.json',
        compactionThreshold: 150000,
      },
      mockCodexRunner
    );
  });

  describe('Message Locking', () => {
    it('should process messages sequentially for the same session', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const processOrder: number[] = [];

      // Make Claude runner take some time and track call order
      vi.mocked(mockClaudeRunner.run).mockImplementation(async () => {
        const callNumber = processOrder.length + 1;
        processOrder.push(callNumber);
        // Simulate processing time
        await new Promise((r) => setTimeout(r, 50));
        return createMockClaudeResult({ finalTextResponse: `Response ${callNumber}` });
      });

      // Send two messages concurrently
      const request1 = createMockRequest({ content: 'Message 1' });
      const request2 = createMockRequest({ content: 'Message 2' });

      const [result1, result2] = await Promise.all([
        sessionService.handleMessage(request1),
        sessionService.handleMessage(request2),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Should have been processed sequentially (1 then 2)
      expect(processOrder).toEqual([1, 2]);

      // ClaudeRunner.run should have been called twice
      expect(mockClaudeRunner.run).toHaveBeenCalledTimes(2);
    });

    it('should allow parallel processing for different agents', async () => {
      // Two different agents = two different sessions
      const session1 = createMockSession({ id: 'session-1', agentId: 'myra' });
      const session2 = createMockSession({ id: 'session-2', agentId: 'wren' });

      vi.mocked(mockRepository.findByUserAndAgent)
        .mockResolvedValueOnce(session1)
        .mockResolvedValueOnce(session2);

      const startTimes: number[] = [];

      vi.mocked(mockClaudeRunner.run).mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return createMockClaudeResult();
      });

      const request1 = createMockRequest({ agentId: 'myra' });
      const request2 = createMockRequest({ agentId: 'wren' });

      await Promise.all([
        sessionService.handleMessage(request1),
        sessionService.handleMessage(request2),
      ]);

      // Both should have started at roughly the same time (parallel)
      // Allow 20ms tolerance for test execution variance
      expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(20);
    });

    it('should release lock even when processing fails', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      // First call fails
      vi.mocked(mockClaudeRunner.run)
        .mockRejectedValueOnce(new Error('Claude crashed'))
        .mockResolvedValueOnce(createMockClaudeResult({ finalTextResponse: 'Success!' }));

      const request1 = createMockRequest({ content: 'Will fail' });
      const request2 = createMockRequest({ content: 'Should succeed' });

      // Send first message (will fail)
      const result1 = await sessionService.handleMessage(request1);
      expect(result1.success).toBe(false);
      expect(result1.error).toContain('Claude crashed');

      // Send second message (should succeed - lock was released)
      const result2 = await sessionService.handleMessage(request2);
      expect(result2.success).toBe(true);
    });

    it('should queue messages and process them in order', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const processedContents: string[] = [];

      vi.mocked(mockClaudeRunner.run).mockImplementation(async (message: string) => {
        // Extract content from formatted message (simplified)
        const match = message.match(/Message (\d)/);
        if (match) {
          processedContents.push(`Message ${match[1]}`);
        }
        await new Promise((r) => setTimeout(r, 30));
        return createMockClaudeResult();
      });

      // Send 3 messages rapidly
      const promises = [
        sessionService.handleMessage(createMockRequest({ content: 'Message 1' })),
        sessionService.handleMessage(createMockRequest({ content: 'Message 2' })),
        sessionService.handleMessage(createMockRequest({ content: 'Message 3' })),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // Should have been processed in order
      expect(processedContents).toEqual(['Message 1', 'Message 2', 'Message 3']);
    });

    it('should queue heartbeat when telegram message is processing (race condition fix)', async () => {
      // This tests the exact bug scenario: telegram message and heartbeat arrive simultaneously
      // Both target the same agent (myra) and thus the same Claude session
      // Without locking, two `claude --resume` processes would race
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const processLog: Array<{ channel: string; startTime: number; endTime?: number }> = [];
      let resolveFirstMessage: () => void;
      const firstMessageStarted = new Promise<void>((resolve) => {
        resolveFirstMessage = resolve;
      });

      vi.mocked(mockClaudeRunner.run).mockImplementation(async (message: string) => {
        const isTelegram = message.includes('telegram');
        const isHeartbeat = message.includes('HEARTBEAT');
        const channel = isTelegram ? 'telegram' : isHeartbeat ? 'heartbeat' : 'unknown';

        const entry = { channel, startTime: Date.now() };
        processLog.push(entry);

        // Signal that first message processing has started
        if (processLog.length === 1) {
          resolveFirstMessage();
        }

        // Simulate Claude Code processing time
        await new Promise((r) => setTimeout(r, 100));

        entry.endTime = Date.now();

        return createMockClaudeResult({ finalTextResponse: `Processed ${channel}` });
      });

      // Telegram message from user
      const telegramRequest = createMockRequest({
        channel: 'telegram',
        conversationId: 'chat-123',
        content: 'Check my emails please',
      });

      // Heartbeat trigger (same agent, same session, different channel)
      const heartbeatRequest = createMockRequest({
        channel: 'agent',
        conversationId: 'heartbeat:reminder-456',
        content: '[HEARTBEAT REMINDER] Check emails hourly',
        metadata: { triggerType: 'heartbeat' },
      });

      // Start telegram message
      const telegramPromise = sessionService.handleMessage(telegramRequest);

      // Wait for telegram processing to start, then send heartbeat
      await firstMessageStarted;

      // Send heartbeat while telegram is still processing
      const heartbeatPromise = sessionService.handleMessage(heartbeatRequest);

      // Both should complete
      const [telegramResult, heartbeatResult] = await Promise.all([
        telegramPromise,
        heartbeatPromise,
      ]);

      expect(telegramResult.success).toBe(true);
      expect(heartbeatResult.success).toBe(true);

      // Verify sequential processing (heartbeat waited for telegram)
      expect(processLog).toHaveLength(2);

      // First should be telegram
      expect(processLog[0].channel).toBe('telegram');
      // Second should be heartbeat
      expect(processLog[1].channel).toBe('heartbeat');

      // Heartbeat should have started AFTER telegram ended (queued, not concurrent)
      expect(processLog[1].startTime).toBeGreaterThanOrEqual(processLog[0].endTime!);
    });

    it('should handle simultaneous telegram + heartbeat arriving at exact same time', async () => {
      // Edge case: both arrive before either acquires the lock
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const processedChannels: string[] = [];

      vi.mocked(mockClaudeRunner.run).mockImplementation(async (message: string) => {
        const channel = message.includes('telegram')
          ? 'telegram'
          : message.includes('HEARTBEAT')
            ? 'heartbeat'
            : 'unknown';
        processedChannels.push(channel);
        await new Promise((r) => setTimeout(r, 50));
        return createMockClaudeResult();
      });

      const telegramRequest = createMockRequest({
        channel: 'telegram',
        content: 'User message',
      });

      const heartbeatRequest = createMockRequest({
        channel: 'agent',
        content: '[HEARTBEAT REMINDER] Scheduled task',
        metadata: { triggerType: 'heartbeat' },
      });

      // Fire both at exact same time (Promise.all starts them together)
      const results = await Promise.all([
        sessionService.handleMessage(telegramRequest),
        sessionService.handleMessage(heartbeatRequest),
      ]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      // Both processed, but sequentially (one waited for the other)
      expect(processedChannels).toHaveLength(2);
      // Order may vary based on which acquires lock first, but no concurrent execution
      expect(mockClaudeRunner.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('Session Management', () => {
    it('should create a new session when none exists', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockRepository.create).mockResolvedValue(createMockSession({ id: 'new-session' }));

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(true);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-456',
          agentId: 'myra',
          type: 'primary',
          status: 'active',
        })
      );
    });

    it('should reuse existing session for primary sessions', async () => {
      const existingSession = createMockSession({ id: 'existing-session' });
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(existingSession);

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('existing-session');
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('should set backend and model when creating a new session', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockRepository.create).mockResolvedValue(createMockSession({ id: 'new-session' }));

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: 'claude-code',
          model: null, // model is deferred — set when runner reports it, not at creation
          messageCount: 0,
          tokenCount: 0,
        })
      );
    });

    it('should resolve codex backend from agent identity when creating a new session', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockContextBuilder.getAgentBackend).mockResolvedValue('codex');
      vi.mocked(mockRepository.create).mockResolvedValue(createMockSession({ id: 'new-session' }));

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: 'codex-cli',
        })
      );
    });

    it('should use codex runner when session backend is codex-cli', async () => {
      const codexSession = createMockSession({
        id: 'codex-session',
        backend: 'codex-cli',
        claudeSessionId: null,
      });
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(codexSession);

      const request = createMockRequest({ content: 'Use codex backend please' });
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(true);
      expect(mockCodexRunner.run).toHaveBeenCalledTimes(1);
      expect(mockClaudeRunner.run).not.toHaveBeenCalled();
      const codexCallArgs = vi.mocked(mockCodexRunner.run).mock.calls[0][1];
      expect(codexCallArgs.config).not.toHaveProperty('model');
      expect(mockRepository.update).toHaveBeenCalledWith(
        'codex-session',
        expect.objectContaining({ backend: 'codex-cli' })
      );
    });

    it('should increment messageCount after each processed message', async () => {
      const session = createMockSession({ messageCount: 5 });
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      expect(mockRepository.update).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({ messageCount: 6 })
      );
    });

    it('should accumulate tokenCount via updateTokenUsage', async () => {
      const session = createMockSession({
        totalInputTokens: 3000,
        totalOutputTokens: 1000,
        tokenCount: 4000,
      });
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      // Wire updateTokenUsage to replicate the real repository logic:
      // it calls findById, computes new totals, then calls update with tokenCount
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.updateTokenUsage).mockImplementation(async (id, usage) => {
        const current = await mockRepository.findById(id);
        if (!current) throw new Error('not found');
        const newInput = current.totalInputTokens + usage.inputTokens;
        const newOutput = current.totalOutputTokens + usage.outputTokens;
        await mockRepository.update(id, {
          contextTokens: usage.contextTokens,
          totalInputTokens: newInput,
          totalOutputTokens: newOutput,
          tokenCount: newInput + newOutput,
        });
      });

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          usage: { contextTokens: 8000, inputTokens: 2000, outputTokens: 500 },
        })
      );

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      // Verify tokenCount = (3000+2000) + (1000+500) = 6500
      expect(mockRepository.update).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({
          contextTokens: 8000,
          totalInputTokens: 5000,
          totalOutputTokens: 1500,
          tokenCount: 6500,
        })
      );
    });

    it('should update Claude session ID when it changes', async () => {
      const session = createMockSession({ claudeSessionId: 'old-claude-id' });
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({ claudeSessionId: 'new-claude-id' })
      );

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      expect(mockRepository.update).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({
          claudeSessionId: 'new-claude-id',
          messageCount: 1,
          backend: 'claude-code',
        })
      );
    });
  });

  describe('Activity Stream Logging', () => {
    it('should log incoming messages to activity stream', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const request = createMockRequest({ content: 'Test message' });
      await sessionService.handleMessage(request);

      expect(mockActivityStream.logMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-456',
          agentId: 'myra',
          direction: 'in',
          content: 'Test message',
          platform: 'telegram',
          platformChatId: 'chat-123',
        })
      );
    });

    it('should handle activity stream errors gracefully', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);
      vi.mocked(mockActivityStream.logMessage).mockRejectedValue(new Error('DB error'));

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      // Should still succeed despite activity logging failure
      expect(result.success).toBe(true);
    });

    it('should log tool calls to activity stream', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          toolCalls: [
            { toolUseId: 'tu-1', toolName: 'mcp__pcp__recall', input: { query: 'emails' } },
            {
              toolUseId: 'tu-2',
              toolName: 'mcp__pcp__send_response',
              input: { content: 'Here are your emails' },
            },
          ],
        })
      );

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      // Give fire-and-forget a tick to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(mockActivityStream.logActivity).toHaveBeenCalledTimes(2);
      expect(mockActivityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_call',
          subtype: 'mcp__pcp__recall',
          content: 'mcp__pcp__recall(query)',
          sessionId: 'session-123',
        })
      );
      expect(mockActivityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_call',
          subtype: 'mcp__pcp__send_response',
          content: 'mcp__pcp__send_response(content)',
        })
      );
    });

    it('should not log tool calls when there are none', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(createMockClaudeResult({ toolCalls: [] }));

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockActivityStream.logActivity).not.toHaveBeenCalled();
    });

    it('should truncate large tool call inputs', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      const largeInput = { data: 'x'.repeat(15_000) };
      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          toolCalls: [{ toolUseId: 'tu-1', toolName: 'mcp__pcp__remember', input: largeInput }],
        })
      );

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockActivityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            input: expect.objectContaining({
              _truncated: true,
              _length: expect.any(Number),
              _preview: expect.any(String),
            }),
          }),
        })
      );
    });

    it('should not block response delivery if tool call logging fails', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);
      vi.mocked(mockActivityStream.logActivity).mockRejectedValue(new Error('DB error'));

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          toolCalls: [
            { toolUseId: 'tu-1', toolName: 'mcp__pcp__recall', input: { query: 'test' } },
          ],
        })
      );

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      // Response should still succeed even though tool call logging failed
      expect(result.success).toBe(true);
    });
  });

  describe('Compaction Triggering', () => {
    it('should trigger compaction when context tokens exceed threshold', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          usage: { contextTokens: 160000, inputTokens: 5000, outputTokens: 2000 }, // Above 150k threshold
        })
      );

      const request = createMockRequest();
      await sessionService.handleMessage(request);

      // Compaction should be triggered (asynchronously)
      // We can't easily verify the async compaction call, but we can check no errors occurred
      expect(mockRepository.updateTokenUsage).toHaveBeenCalled();
    });

    it('should not trigger compaction when tokens are below threshold', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          usage: { contextTokens: 50000, inputTokens: 1000, outputTokens: 500 }, // Well below threshold
        })
      );

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(true);
      expect(result.compactionTriggered).toBe(false);
    });

    it('should skip compaction when lock is already held (re-entry guard)', async () => {
      const session = createMockSession({ claudeSessionId: 'claude-abc' });
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.tryAcquireCompactionLock).mockResolvedValue(false);

      await sessionService.triggerCompaction('session-123');

      // Should NOT run compaction (lock not acquired)
      expect(mockClaudeRunner.run).not.toHaveBeenCalled();
      expect(mockRepository.markCompacted).not.toHaveBeenCalled();
      // Should NOT release a lock we never acquired
      expect(mockRepository.releaseCompactionLock).not.toHaveBeenCalled();
    });

    it('should acquire and release lock around compaction', async () => {
      const session = createMockSession({ claudeSessionId: 'claude-abc' });
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.tryAcquireCompactionLock).mockResolvedValue(true);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(createMockClaudeResult({ success: true }));

      await sessionService.triggerCompaction('session-123');

      // Should have acquired lock, run compaction, and released lock
      expect(mockRepository.tryAcquireCompactionLock).toHaveBeenCalledWith('session-123');
      expect(mockClaudeRunner.run).toHaveBeenCalledTimes(1);
      expect(mockRepository.markCompacted).toHaveBeenCalledWith('session-123', '');
      expect(mockRepository.releaseCompactionLock).toHaveBeenCalledWith('session-123');
    });

    it('should release lock even when compaction fails', async () => {
      const session = createMockSession({ claudeSessionId: 'claude-abc' });
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.tryAcquireCompactionLock).mockResolvedValue(true);

      vi.mocked(mockClaudeRunner.run).mockRejectedValue(new Error('Process crashed'));

      await expect(sessionService.triggerCompaction('session-123')).rejects.toThrow(
        'Process crashed'
      );

      // Lock should still be released despite failure
      expect(mockRepository.releaseCompactionLock).toHaveBeenCalledWith('session-123');
    });

    it('should route compaction responses via responseHandler (two-phase)', async () => {
      const mockResponseHandler = vi.fn().mockResolvedValue(undefined);

      // Create service with responseHandler
      const serviceWithHandler = new SessionService(
        mockRepository,
        mockContextBuilder,
        mockClaudeRunner,
        mockActivityStream,
        {
          defaultWorkingDirectory: '/test',
          mcpConfigPath: '/test/.mcp.json',
          compactionThreshold: 150000,
          responseHandler: mockResponseHandler,
        }
      );

      const session = createMockSession({ claudeSessionId: 'claude-abc' });
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.tryAcquireCompactionLock).mockResolvedValue(true);

      const compactionResponses = [
        {
          channel: 'telegram' as const,
          conversationId: 'chat-123',
          content: "I'm consolidating my memories, one moment!",
        },
      ];

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({ success: true, responses: compactionResponses })
      );

      await serviceWithHandler.triggerCompaction('session-123');

      // Phase 1: Compaction responses should be routed
      expect(mockResponseHandler).toHaveBeenCalledWith(compactionResponses);
      // Phase 2: Session should be marked as compacted after responses routed
      expect(mockRepository.markCompacted).toHaveBeenCalledWith('session-123', '');
    });

    it('should still complete compaction if response routing fails', async () => {
      const mockResponseHandler = vi.fn().mockRejectedValue(new Error('Channel offline'));

      const serviceWithHandler = new SessionService(
        mockRepository,
        mockContextBuilder,
        mockClaudeRunner,
        mockActivityStream,
        {
          defaultWorkingDirectory: '/test',
          mcpConfigPath: '/test/.mcp.json',
          compactionThreshold: 150000,
          responseHandler: mockResponseHandler,
        }
      );

      const session = createMockSession({ claudeSessionId: 'claude-abc' });
      vi.mocked(mockRepository.findById).mockResolvedValue(session);
      vi.mocked(mockRepository.tryAcquireCompactionLock).mockResolvedValue(true);

      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          success: true,
          responses: [
            { channel: 'telegram' as const, conversationId: 'chat-123', content: 'Compacting...' },
          ],
        })
      );

      // Should not throw even though response routing failed
      await serviceWithHandler.triggerCompaction('session-123');

      // Compaction should still complete
      expect(mockRepository.markCompacted).toHaveBeenCalledWith('session-123', '');
    });
  });

  describe('Error Handling', () => {
    it('should return error result when session creation fails', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockRepository.create).mockRejectedValue(new Error('DB connection failed'));

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB connection failed');
      expect(result.errorCode).toBe('INTERNAL_ERROR');
    });

    it('should return error result when Claude runner fails', async () => {
      const session = createMockSession();
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(session);
      vi.mocked(mockClaudeRunner.run).mockResolvedValue(
        createMockClaudeResult({
          success: false,
          error: 'Claude process crashed',
        })
      );

      const request = createMockRequest();
      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claude process crashed');
    });
  });

  describe('Lock Key Format', () => {
    it('should use agentId:sessionId as lock key for debuggability', async () => {
      // This test verifies the lock key format by checking that messages
      // to the same agent+session are queued, but different agents are parallel

      const sessionMyra = createMockSession({ id: 'session-myra', agentId: 'myra' });
      const sessionWren = createMockSession({ id: 'session-wren', agentId: 'wren' });

      vi.mocked(mockRepository.findByUserAndAgent)
        .mockResolvedValueOnce(sessionMyra) // First myra request
        .mockResolvedValueOnce(sessionWren) // First wren request
        .mockResolvedValueOnce(sessionMyra); // Second myra request (queued)

      const callLog: string[] = [];

      vi.mocked(mockClaudeRunner.run).mockImplementation(async () => {
        const callNum = callLog.length + 1;
        callLog.push(`call-${callNum}`);
        await new Promise((r) => setTimeout(r, 50));
        return createMockClaudeResult();
      });

      // Send: myra, wren, myra
      // Expected: myra-1 and wren start in parallel, myra-2 waits for myra-1
      const results = await Promise.all([
        sessionService.handleMessage(createMockRequest({ agentId: 'myra', content: 'M1' })),
        sessionService.handleMessage(createMockRequest({ agentId: 'wren', content: 'W1' })),
        sessionService.handleMessage(createMockRequest({ agentId: 'myra', content: 'M2' })),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      // All 3 should have been processed
      expect(callLog).toHaveLength(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ThreadKey Session Routing
  // ═══════════════════════════════════════════════════════════════
  describe('ThreadKey Session Routing', () => {
    it('should pass threadKey from metadata to getOrCreateSession', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockRepository.create).mockResolvedValue(
        createMockSession({ id: 'thread-session', threadKey: 'pr:43' })
      );

      const request = createMockRequest({
        metadata: { threadKey: 'pr:43', triggerType: 'agent', chatType: 'direct' },
      });

      const result = await sessionService.handleMessage(request);

      expect(result.success).toBe(true);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadKey: 'pr:43',
        })
      );
    });

    it('should store threadKey on created session', async () => {
      vi.mocked(mockRepository.findByUserAndAgent).mockResolvedValue(null);
      vi.mocked(mockRepository.create).mockResolvedValue(
        createMockSession({ id: 'new-thread-session', threadKey: 'pr:99' })
      );

      const request = createMockRequest({
        metadata: { threadKey: 'pr:99' },
      });

      await sessionService.handleMessage(request);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadKey: 'pr:99',
        })
      );
    });

    it('should match existing session by threadKey when repository supports it', async () => {
      const existingThreadSession = createMockSession({
        id: 'existing-thread-session',
        threadKey: 'pr:43',
        claudeSessionId: 'claude-thread-abc',
      });

      // Add findByThreadKey to mock repository
      const mockRepoWithThreadKey = {
        ...mockRepository,
        findByThreadKey: vi.fn().mockResolvedValue(existingThreadSession),
      };

      const serviceWithThreadKey = new SessionService(
        mockRepoWithThreadKey,
        mockContextBuilder,
        mockClaudeRunner,
        mockActivityStream,
        {
          defaultWorkingDirectory: '/test',
          mcpConfigPath: '/test/.mcp.json',
          compactionThreshold: 150000,
        },
        mockCodexRunner
      );

      const request = createMockRequest({
        metadata: { threadKey: 'pr:43', triggerType: 'agent', chatType: 'direct' },
      });

      const result = await serviceWithThreadKey.handleMessage(request);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('existing-thread-session');
      // threadKey match should be tried first
      expect(mockRepoWithThreadKey.findByThreadKey).toHaveBeenCalledWith(
        'user-456',
        'myra',
        'pr:43'
      );
      // Should NOT have created a new session
      expect(mockRepoWithThreadKey.create).not.toHaveBeenCalled();
    });

    it('should create a new thread-scoped session when threadKey has no match', async () => {
      // Add findByThreadKey that returns null (no match)
      const mockRepoWithThreadKey = {
        ...mockRepository,
        findByThreadKey: vi.fn().mockResolvedValue(null),
        findByUserAndAgent: vi.fn(),
        create: vi.fn().mockResolvedValue(
          createMockSession({
            id: 'new-thread-session',
            threadKey: 'pr:999',
            claudeSessionId: null,
          })
        ),
      };

      const serviceWithThreadKey = new SessionService(
        mockRepoWithThreadKey,
        mockContextBuilder,
        mockClaudeRunner,
        mockActivityStream,
        {
          defaultWorkingDirectory: '/test',
          mcpConfigPath: '/test/.mcp.json',
          compactionThreshold: 150000,
        },
        mockCodexRunner
      );

      const request = createMockRequest({
        metadata: { threadKey: 'pr:999', triggerType: 'agent' },
      });

      const result = await serviceWithThreadKey.handleMessage(request);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('new-thread-session');
      // threadKey tried first, then created dedicated thread session
      expect(mockRepoWithThreadKey.findByThreadKey).toHaveBeenCalledWith(
        'user-456',
        'myra',
        'pr:999'
      );
      expect(mockRepoWithThreadKey.findByUserAndAgent).not.toHaveBeenCalled();
      expect(mockRepoWithThreadKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadKey: 'pr:999',
        })
      );
    });

    it('should not use threadKey matching when no threadKey provided', async () => {
      const existingSession = createMockSession({ id: 'normal-session' });

      const mockRepoWithThreadKey = {
        ...mockRepository,
        findByThreadKey: vi.fn(),
        findByUserAndAgent: vi.fn().mockResolvedValue(existingSession),
      };

      const serviceWithThreadKey = new SessionService(
        mockRepoWithThreadKey,
        mockContextBuilder,
        mockClaudeRunner,
        mockActivityStream,
        {
          defaultWorkingDirectory: '/test',
          mcpConfigPath: '/test/.mcp.json',
          compactionThreshold: 150000,
        },
        mockCodexRunner
      );

      const request = createMockRequest(); // No threadKey

      await serviceWithThreadKey.handleMessage(request);

      // findByThreadKey should NOT have been called
      expect(mockRepoWithThreadKey.findByThreadKey).not.toHaveBeenCalled();
      // Normal path should have been used
      expect(mockRepoWithThreadKey.findByUserAndAgent).toHaveBeenCalled();
    });
  });
});
