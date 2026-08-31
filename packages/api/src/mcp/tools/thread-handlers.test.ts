/**
 * Thread Handler Tests
 *
 * Tests for group thread messaging: trigger resolution, validation,
 * thread lifecycle, and participant management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTriggeredAgents, resolveEffectiveFloor, isLaterInstant } from './thread-handlers';

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

    it('should trigger all others when creator replies with a plain message', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        messageType: 'message',
      });
      expect(result).toEqual(['lumen', 'aster', 'myra']);
    });

    it('should trigger all others when creator replies with no messageType (default)', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
      });
      expect(result).toEqual(['lumen', 'aster', 'myra']);
    });

    it('should trigger only explicit recipient when creator targets one person', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        recipients: ['myra'],
      });
      expect(result).toEqual(['myra']);
    });

    it('should trigger only explicit recipient when non-creator targets one person', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'lumen',
        participants,
        creatorAgentId: 'wren',
        recipients: ['myra'],
      });
      expect(result).toEqual(['myra']);
    });

    it('should trigger no one when creator explicitly targets self (same studio)', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        recipients: ['wren'],
      });
      expect(result).toEqual([]);
    });

    it('should trigger no one when non-creator explicitly targets self (same studio)', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'lumen',
        participants,
        creatorAgentId: 'wren',
        recipients: ['lumen'],
      });
      expect(result).toEqual([]);
    });

    it('should trigger self when explicitly targeting self with selfStudioTarget', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        recipients: ['wren'],
        selfStudioTarget: true,
      });
      expect(result).toEqual(['wren']);
    });

    it('should filter explicit recipients to actual participants', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        recipients: ['myra', 'benson'],
      });
      expect(result).toEqual(['myra']);
    });
  });

  describe('actionable message types in group threads', () => {
    const participants = ['wren', 'lumen', 'aster', 'myra'];

    it('should trigger recipients when creator sends task_request', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        messageType: 'task_request',
        recipients: ['lumen'],
      });
      expect(result).toEqual(['lumen']);
    });

    it('should trigger all other participants when creator sends task_request without explicit recipients', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        messageType: 'task_request',
      });
      expect(result).toEqual(['lumen', 'aster', 'myra']);
    });

    it('should trigger recipients when creator sends session_resume', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants,
        creatorAgentId: 'wren',
        messageType: 'session_resume',
        recipients: ['aster'],
      });
      expect(result).toEqual(['aster']);
    });

    it('should filter recipients to actual participants only', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        messageType: 'task_request',
        recipients: ['lumen', 'aster'], // aster is not a participant
      });
      expect(result).toEqual(['lumen']);
    });
  });

  describe('self-thread (1 participant)', () => {
    it('should trigger no one for plain messages', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
      });
      expect(result).toEqual([]);
    });

    it('should trigger self for session_resume (strategy self-trigger)', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
        messageType: 'session_resume',
      });
      expect(result).toEqual(['wren']);
    });

    it('should trigger self for task_request', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
        messageType: 'task_request',
      });
      expect(result).toEqual(['wren']);
    });

    it('should not trigger self for notification', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
        messageType: 'notification',
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

  describe('cross-studio self-messaging (selfStudioTarget)', () => {
    it('should trigger sender on self-thread when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
        selfStudioTarget: true,
      });
      expect(result).toEqual(['wren']);
    });

    it('should NOT trigger sender on self-thread when selfStudioTarget is false', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren'],
        creatorAgentId: 'wren',
        selfStudioTarget: false,
      });
      expect(result).toEqual([]);
    });

    it('should include sender in triggerAll when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        triggerAll: true,
        selfStudioTarget: true,
      });
      expect(result).toEqual(['wren', 'lumen']);
    });

    it('should include sender in explicit triggerAgents when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        triggerAgents: ['wren'],
        selfStudioTarget: true,
      });
      expect(result).toEqual(['wren']);
    });

    it('should still exclude sender from explicit triggerAgents without selfStudioTarget', () => {
      const result = resolveTriggeredAgents({
        senderAgentId: 'wren',
        participants: ['wren', 'lumen'],
        creatorAgentId: 'wren',
        triggerAgents: ['wren'],
      });
      expect(result).toEqual([]);
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
    // Synchronous assignment dispatch (spec §3a) — a missing/failed
    // processTrigger now surfaces as routingFailures (round 2), so the mock
    // must report success for happy-path routing tests.
    processTrigger: vi.fn().mockResolvedValue({
      success: true,
      triggerId: 'trigger-sync-1',
      processed: true,
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
  getRequestContext: vi.fn().mockReturnValue({ sessionId: 'session-mock-123' }),
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

  it('should reject recipients[] with recipientStudioSlug', async () => {
    const mockDc = createMockDataComposer();
    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          recipients: ['lumen'],
          threadKey: 'pr:32',
          recipientStudioSlug: 'wren-review',
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

  it('should surface recipientStudioSlug in the legacy-path response', async () => {
    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        recipientStudioSlug: 'wren-review',
        content: 'Direct slug-routed message',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.recipientStudioSlug).toBe('wren-review');
  });

  it('should treat legacy recipientStudioHint="main" as a slug alias', async () => {
    const mockSb = createThreadMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        recipientStudioHint: 'main',
        content: 'Legacy hint caller',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.recipientStudioSlug).toBe('main');
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

// =====================================================
// get_thread_messages — cold-start guard (spec inkmail-read-state §4)
// =====================================================

import { handleGetThreadMessages, handleMarkThreadRead } from './thread-handlers';

vi.mock('./read-state.js', () => ({
  advanceThreadReadPointer: vi.fn().mockResolvedValue({ success: true }),
}));

interface GuardMsg {
  id: string;
  created_at: string;
  message_type: string;
  sender_agent_id: string;
  content: string;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function guardMsg(id: string, ageHours: number): GuardMsg {
  return {
    id,
    created_at: hoursAgo(ageHours),
    message_type: 'message',
    sender_agent_id: 'lumen',
    content: `msg ${id}`,
  };
}

/**
 * In-memory query engine over a message table so window math (gt/lt floors,
 * DESC truncation, head counts) is actually exercised, not stubbed.
 */
