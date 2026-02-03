/**
 * Session Host Tests
 *
 * Tests for session persistence, restoration, and context window rotation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../mcp/tools/response-handlers', () => ({
  setResponseCallback: vi.fn(),
  addPendingMessage: vi.fn(),
}));

vi.mock('../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn(() => ({
    registerHandler: vi.fn(),
  })),
}));

// Mock BackendManager
const mockBackendManager = Object.assign(new EventEmitter(), {
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue(null),
  getActiveBackendType: vi.fn().mockReturnValue('claude-code'),
  setResponseHandler: vi.fn(),
  resumeSession: vi.fn().mockResolvedValue(true),
  clearSession: vi.fn(),
  getClaudeCodeBackend: vi.fn().mockReturnValue(null),
});

vi.mock('./backend-manager', () => ({
  BackendManager: vi.fn(),
  createBackendManager: vi.fn(() => mockBackendManager),
}));

// Mock Supabase query builder
function createMockQueryBuilder() {
  const builder: Record<string, any> = {};
  builder.from = vi.fn().mockReturnValue(builder);
  builder.select = vi.fn().mockReturnValue(builder);
  builder.insert = vi.fn().mockReturnValue(builder);
  builder.update = vi.fn().mockReturnValue(builder);
  builder.upsert = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.is = vi.fn().mockReturnValue(builder);
  builder.not = vi.fn().mockReturnValue(builder);
  builder.order = vi.fn().mockReturnValue(builder);
  builder.limit = vi.fn().mockReturnValue(builder);
  builder.single = vi.fn().mockResolvedValue({ data: null, error: null });
  return builder;
}

import { SessionHost } from './session-host';

describe('SessionHost', () => {
  let sessionHost: SessionHost;
  let mockQueryBuilder: ReturnType<typeof createMockQueryBuilder>;
  let mockDataComposer: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the mock backend manager events
    mockBackendManager.removeAllListeners();
    mockBackendManager.initialize.mockResolvedValue(undefined);
    mockBackendManager.resumeSession.mockResolvedValue(true);

    mockQueryBuilder = createMockQueryBuilder();
    mockDataComposer = {
      getClient: vi.fn().mockReturnValue(mockQueryBuilder),
      repositories: {
        users: { findById: vi.fn(), findByPlatformId: vi.fn() },
        context: { findAllByUser: vi.fn() },
        projects: { findAllByUser: vi.fn() },
        sessionFocus: { findLatestByUser: vi.fn() },
        memory: { recall: vi.fn(), getActiveSession: vi.fn() },
        conversations: { findByPlatformChatId: vi.fn(), createConversation: vi.fn(), createMessage: vi.fn() },
        activityStream: { getConversationHistory: vi.fn() },
      },
    };

    sessionHost = new SessionHost({
      backend: { primaryBackend: 'claude-code', backends: {} },
      dataComposer: mockDataComposer,
      agentId: 'myra',
      maxContextTokens: 160000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Session Restoration on Startup', () => {
    it('should restore Claude session from database on initialize', async () => {
      // Mock: DB returns an active session with claude_session_id
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { claude_session_id: 'restored-session-xyz' },
        error: null,
      });

      await sessionHost.initialize();

      // Should have queried sessions table
      expect(mockQueryBuilder.from).toHaveBeenCalledWith('sessions');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('agent_id', 'myra');

      // Should have called resumeSession on backend manager
      expect(mockBackendManager.resumeSession).toHaveBeenCalledWith('restored-session-xyz');
    });

    it('should not restore when no active session exists', async () => {
      // Mock: DB returns no session
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });

      await sessionHost.initialize();

      // Should NOT call resumeSession
      expect(mockBackendManager.resumeSession).not.toHaveBeenCalled();
    });

    it('should not restore when session has no claude_session_id', async () => {
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { claude_session_id: null },
        error: null,
      });

      await sessionHost.initialize();

      expect(mockBackendManager.resumeSession).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully during restoration', async () => {
      mockQueryBuilder.single.mockRejectedValueOnce(new Error('Connection refused'));

      // Should not throw — initialization should continue
      await expect(sessionHost.initialize()).resolves.toBeUndefined();

      // Backend should still be initialized
      expect(mockBackendManager.initialize).toHaveBeenCalled();
    });

    it('should skip restoration when agentId is not set', async () => {
      const hostWithoutAgent = new SessionHost({
        backend: { primaryBackend: 'claude-code', backends: {} },
        dataComposer: mockDataComposer,
      });

      await hostWithoutAgent.initialize();

      // Should not query the database at all
      expect(mockQueryBuilder.from).not.toHaveBeenCalled();
    });
  });

  describe('Session Persistence', () => {
    it('should persist claude_session_id when session:captured fires', async () => {
      await sessionHost.initialize();

      // Mock: DB finds an active PCP session
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'pcp-session-uuid' },
        error: null,
      });

      // Simulate backend capturing a session
      mockBackendManager.emit('session:captured', 'claude-sess-new-123');

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockQueryBuilder.update).toHaveBeenCalledWith({
          claude_session_id: 'claude-sess-new-123',
          status: 'active',
        });
      });
    });

    it('should not crash when no active PCP session exists to update', async () => {
      await sessionHost.initialize();

      // Mock: no active session found
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });

      // Should not throw
      mockBackendManager.emit('session:captured', 'claude-orphan-sess');

      // Wait for async handler to complete without error
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should handle DB errors gracefully during persistence', async () => {
      await sessionHost.initialize();

      mockQueryBuilder.single.mockRejectedValueOnce(new Error('DB timeout'));

      // Should not throw
      mockBackendManager.emit('session:captured', 'claude-fail-sess');

      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('Context Window Rotation', () => {
    it('should hard-rotate session when input tokens exceed hardRotationThreshold', async () => {
      // Default: hardRotationThreshold = 85% of 160k = 136000
      await sessionHost.initialize();

      // Mock: DB finds session to mark as completed
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'session-to-rotate' },
        error: null,
      });

      // Emit usage that exceeds the hard rotation threshold (136000)
      mockBackendManager.emit('session:usage', {
        inputTokens: 140000,
        outputTokens: 40000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        // Should mark session as completed
        expect(mockQueryBuilder.update).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed' })
        );
        // Should clear session on backend
        expect(mockBackendManager.clearSession).toHaveBeenCalled();
      });
    });

    it('should NOT rotate when tokens are below compaction threshold', async () => {
      await sessionHost.initialize();

      // 50k is well below the compaction threshold (75% of 160k = 120k)
      mockBackendManager.emit('session:usage', {
        inputTokens: 50000,
        outputTokens: 10000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockBackendManager.clearSession).not.toHaveBeenCalled();
      expect(mockBackendManager.sendMessage).not.toHaveBeenCalled();
    });

    it('should emit session:rotated event when rotation occurs', async () => {
      await sessionHost.initialize();

      const rotated: unknown[] = [];
      sessionHost.on('session:rotated', (data) => rotated.push(data));

      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'rotating-session' },
        error: null,
      });

      // Exceed hard rotation threshold
      mockBackendManager.emit('session:usage', {
        inputTokens: 200000,
        outputTokens: 50000,
        messageInputTokens: 10000,
        messageOutputTokens: 2000,
      });

      await vi.waitFor(() => {
        expect(rotated.length).toBe(1);
        expect(rotated[0]).toEqual({ agentId: 'myra' });
      });
    });

    it('should respect custom maxContextTokens config', async () => {
      const customHost = new SessionHost({
        backend: { primaryBackend: 'claude-code', backends: {} },
        dataComposer: mockDataComposer,
        agentId: 'myra',
        maxContextTokens: 50000, // Lower threshold — hard rotation at 42500
      });

      await customHost.initialize();

      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'custom-session' },
        error: null,
      });

      // 45k tokens should trigger hard rotation with 50k max (85% = 42.5k)
      mockBackendManager.emit('session:usage', {
        inputTokens: 45000,
        outputTokens: 10000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        expect(mockBackendManager.clearSession).toHaveBeenCalled();
      });
    });
  });

  describe('Graceful Compaction', () => {
    it('should send compaction message when tokens reach 75% of max', async () => {
      // Default: compactionThreshold = 75% of 160k = 120000
      await sessionHost.initialize();

      // Mock: sendMessage resolves (compaction succeeds)
      mockBackendManager.sendMessage.mockResolvedValueOnce(undefined);
      // Mock: DB session for rotation after compaction
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'compaction-session' },
        error: null,
      });

      // 125k tokens — above compaction (120k) but below hard rotation (136k)
      mockBackendManager.emit('session:usage', {
        inputTokens: 125000,
        outputTokens: 30000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        // Should send a compaction message to the agent
        expect(mockBackendManager.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: 'agent',
            metadata: expect.objectContaining({ isInternal: true, isCompaction: true }),
          })
        );
        // Should rotate after compaction
        expect(mockBackendManager.clearSession).toHaveBeenCalled();
      });
    });

    it('should emit compaction events during the compaction lifecycle', async () => {
      await sessionHost.initialize();

      const events: string[] = [];
      sessionHost.on('session:compactionStarted', () => events.push('started'));
      sessionHost.on('session:compactionComplete', () => events.push('complete'));
      sessionHost.on('session:rotated', () => events.push('rotated'));

      mockBackendManager.sendMessage.mockResolvedValueOnce(undefined);
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'event-session' },
        error: null,
      });

      mockBackendManager.emit('session:usage', {
        inputTokens: 125000,
        outputTokens: 30000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        expect(events).toEqual(['started', 'complete', 'rotated']);
      });
    });

    it('should still rotate when compaction fails', async () => {
      await sessionHost.initialize();

      const events: string[] = [];
      sessionHost.on('session:compactionFailed', () => events.push('failed'));
      sessionHost.on('session:rotated', () => events.push('rotated'));

      // Compaction fails
      mockBackendManager.sendMessage.mockRejectedValueOnce(new Error('Backend timeout'));
      // DB session for rotation
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'fail-session' },
        error: null,
      });

      mockBackendManager.emit('session:usage', {
        inputTokens: 125000,
        outputTokens: 30000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        expect(events).toEqual(['failed', 'rotated']);
        expect(mockBackendManager.clearSession).toHaveBeenCalled();
      });
    });

    it('should not re-trigger compaction when compactionInProgress', async () => {
      await sessionHost.initialize();

      // First compaction: make sendMessage hang (never resolves during this test)
      let resolveCompaction: () => void;
      const compactionPromise = new Promise<void>((resolve) => {
        resolveCompaction = resolve;
      });
      mockBackendManager.sendMessage.mockReturnValueOnce(compactionPromise);

      // First usage event triggers compaction
      mockBackendManager.emit('session:usage', {
        inputTokens: 125000,
        outputTokens: 30000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      // Wait a tick to let the handler start
      await new Promise((r) => setTimeout(r, 5));

      // Second usage event while compaction is in progress — should be skipped
      mockBackendManager.emit('session:usage', {
        inputTokens: 130000,
        outputTokens: 32000,
        messageInputTokens: 5000,
        messageOutputTokens: 2000,
      });

      await new Promise((r) => setTimeout(r, 5));

      // sendMessage should only be called once (from the first event)
      expect(mockBackendManager.sendMessage).toHaveBeenCalledTimes(1);

      // Clean up: resolve the compaction
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'cleanup-session' },
        error: null,
      });
      resolveCompaction!();
    });

    it('should respect custom compaction and hard rotation thresholds', async () => {
      const customHost = new SessionHost({
        backend: { primaryBackend: 'claude-code', backends: {} },
        dataComposer: mockDataComposer,
        agentId: 'myra',
        maxContextTokens: 100000,
        compactionThreshold: 60000, // Custom: 60%
        hardRotationThreshold: 80000, // Custom: 80%
      });

      await customHost.initialize();

      mockBackendManager.sendMessage.mockResolvedValueOnce(undefined);
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'custom-session' },
        error: null,
      });

      // 65k tokens — above custom compaction (60k) but below hard rotation (80k)
      mockBackendManager.emit('session:usage', {
        inputTokens: 65000,
        outputTokens: 15000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        expect(mockBackendManager.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ isCompaction: true }),
          })
        );
      });
    });

    it('should include compaction prompt content in the message', async () => {
      await sessionHost.initialize();

      mockBackendManager.sendMessage.mockResolvedValueOnce(undefined);
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'prompt-session' },
        error: null,
      });

      mockBackendManager.emit('session:usage', {
        inputTokens: 125000,
        outputTokens: 30000,
        messageInputTokens: 5000,
        messageOutputTokens: 1000,
      });

      await vi.waitFor(() => {
        const call = mockBackendManager.sendMessage.mock.calls[0][0];
        expect(call.content).toContain('SESSION COMPACTION REQUEST');
        expect(call.content).toContain('compact_session');
        expect(call.content).toContain('remember');
        expect(call.content).toContain('create_task');
      });
    });
  });

  describe('Session Resumption E2E Flow', () => {
    it('should persist session ID then restore it after simulated restart', async () => {
      // === Phase 1: First boot, receive a session ===
      await sessionHost.initialize();

      // Session captured from Claude Code
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { id: 'pcp-session-1' },
        error: null,
      });

      mockBackendManager.emit('session:captured', 'claude-sess-original');

      await vi.waitFor(() => {
        expect(mockQueryBuilder.update).toHaveBeenCalledWith({
          claude_session_id: 'claude-sess-original',
          status: 'active',
        });
      });

      // === Phase 2: Simulate restart — create a new SessionHost ===
      vi.clearAllMocks();
      mockBackendManager.removeAllListeners();

      const restartedHost = new SessionHost({
        backend: { primaryBackend: 'claude-code', backends: {} },
        dataComposer: mockDataComposer,
        agentId: 'myra',
      });

      // Mock: DB returns the persisted session
      mockQueryBuilder.single.mockResolvedValueOnce({
        data: { claude_session_id: 'claude-sess-original' },
        error: null,
      });

      await restartedHost.initialize();

      // Should have resumed with the original session ID
      expect(mockBackendManager.resumeSession).toHaveBeenCalledWith('claude-sess-original');
    });
  });
});
