/**
 * Thread Handler Tests
 *
 * Tests for group thread messaging: trigger resolution, validation,
 * thread lifecycle, and participant management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =====================================================
// UNIT TESTS: resolveTriggeredAgents (pure logic)
// =====================================================

// Import the function indirectly by testing through the handler,
// but since it's not exported, we test the logic via reply_to_thread behavior.
// For now, we replicate the logic here for direct unit testing.

function resolveTriggeredAgents(opts: {
  senderAgentId: string;
  participants: string[];
  creatorAgentId: string;
  triggerAgents?: string[];
  triggerAll?: boolean;
}): string[] {
  const { senderAgentId, participants, creatorAgentId, triggerAgents, triggerAll } = opts;

  if (triggerAgents && triggerAgents.length > 0) {
    const participantSet = new Set(participants);
    return triggerAgents.filter((a) => a !== senderAgentId && participantSet.has(a));
  }

  if (triggerAll) {
    return participants.filter((a) => a !== senderAgentId);
  }

  const otherParticipants = participants.filter((a) => a !== senderAgentId);

  if (otherParticipants.length === 0) {
    return [];
  }

  if (participants.length === 2) {
    return otherParticipants;
  }

  if (senderAgentId !== creatorAgentId) {
    return [creatorAgentId];
  }

  return [];
}

describe('resolveTriggeredAgents', () => {
  describe('1:1 threads (2 participants)', () => {
    it('should trigger the other participant', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
      });
      expect(result).toEqual(['lumen']);
    });

    it('should trigger creator when non-creator replies in 1:1', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'lumen',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
      });
      expect(result).toEqual(['wren']);
    });
  });

  describe('group threads (3+ participants)', () => {
    const participants = ['wren', 'lumen', 'aster', 'myra'];

    it('should trigger creator only when non-creator replies', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'lumen',
        participants,
        creatorAgentId: 'wren',
      });
      expect(result).toEqual(['wren']);
    });

    it('should trigger no one when creator replies', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
      });
      expect(result).toEqual([]);
    });
  });

  describe('self-thread (1 participant)', () => {
    it('should trigger no one', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
      });
      expect(result).toEqual([]);
    });
  });

  describe('triggerAll override', () => {
    it('should trigger all participants except sender', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen', 'aster', 'myra'],
        creatorAgentId: 'wren',
        triggerAll: true,
      });
      expect(result).toEqual(['lumen', 'aster', 'myra']);
    });

    it('should work in 1:1 threads', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        triggerAll: true,
      });
      expect(result).toEqual(['lumen']);
    });
  });

  describe('triggerAgents override', () => {
    it('should trigger only specified participants', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen', 'aster', 'myra'],
        creatorAgentId: 'wren',
        triggerAgents: ['lumen'],
      });
      expect(result).toEqual(['lumen']);
    });

    it('should silently ignore non-participants', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        triggerAgents: ['aster', 'lumen'],
      });
      expect(result).toEqual(['lumen']);
    });

    it('should not trigger the sender even if listed', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen', 'aster'],
        creatorAgentId: 'wren',
        triggerAgents: ['wren', 'lumen'],
      });
      expect(result).toEqual(['lumen']);
    });

    it('should take precedence over triggerAll', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen', 'aster', 'myra'],
        creatorAgentId: 'wren',
        triggerAgents: ['aster'],
        triggerAll: true,
      });
      // triggerAgents takes precedence (spec: triggerAgents > triggerAll > default)
      expect(result).toEqual(['aster']);
    });
  });
});

// =====================================================
// VALIDATION TESTS: send_to_inbox schema enforcement
// =====================================================

// Mock dependencies for handler tests
vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: 'user-123' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../channels/agent-gateway.js', () => ({
  getAgentGateway: vi.fn().mockReturnValue({
    dispatchTrigger: vi.fn().mockReturnValue({
      success: true,
      triggerId: 'trigger-1',
      processed: false,
      accepted: true,
    }),
  }),
}));

vi.mock('../../auth/enforce-identity', () => ({
  getEffectiveAgentId: vi.fn((id?: string) => id || null),
}));

vi.mock('../../auth/resolve-identity', () => ({
  resolveIdentityId: vi.fn().mockResolvedValue('identity-uuid'),
}));

vi.mock('../../utils/request-context', () => ({
  getRequestContext: vi.fn().mockReturnValue(null),
  getSessionContext: vi.fn().mockReturnValue(null),
}));

import { handleSendToInbox } from './inbox-handlers';

function createThreadMockSupabase() {
  const threadMessage = {
    id: 'tmsg-123',
    thread_id: 'thread-123',
    sender_agent_id: 'wren',
    content: 'test',
    message_type: 'message',
    priority: 'normal',
    metadata: {},
    created_at: '2026-03-09T10:00:00Z',
  };

  const threadRow = {
    id: 'thread-123',
    thread_key: 'pr:32',
    user_id: 'user-123',
    created_by_agent_id: 'wren',
    title: null,
    status: 'open',
    metadata: {},
    created_at: '2026-03-09T10:00:00Z',
    updated_at: '2026-03-09T10:00:00Z',
  };

  // Build chainable mock that handles all PostgREST patterns
  const makeChainable = (resolveValue: unknown = { data: null, error: null }) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = () => chain;
    chain.select = vi.fn().mockReturnValue(self());
    chain.insert = vi.fn().mockReturnValue(self());
    chain.update = vi.fn().mockReturnValue(self());
    chain.upsert = vi.fn().mockReturnValue(self());
    chain.eq = vi.fn().mockReturnValue(self());
    chain.neq = vi.fn().mockReturnValue(self());
    chain.gt = vi.fn().mockReturnValue(self());
    chain.lt = vi.fn().mockReturnValue(self());
    chain.in = vi.fn().mockReturnValue(self());
    chain.or = vi.fn().mockReturnValue(self());
    chain.order = vi.fn().mockReturnValue(self());
    chain.limit = vi.fn().mockReturnValue(self());
    chain.single = vi.fn().mockResolvedValue(resolveValue);
    chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
    // Make the chain itself thenable so `await chain` works
    chain.then = vi
      .fn()
      .mockImplementation((resolve: (v: unknown) => void) => resolve(resolveValue));
    return chain;
  };

  const tables: Record<string, ReturnType<typeof makeChainable>> = {};

  const getTable = (name: string) => {
    if (!tables[name]) {
      if (name === 'inbox_threads') {
        // First call: maybeSingle returns null (thread doesn't exist)
        // Second call (after insert): returns the thread
        const findChain = makeChainable({ data: null, error: null });
        const insertChain = makeChainable({ data: threadRow, error: null });
        let callCount = 0;
        tables[name] = makeChainable({ data: null, error: null });
        tables[name].select = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return findChain;
          return makeChainable({ data: threadRow, error: null });
        });
        tables[name].insert = vi.fn().mockReturnValue(insertChain);
        tables[name].update = vi.fn().mockReturnValue(makeChainable({ data: null, error: null }));
      } else if (name === 'inbox_thread_messages') {
        tables[name] = makeChainable({ data: threadMessage, error: null });
      } else if (name === 'inbox_thread_participants') {
        // maybeSingle returns null (participant doesn't exist yet)
        tables[name] = makeChainable({ data: null, error: null });
      } else if (name === 'inbox_thread_read_status') {
        tables[name] = makeChainable({ data: null, error: null });
      } else if (name === 'agent_inbox') {
        tables[name] = makeChainable({
          data: {
            id: 'inbox-msg-123',
            user_id: 'user-123',
            recipient_agent_id: 'lumen',
            sender_agent_id: 'wren',
            content: 'Simple message',
            message_type: 'message',
            priority: 'normal',
            status: 'unread',
            metadata: {},
            created_at: '2026-03-09T10:00:00Z',
          },
          error: null,
        });
      } else if (name === 'agent_identities') {
        tables[name] = makeChainable({
          data: [{ id: 'identity-123' }],
          error: null,
        });
      } else {
        tables[name] = makeChainable({ data: null, error: null });
      }
    }
    return tables[name];
  };

  return {
    from: vi.fn().mockImplementation(getTable),
    _tables: tables,
    _getTable: getTable,
  };
}

function createMockDataComposer(supabase?: ReturnType<typeof createThreadMockSupabase>) {
  const sb = supabase || createThreadMockSupabase();
  return {
    getClient: vi.fn().mockReturnValue(sb),
    repositories: {},
  };
}

describe('handleSendToInbox - validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject when both recipientAgentId and recipients are provided', async () => {
    const mockDc = createMockDataComposer();
    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          recipientAgentId: 'lumen',
          recipients: ['lumen', 'aster'],
          threadKey: 'pr:32',
          content: 'test',
        },
        mockDc as never
      )
    ).rejects.toThrow('Provide exactly one of recipientAgentId or recipients');
  });

  it('should reject when neither recipientAgentId nor recipients are provided', async () => {
    const mockDc = createMockDataComposer();
    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          content: 'test',
        },
        mockDc as never
      )
    ).rejects.toThrow('Provide exactly one of recipientAgentId or recipients');
  });

  it('should reject recipients[] without threadKey', async () => {
    const mockDc = createMockDataComposer();
    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          recipients: ['lumen', 'aster'],
          content: 'test',
        },
        mockDc as never
      )
    ).rejects.toThrow('threadKey is required when using recipients[]');
  });

  it('should reject recipients[] with session/studio routing hints', async () => {
    const mockDc = createMockDataComposer();
    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          recipients: ['lumen'],
          threadKey: 'pr:32',
          recipientStudioHint: 'main',
          content: 'test',
        },
        mockDc as never
      )
    ).rejects.toThrow('only valid for single-recipient sends');
  });
});

describe('handleSendToInbox - thread routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should route to thread tables when threadKey is provided with recipientAgentId', async () => {
    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:32',
        content: 'Review PR #32',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.threadKey).toBe('pr:32');
    expect(parsed.recipients).toEqual(['lumen']);
    expect(parsed.participants).toContain('wren');
    expect(parsed.participants).toContain('lumen');
  });

  it('should route to thread tables when recipients[] is provided', async () => {
    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipients: ['lumen', 'aster'],
        senderAgentId: 'wren',
        threadKey: 'spec:group-threads',
        content: 'RFC for review',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.threadKey).toBe('spec:group-threads');
    expect(parsed.recipients).toEqual(['lumen', 'aster']);
    expect(parsed.participants).toContain('wren');
    expect(parsed.participants).toContain('lumen');
    expect(parsed.participants).toContain('aster');
  });

  it('should route to agent_inbox when no threadKey', async () => {
    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Simple message',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.threadKey).toBeNull();
    // Should have gone to agent_inbox
    expect(mockSb.from).toHaveBeenCalledWith('agent_inbox');
  });

  it('should trigger all recipients on thread creation', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipients: ['lumen', 'aster'],
        senderAgentId: 'wren',
        threadKey: 'spec:test',
        content: 'Hello team',
      },
      mockDc as never
    );

    // Should trigger lumen and aster (not wren — sender)
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledTimes(2);
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'lumen',
        threadKey: 'spec:test',
        threadMessageId: 'tmsg-123',
      })
    );
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'aster',
        threadKey: 'spec:test',
        threadMessageId: 'tmsg-123',
      })
    );
    expect(mockGateway.dispatchTrigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'user-123' })
    );
  });
});