function createGuardMockSupabase(
  rows: GuardMsg[],
  opts: { lastReadAt?: string | null; joinedAt?: string | null } = {}
) {
  const messagesChain = () => {
    const state = {
      gts: [] as string[],
      lts: [] as string[],
      neqType: null as string | null,
      idEq: null as string | null,
      asc: true,
      limit: null as number | null,
      head: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = {};
    self.select = vi.fn((_sel: string, o?: { head?: boolean }) => {
      state.head = !!o?.head;
      return self;
    });
    self.eq = vi.fn((col: string, val: string) => {
      if (col === 'id') state.idEq = val;
      return self;
    });
    self.neq = vi.fn((col: string, val: string) => {
      if (col === 'message_type') state.neqType = val;
      return self;
    });
    self.gt = vi.fn((_col: string, val: string) => {
      state.gts.push(val);
      return self;
    });
    self.lt = vi.fn((_col: string, val: string) => {
      state.lts.push(val);
      return self;
    });
    self.order = vi.fn((_col: string, o?: { ascending?: boolean }) => {
      state.asc = o?.ascending !== false;
      return self;
    });
    self.limit = vi.fn((n: number) => {
      state.limit = n;
      return self;
    });
    const compute = () => {
      let out = rows.filter(
        (r) =>
          state.gts.every((g) => r.created_at > g) &&
          state.lts.every((l) => r.created_at < l) &&
          (state.neqType === null || r.message_type !== state.neqType)
      );
      out = out.sort((a, b) =>
        state.asc
          ? a.created_at.localeCompare(b.created_at)
          : b.created_at.localeCompare(a.created_at)
      );
      const count = out.length;
      if (state.limit !== null) out = out.slice(0, state.limit);
      return { data: state.head ? null : out, error: null, count };
    };
    self.single = vi.fn(() => {
      const row = rows.find((r) => r.id === state.idEq);
      return Promise.resolve({ data: row || null, error: null });
    });
    self.maybeSingle = vi.fn(() => {
      if (state.idEq) {
        const row = rows.find((r) => r.id === state.idEq);
        return Promise.resolve({ data: row || null, error: null });
      }
      const { data } = compute();
      return Promise.resolve({ data: data && data.length ? data[0] : null, error: null });
    });
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(compute()).then(resolve);
    return self;
  };

  const simpleRow = (data: unknown) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
        }),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
      }),
    }),
  });

  const fromFn = vi.fn().mockImplementation((table: string) => {
    switch (table) {
      case 'inbox_threads':
        return simpleRow({
          id: 't-guard',
          thread_key: 'pr:guard',
          title: null,
          status: 'open',
          created_by_agent_id: 'lumen',
        });
      case 'inbox_thread_participants':
        return simpleRow({
          agent_id: 'wren',
          joined_at: opts.joinedAt === undefined ? hoursAgo(24 * 120) : opts.joinedAt,
        });
      case 'inbox_thread_read_status':
        return simpleRow(
          opts.lastReadAt === undefined || opts.lastReadAt === null
            ? null
            : { last_read_at: opts.lastReadAt }
        );
      case 'inbox_thread_messages':
        return messagesChain();
      default:
        return simpleRow(null);
    }
  });

  return { from: fromFn, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

function guardComposer(sb: ReturnType<typeof createGuardMockSupabase>) {
  return { getClient: vi.fn().mockReturnValue(sb) } as never;
}

async function callGuard(
  sb: ReturnType<typeof createGuardMockSupabase>,
  extra: Record<string, unknown> = {}
) {
  const result = await handleGetThreadMessages(
    { email: 'test@test.com', agentId: 'wren', threadKey: 'pr:guard', ...extra },
    guardComposer(sb)
  );
  return JSON.parse(result.content[0].text);
}

describe('handleGetThreadMessages — cold-start guard (spec §4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bounds a stale-pointer delivery poll to the 48h window, newest-first, skips visible', async () => {
    // 40 old (ages 100h+) + 20 recent (1–40h). Participant joined 120 days
    // ago, never read — the July 30 shape. Without the guard this replays 60.
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => guardMsg(`old-${i}`, 100 + i * 10)),
      ...Array.from({ length: 20 }, (_, i) => guardMsg(`new-${i}`, 1 + i * 2)),
    ];
    const parsed = await callGuard(createGuardMockSupabase(rows), { channelPoll: true });
    expect(parsed.success).toBe(true);
    expect(parsed.coldStartGuard).toBe(true);
    expect(parsed.messageCount).toBe(20);
    expect(parsed.skippedOlderCount).toBe(40);
    const ids = (parsed.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids.every((id) => id.startsWith('new-'))).toBe(true);
    // Response ordering stays oldest-first
    const times = (parsed.messages as Array<{ createdAt: string }>).map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('floor: delivers the newest 10 unseen when the 48h window is emptier than that', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => guardMsg(`old-${i}`, 50 + i * 10));
    const parsed = await callGuard(createGuardMockSupabase(rows), { channelPoll: true });
    expect(parsed.messageCount).toBe(10);
    expect(parsed.skippedOlderCount).toBe(20);
    // The newest 10 (smallest ages), not the earliest
    const ids = (parsed.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('old-0');
    expect(ids).not.toContain('old-29');
  });

  it('explicit afterMessageId bypasses the guard entirely', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => guardMsg(`m-${i}`, 200 - i * 10));
    const parsed = await callGuard(createGuardMockSupabase(rows), {
      channelPoll: true,
      afterMessageId: '11111111-1111-1111-1111-111111111111',
    });
    // Cursor id not found → no floor from it; guard must NOT kick in.
    expect(parsed.coldStartGuard).toBeUndefined();
    expect(parsed.skippedOlderCount).toBeUndefined();
    expect(parsed.messageCount).toBe(15);
  });

  it('fullHistory bypasses the guard', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => guardMsg(`m-${i}`, 100 + i * 20));
    const parsed = await callGuard(createGuardMockSupabase(rows), {
      channelPoll: true,
      fullHistory: true,
    });
    expect(parsed.coldStartGuard).toBeUndefined();
    expect(parsed.messageCount).toBe(25);
  });

  it('latestN returns the newest N with visible skip accounting (no channelPoll)', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => guardMsg(`m-${i}`, 1 + i));
    const parsed = await callGuard(createGuardMockSupabase(rows, { joinedAt: null }), {
      latestN: 5,
    });
    expect(parsed.messageCount).toBe(5);
    expect(parsed.skippedOlderCount).toBe(15);
    const ids = (parsed.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['m-4', 'm-3', 'm-2', 'm-1', 'm-0']);
  });

  it('guard mode advances ONLY through the newest deliberately-skipped message — never the batch', async () => {
    // 15 old (100h+) + 5 recent: window delivers 5, floor tops up to the
    // newest 10 (5 recent + 5 newest-old), skipping the 10 oldest. The
    // pointer must advance through the newest SKIPPED message — the
    // delivered batch stays unread until the consumer acks (Lumen §1).
    const { advanceThreadReadPointer } = await import('./read-state.js');
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => guardMsg(`old-${i}`, 100 + i * 10)),
      ...Array.from({ length: 5 }, (_, i) => guardMsg(`new-${i}`, 1 + i)),
    ];
    const parsed = await callGuard(createGuardMockSupabase(rows), {
      channelPoll: true,
      markRead: true,
    });
    expect(parsed.messageCount).toBe(10);
    expect(parsed.skippedOlderCount).toBe(10);
    // Newest skipped = old-4 is delivered (ages 100..140 in the top-10);
    // the newest NOT delivered is old-5 (age 150).
    expect(vi.mocked(advanceThreadReadPointer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(advanceThreadReadPointer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        throughMessageId: 'old-5',
        source: 'get_thread_messages:deliberate_skip',
      })
    );
  });

  it('guard mode with zero skips advances nothing (batch awaits consumer ack)', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    const rows = [guardMsg('a', 5), guardMsg('b', 1)];
    await callGuard(createGuardMockSupabase(rows), { channelPoll: true, markRead: true });
    expect(vi.mocked(advanceThreadReadPointer)).not.toHaveBeenCalled();
  });

  it('non-guard markRead keeps the pre-existing batch advance', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    const rows = [guardMsg('older', 30), guardMsg('newest', 1)];
    await callGuard(createGuardMockSupabase(rows, { joinedAt: null }), { markRead: true });
    expect(vi.mocked(advanceThreadReadPointer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        throughMessageId: 'newest',
        source: 'get_thread_messages:markRead',
      })
    );
  });

  it('mark_thread_read with throughMessageId acks EXACTLY that message', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    const rows = [guardMsg('m-1', 3), guardMsg('m-2', 2), guardMsg('m-3', 1)];
    const sb = createGuardMockSupabase(rows);
    const result = await handleMarkThreadRead(
      {
        email: 'test@test.com',
        agentId: 'wren',
        threadKey: 'pr:guard',
        throughMessageId: '00000000-0000-0000-0000-000000000000',
      },
      guardComposer(sb)
    );
    // UUID not in the thread → refused, no advance.
    expect(JSON.parse(result.content[0].text).success).toBe(false);
    expect(vi.mocked(advanceThreadReadPointer)).not.toHaveBeenCalled();
  });

  it('mark_thread_read acks a real message id and advances exactly through it', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    const ackId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const rows = [guardMsg(ackId, 3), guardMsg('m-newer', 1)];
    const sb = createGuardMockSupabase(rows);
    const result = await handleMarkThreadRead(
      { email: 'test@test.com', agentId: 'wren', threadKey: 'pr:guard', throughMessageId: ackId },
      guardComposer(sb)
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.throughMessageId).toBe(ackId);
    // Advanced exactly through the acked message — NOT the thread's newest.
    expect(vi.mocked(advanceThreadReadPointer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(advanceThreadReadPointer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ throughMessageId: ackId, source: 'mark_thread_read:ack' })
    );
  });

  it('surfaces a failed deliberate_skip advance in the response (checked write, round 3)', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    vi.mocked(advanceThreadReadPointer).mockResolvedValueOnce(false as never);
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => guardMsg(`old-${i}`, 100 + i * 10)),
      ...Array.from({ length: 5 }, (_, i) => guardMsg(`new-${i}`, 1 + i)),
    ];
    const parsed = await callGuard(createGuardMockSupabase(rows), {
      channelPoll: true,
      markRead: true,
    });
    expect(parsed.success).toBe(true); // messages WERE returned
    expect(parsed.advanceFailed).toBe(true);
    expect(parsed.warning).toContain('read-pointer advance failed');
  });

  it('surfaces a failed non-guard markRead advance in the response (checked write, round 3)', async () => {
    const { advanceThreadReadPointer } = await import('./read-state.js');
    vi.mocked(advanceThreadReadPointer).mockResolvedValueOnce(false as never);
    const rows = [guardMsg('m-1', 2), guardMsg('m-2', 1)];
    const parsed = await callGuard(createGuardMockSupabase(rows, { joinedAt: null }), {
      markRead: true,
    });
    expect(parsed.advanceFailed).toBe(true);
    expect(parsed.warning).toContain('read-pointer advance failed');
  });

  it('no truncation → no skippedOlderCount field, delivery unchanged', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => guardMsg(`m-${i}`, 1 + i));
    const parsed = await callGuard(createGuardMockSupabase(rows), { channelPoll: true });
    expect(parsed.messageCount).toBe(5);
    expect(parsed.skippedOlderCount).toBeUndefined();
    expect(parsed.coldStartGuard).toBe(true);
  });
});

