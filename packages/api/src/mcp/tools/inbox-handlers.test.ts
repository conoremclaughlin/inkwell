/**
 * Inbox Handler Tests - threadKey
 *
 * Tests for threadKey support in send_to_inbox and get_inbox tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSendToInbox, handleGetInbox } from './inbox-handlers';

// Mock user-resolver
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

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock agent gateway
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

function createMockSupabase(
  overrides: {
    insertReturn?: { data: unknown; error: unknown };
    selectReturn?: { data: unknown; error: unknown; count?: number };
  } = {}
) {
  const defaultMessage = {
    id: 'msg-123',
    created_at: '2026-02-15T10:00:00Z',
    thread_key: null,
    recipient_agent_id: 'lumen',
    sender_agent_id: 'wren',
    subject: 'PR review needed',
    content: 'Please review PR #32',
    message_type: 'task_request',
    priority: 'normal',
    status: 'unread',
    recipient_session_id: null,
    related_artifact_uri: null,
    metadata: {},
    read_at: null,
  };

  const insertReturn = overrides.insertReturn || { data: defaultMessage, error: null };

  const updateChainable = {
    eq: vi.fn().mockReturnThis(),
    mockResolvedValue: undefined as unknown,
  };
  // Make the last .eq() resolve
  updateChainable.eq = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  });

  const chainable = {
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue(insertReturn),
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      or: vi
        .fn()
        .mockResolvedValue(overrides.selectReturn || { data: [defaultMessage], error: null }),
    }),
    update: vi.fn().mockReturnValue(updateChainable),
  };

  // For count query
  const countChainable = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 1 }),
        }),
      }),
    }),
  };

  // For identity resolution (resolveIdentityId calls .select().eq().eq().maybeSingle())
  const identityRows = [{ id: 'identity-123', workspace_id: 'workspace-1', updated_at: null }];
  const identityChainable = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: identityRows, error: null }),
        }),
      }),
    }),
  };

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_identities') return identityChainable;
    return chainable;
  });

  return { from: fromFn, _chainable: chainable, _countChainable: countChainable };
}

function createMockDataComposer(supabase?: ReturnType<typeof createMockSupabase>) {
  const sb = supabase || createMockSupabase();
  return {
    getClient: vi.fn().mockReturnValue(sb),
    repositories: {},
  };
}

// =====================================================
// SEND TO INBOX - threadKey
// =====================================================

describe('handleSendToInbox - threadKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Note: "threadKey in DB insert" test removed — threadKey now routes to
  // inbox_thread_messages (tested in thread-handlers.test.ts), not agent_inbox.

  it('should insert null thread_key when threadKey not provided', async () => {
    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Hello',
      },
      mockDc as never
    );

    expect(mockSb._chainable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_key: null,
      })
    );
  });

  // Note: "threadKey in response" test removed — threadKey now routes to
  // thread tables (tested in thread-handlers.test.ts).

  it('should include hint when threadKey is missing', async () => {
    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Hello',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.threadKey).toBeNull();
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toContain('threadKey');
  });

  // Note: "threadKey in trigger payload" test removed — threadKey triggers
  // are now tested in thread-handlers.test.ts.

  it('should trigger by default for notification messages', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'myra',
        senderAgentId: 'wren',
        messageType: 'notification',
        content: 'FYI',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'myra',
      })
    );
  });

  it('should pass recipientSessionId through trigger payload', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        messageType: 'session_resume',
        recipientSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
        content: 'Resume this session',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      })
    );
  });

  it('should support recipientSessionId as preferred routing field', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        messageType: 'session_resume',
        recipientSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
        content: 'Resume this session',
      },
      mockDc as never
    );

    expect(mockSb._chainable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_session_id: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      })
    );
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      })
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.recipientSessionId).toBe('b85490f5-0836-4bdd-8193-f6cfa2562a41');
  });

  it('should trigger without senderAgentId using system sender', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        messageType: 'task_request',
        content: 'Human-sent coordination message',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAgentId: 'system',
      })
    );
  });

  it('should trigger by default for message type (all types trigger by default)', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        messageType: 'message',
        content: 'casual ping',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger.triggered).toBe(true);
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'lumen',
      })
    );
  });

  it('should deliver actionable handoff without anchor and return routing hint', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        messageType: 'task_request',
        content: 'Please do this work',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.routingHint).toContain('routing anchor');
    expect(mockGateway.dispatchTrigger).toHaveBeenCalled();
  });
});

describe('handleGetInbox - recipient session naming', () => {
  it('should include recipientSessionId in inbox messages', async () => {
    const message = {
      id: 'msg-123',
      created_at: '2026-02-15T10:00:00Z',
      thread_key: 'pr:99',
      recipient_agent_id: 'lumen',
      sender_agent_id: 'wren',
      subject: 'Resume work',
      content: 'Please resume',
      message_type: 'session_resume',
      priority: 'normal',
      status: 'unread',
      recipient_session_id: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      related_artifact_uri: null,
      metadata: {},
      read_at: null,
    };

    const mockSb = createMockSupabase({
      selectReturn: { data: [message], error: null },
    });
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleGetInbox(
      {
        email: 'test@test.com',
        agentId: 'lumen',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages[0].recipientSessionId).toBe('b85490f5-0836-4bdd-8193-f6cfa2562a41');
  });
});