/**
 * Lumen's blocker on PR #554.
 *
 * Widening the schemas to accept offsets exposed a floor comparison that was
 * lexicographic on timestamp strings. It had always been correct in practice
 * because every timestamp reaching it was UTC, so text order matched time
 * order — an accident of spelling, not a property of the code.
 *
 * My "widening only" claim was true of the validator and false of the system:
 * I checked Zod against Zod and never asked what the consumers assumed.
 */
describe('read floors compare instants, not spellings', () => {
  const readFloor = '2026-09-01T12:00:00Z';

  it('does not lower the floor for an offset time that only LOOKS later', () => {
    // 23:00+14:00 is 09:00Z — three hours BEFORE the floor — but sorts after
    // it as text. Taking it would replay messages the caller already read.
    const floor = resolveEffectiveFloor({
      readStateFloor: readFloor,
      afterTs: null,
      newerThan: '2026-09-01T23:00:00+14:00',
    });

    expect(floor).toBe(readFloor);
  });

  it('does raise the floor for an offset time that genuinely is later', () => {
    // 08:00-05:00 is 13:00Z, an hour after the floor.
    const later = '2026-09-01T08:00:00-05:00';
    const floor = resolveEffectiveFloor({
      readStateFloor: readFloor,
      afterTs: null,
      newerThan: later,
    });

    expect(floor).toBe(later);
  });

  it('picks the latest instant across all three sources', () => {
    expect(
      resolveEffectiveFloor({
        readStateFloor: '2026-09-01T12:00:00Z',
        afterTs: '2026-09-01T09:00:00-04:00', // 13:00Z — the winner
        newerThan: '2026-09-01T23:00:00+14:00', // 09:00Z
      })
    ).toBe('2026-09-01T09:00:00-04:00');
  });

  it('keeps the existing floor when a value cannot be parsed', () => {
    // Too high under-delivers and is visible; too low silently replays.
    expect(
      resolveEffectiveFloor({
        readStateFloor: readFloor,
        afterTs: null,
        newerThan: 'not a timestamp',
      })
    ).toBe(readFloor);
  });

  it('accepts the Postgres +00:00 spelling as equal to Z', () => {
    // Both forms reach these floors today: toISOString() gives Z, Supabase
    // gives +00:00. Neither should displace the other.
    expect(isLaterInstant('2026-09-01T12:00:00+00:00', '2026-09-01T12:00:00Z')).toBe(false);
    expect(isLaterInstant('2026-09-01T12:00:00Z', '2026-09-01T12:00:00+00:00')).toBe(false);
  });

  it('takes any real value over a missing floor', () => {
    expect(
      resolveEffectiveFloor({ readStateFloor: null, afterTs: null, newerThan: readFloor })
    ).toBe(readFloor);
    expect(resolveEffectiveFloor({ readStateFloor: null, afterTs: null, newerThan: null })).toBe(
      null
    );
  });
});
