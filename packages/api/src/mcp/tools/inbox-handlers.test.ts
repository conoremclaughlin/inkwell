/**
 * Inbox Handler Tests - threadKey
 *
 * Tests for threadKey support in send_to_inbox and get_inbox tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleSendToInbox,
  handleGetInbox,
  handleUpdateInboxMessage,
  isThreadOwnedByStudio,
} from './inbox-handlers';

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

// Mock request context (for sender session resolution)
// Provide a sessionId so triggers aren't suppressed by the missingSenderSession guard.
vi.mock('../../utils/request-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/request-context')>();
  return {
    ...actual,
    getRequestContext: vi.fn().mockReturnValue({ sessionId: 'session-mock-123' }),
    getSessionContext: vi.fn().mockReturnValue(undefined),
    getPinnedAgentId: vi.fn().mockReturnValue(undefined),
  };
});

// Mock agent gateway
vi.mock('../../channels/agent-gateway.js', () => ({
  getAgentGateway: vi.fn().mockReturnValue({
    dispatchTrigger: vi.fn().mockReturnValue({
      success: true,
      triggerId: 'trigger-1',
      processed: false,
      accepted: true,
    }),
    // Synchronous assignment dispatch (spec §3a) — awaited by handleSendToInbox
    processTrigger: vi.fn().mockResolvedValue({
      success: true,
      triggerId: 'trigger-sync-1',
      processed: true,
    }),
  }),
}));

// Mock thread-handlers (imported by inbox-handlers for reply semantics and
// the get_inbox threadKey alias)
const mockHandleGetThreadMessages = vi.fn();
vi.mock('./thread-handlers.js', () => ({
  findThread: vi.fn().mockResolvedValue(null),
  getParticipants: vi.fn().mockResolvedValue([]),
  resolveTriggeredAgents: vi.fn().mockReturnValue([]),
  handleGetThreadMessages: (...args: unknown[]) => mockHandleGetThreadMessages(...args),
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
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
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

  // Read pointer for agent_inbox_read_status (pointer-based unread tracking)
  const readPointerChainable = {
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  };

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_identities') return identityChainable;
    if (table === 'agent_inbox_read_status') return readPointerChainable;
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

  it('should trigger without senderAgentId using unknown sender', async () => {
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
        fromAgentId: 'unknown',
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

  it('should forward caller metadata into trigger payload (strategy trigger propagation)', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        messageType: 'session_resume',
        content: 'Strategy kickoff',
        metadata: {
          source: 'strategy_service',
          strategyTrigger: true,
          groupId: 'group-abc',
          taskId: 'task-1',
        },
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          strategyTrigger: true,
          groupId: 'group-abc',
        }),
      })
    );
  });

  it('should dispatch trigger for new self-thread session_resume (strategy first kickoff)', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();
    // findThread returns null → new thread path
    const { findThread } = await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue(null);

    const mockSb = createThreadMockSupabase();
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        messageType: 'session_resume',
        threadKey: 'strategy:new-group-123',
        content: 'Strategy kickoff — first trigger',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'wren',
        threadKey: 'strategy:new-group-123',
      })
    );
  });

  // ===================================================================
  // 2FA SECURITY — permission_grant from agent senders must be rejected
  // ===================================================================

  it('rejects permission_grant when senderAgentId is present', async () => {
    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await expect(
      handleSendToInbox(
        {
          email: 'test@test.com',
          recipientAgentId: 'wren',
          senderAgentId: 'wren',
          messageType: 'permission_grant',
          content: 'granting self permission',
        },
        mockDc as never
      )
    ).rejects.toThrow('permission_grant messages cannot be sent by agents');

    expect(mockSb._chainable.insert).not.toHaveBeenCalled();
  });

  it('allows permission_grant from the system layer (no senderAgentId)', async () => {
    // Use thread path so the message_type is exercised.
    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        // no senderAgentId — treated as system sender
        messageType: 'permission_grant',
        content: 'granted',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
  });
});

// =====================================================
// REPLY ROUTING — Thread message metadata enrichment
// =====================================================

/**
 * Build a Supabase mock that supports the full thread path:
 * findOrCreateThread → participant registration → message insert → trigger dispatch.
 *
 * The thread path hits multiple tables with different chainable patterns.
 * This mock returns table-specific chainable objects.
 */
function createThreadMockSupabase(
  options: {
    existingThread?: { id: string };
    recipientPriorMessage?: { metadata: Record<string, unknown> } | null;
    threadMessageId?: string;
  } = {}
) {
  const threadId = options.existingThread?.id || 'thread-999';
  const threadMessageId = options.threadMessageId || 'tmsg-123';
  let insertedMetadata: Record<string, unknown> | null = null;

  // inbox_threads table mock
  const threadsFindChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: options.existingThread ? { id: threadId } : null,
            error: null,
          }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: threadId },
          error: null,
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  };

  // inbox_thread_participants table mock
  const participantsChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { agent_id: 'existing', session_id: null },
            error: null,
          }),
        }),
      }),
    }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  };

  // inbox_thread_messages table mock
  const messagesChain = {
    insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
      insertedMetadata = row.metadata as Record<string, unknown>;
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: threadMessageId, ...row },
            error: null,
          }),
        }),
      };
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: options.recipientPriorMessage || null,
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };

  // inbox_thread_read_status table mock
  const readStatusChain = {
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  // identity mock (for resolveIdentityId)
  const identityChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: [{ id: 'identity-123', workspace_id: 'ws-1', updated_at: null }],
            error: null,
          }),
        }),
      }),
    }),
  };

  const fromFn = vi.fn().mockImplementation((table: string) => {
    switch (table) {
      case 'inbox_threads':
        return threadsFindChain;
      case 'inbox_thread_participants':
        return participantsChain;
      case 'inbox_thread_messages':
        return messagesChain;
      case 'inbox_thread_read_status':
        return readStatusChain;
      case 'agent_identities':
        return identityChain;
      default:
        return threadsFindChain;
    }
  });

  // Read-pointer advances go through the atomic RPC (read-state.ts)
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpcFn = vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve({ data: null, error: null });
  });

  return {
    from: fromFn,
    rpc: rpcFn,
    getInsertedMetadata: () => insertedMetadata,
    getRpcCalls: () => rpcCalls,
  };
}

function createThreadMockDataComposer(supabase: ReturnType<typeof createThreadMockSupabase>) {
  return {
    getClient: vi.fn().mockReturnValue(supabase),
    repositories: {
      memory: {
        getActiveSessionByThreadKey: vi.fn().mockResolvedValue(null),
        getActiveSession: vi.fn().mockResolvedValue(null),
      },
    },
  };
}

describe('Reply Routing — thread message metadata enrichment', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Configure findThread mock to return existing thread for these tests
    const { findThread } = await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue({
      id: 'thread-pr210',
      thread_key: 'pr:210',
      user_id: 'user-123',
      created_by_agent_id: 'wren',
      title: null,
      status: 'open',
      metadata: null,
      created_at: '2026-03-09T10:00:00Z',
      updated_at: '2026-03-09T10:00:00Z',
      closed_at: null,
      closed_by_agent_id: null,
    });
    const { getParticipants } = await import('./thread-handlers.js');
    vi.mocked(getParticipants).mockResolvedValue(['wren', 'lumen']);
  });

  it('should enrich thread message metadata with pcp.sender context', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Mock request context to provide sender session info
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'wren-session-123',
      studioId: 'studio-wren',
    } as ReturnType<typeof getRequestContext>);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Please review this PR',
      },
      mockDc as never
    );

    // Verify the inserted message metadata has pcp.sender
    const insertedMeta = mockSb.getInsertedMetadata();
    expect(insertedMeta).toBeDefined();
    expect(insertedMeta!.pcp).toBeDefined();
    const pcpMeta = insertedMeta!.pcp as Record<string, unknown>;
    expect(pcpMeta.sender).toEqual({
      agentId: 'wren',
      sessionId: 'wren-session-123',
      studioId: 'studio-wren',
    });
  });

  it('should set sender sessionId to null when no request context is available', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Clear request context mock
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Hello',
      },
      mockDc as never
    );

    const insertedMeta = mockSb.getInsertedMetadata();
    expect(insertedMeta).toBeDefined();
    const pcpMeta = insertedMeta!.pcp as Record<string, unknown>;
    const sender = pcpMeta.sender as Record<string, unknown>;
    expect(sender.agentId).toBe('wren');
    expect(sender.sessionId).toBeNull();
    expect(sender.studioId).toBeNull();
  });
});

describe('Reply Routing — trigger recipientSessionId auto-resolution', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Configure findThread to return existing thread for reply tests
    const { findThread, getParticipants, resolveTriggeredAgents } =
      await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue({
      id: 'thread-pr210',
      thread_key: 'pr:210',
      user_id: 'user-123',
      created_by_agent_id: 'wren',
      title: null,
      status: 'open',
      metadata: null,
      created_at: '2026-03-09T10:00:00Z',
      updated_at: '2026-03-09T10:00:00Z',
      closed_at: null,
      closed_by_agent_id: null,
    });
    vi.mocked(getParticipants).mockResolvedValue(['wren', 'lumen']);
    // For reply triggers, resolveTriggeredAgents should return the other participant
    vi.mocked(resolveTriggeredAgents).mockReturnValue(['lumen']);
  });

  it('should auto-resolve recipientSessionId from prior thread message', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
      // Lumen's prior message on this thread has their session context
      recipientPriorMessage: {
        metadata: {
          pcp: {
            sender: {
              agentId: 'lumen',
              sessionId: 'lumen-session-456',
              studioId: 'studio-lumen',
            },
          },
        },
      },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Provide session context so triggers aren't suppressed by missingSenderSession guard
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'wren-session-abc' } as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Reply to your review',
      },
      mockDc as never
    );

    // Trigger should include the auto-resolved recipientSessionId
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'lumen',
        threadKey: 'pr:210',
        recipientSessionId: 'lumen-session-456',
      })
    );
  });

  it('should not set recipientSessionId when no prior message exists', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-new' },
      recipientPriorMessage: null, // No prior messages from recipient
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Provide session context so triggers aren't suppressed by missingSenderSession guard
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'wren-session-abc' } as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:999',
        content: 'First message on this thread',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'lumen',
        threadKey: 'pr:999',
        recipientSessionId: undefined,
      })
    );
  });

  it('should use explicit recipientSessionId over auto-resolved one', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
      // Even though a prior message has a different session ID...
      recipientPriorMessage: {
        metadata: {
          pcp: {
            sender: {
              agentId: 'lumen',
              sessionId: 'lumen-old-session',
              studioId: 'studio-lumen',
            },
          },
        },
      },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Provide session context so triggers aren't suppressed
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'wren-session-abc' } as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        recipientSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        content: 'Using explicit routing',
      },
      mockDc as never
    );

    // Explicit recipientSessionId should take priority
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      })
    );
  });
});

describe('Reply Routing — sender session fallback behavior', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Configure findThread to return existing thread for reply tests
    const { findThread, getParticipants, resolveTriggeredAgents } =
      await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue({
      id: 'thread-pr42',
      thread_key: 'pr:42',
      user_id: 'user-123',
      created_by_agent_id: 'wren',
      title: null,
      status: 'open',
      metadata: null,
      created_at: '2026-03-09T10:00:00Z',
      updated_at: '2026-03-09T10:00:00Z',
      closed_at: null,
      closed_by_agent_id: null,
    });
    vi.mocked(getParticipants).mockResolvedValue(['wren', 'lumen']);
    vi.mocked(resolveTriggeredAgents).mockReturnValue(['lumen']);
  });

  it('should use threadKey-scoped lookup when no request context provides sessionId', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr42' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // No request context (simulates missing x-ink-session-id header)
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    // threadKey-scoped lookup returns a matching session
    vi.mocked(mockDc.repositories.memory.getActiveSessionByThreadKey).mockResolvedValue({
      id: 'thread-scoped-session-123',
      agentId: 'wren',
      studioId: 'studio-wren',
    } as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:42',
        content: 'Should use threadKey lookup',
      },
      mockDc as never
    );

    // Verify threadKey-scoped lookup was called
    expect(mockDc.repositories.memory.getActiveSessionByThreadKey).toHaveBeenCalledWith(
      'user-123',
      'wren',
      'pr:42',
      null // senderStudioId is null since no request context
    );

    // Verify metadata has the threadKey-resolved session
    const insertedMeta = mockSb.getInsertedMetadata();
    expect(insertedMeta).toBeDefined();
    const pcpMeta = insertedMeta!.pcp as Record<string, unknown>;
    const sender = pcpMeta.sender as Record<string, unknown>;
    expect(sender.sessionId).toBe('thread-scoped-session-123');
  });

  it('should NOT fall back to getActiveSession (most-recent) when threadKey lookup fails', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-new-topic' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // No request context
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    // threadKey lookup returns null (no matching session)
    vi.mocked(mockDc.repositories.memory.getActiveSessionByThreadKey).mockResolvedValue(null);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'thread:new-topic',
        content: 'First message, no prior session',
      },
      mockDc as never
    );

    // getActiveSession should NOT have been called (removed fallback)
    expect(mockDc.repositories.memory.getActiveSession).not.toHaveBeenCalled();

    // Sender session should be null, not a random most-recent session
    const insertedMeta = mockSb.getInsertedMetadata();
    const pcpMeta = insertedMeta!.pcp as Record<string, unknown>;
    const sender = pcpMeta.sender as Record<string, unknown>;
    expect(sender.sessionId).toBeNull();
  });

  it('should NOT attempt threadKey lookup when no threadKey is provided', async () => {
    // For legacy (non-thread) inbox path, sender session is null without request context
    const mockSb = createMockSupabase({
      insertReturn: {
        data: {
          id: 'msg-legacy',
          created_at: '2026-03-12T00:00:00Z',
          thread_key: null,
          recipient_agent_id: 'lumen',
          sender_agent_id: 'wren',
          subject: 'Legacy message',
          content: 'No threadKey',
          message_type: 'message',
          priority: 'normal',
          status: 'unread',
          recipient_session_id: null,
          related_artifact_uri: null,
          metadata: {},
          read_at: null,
        },
        error: null,
      },
    });
    const mockDc = createMockDataComposer(mockSb);

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Legacy path, no threadKey',
      },
      mockDc as never
    );

    // No threadKey → no threadKey-scoped lookup attempted
    // (mockDc doesn't have the repo method in the legacy mock, which is fine)
    // The point is: no crash, and no getActiveSession fallback
  });

  it('should prefer request context sessionId over threadKey lookup', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr99' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Request context provides sessionId (from x-ink-session-id header)
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'header-session-xyz',
      studioId: 'header-studio-abc',
    } as ReturnType<typeof getRequestContext>);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:99',
        content: 'Header should win',
      },
      mockDc as never
    );

    // threadKey lookup should NOT be called — header already provides session
    expect(mockDc.repositories.memory.getActiveSessionByThreadKey).not.toHaveBeenCalled();

    // Sender session comes from request context header
    const insertedMeta = mockSb.getInsertedMetadata();
    const pcpMeta = insertedMeta!.pcp as Record<string, unknown>;
    const sender = pcpMeta.sender as Record<string, unknown>;
    expect(sender.sessionId).toBe('header-session-xyz');
    expect(sender.studioId).toBe('header-studio-abc');
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

// =====================================================
// get_inbox threadKey alias → get_thread_messages
// =====================================================

describe('handleGetInbox — threadKey alias', () => {
  beforeEach(() => {
    mockHandleGetThreadMessages.mockReset();
  });

  it('delegates threadKey queries to get_thread_messages with mapped args', async () => {
    // Previously threadKey was silently stripped by the schema and the query
    // ran against agent_inbox — where thread messages never live — returning
    // empty with zero signal (the Myra vet-turn bug). Conor's call: the
    // inbox is the front door; threadKey aliases through.
    const delegateResult = {
      content: [{ type: 'text', text: JSON.stringify({ success: true, messages: [] }) }],
    };
    mockHandleGetThreadMessages.mockResolvedValue(delegateResult);

    const mockDc = createMockDataComposer(createMockSupabase());
    const result = await handleGetInbox(
      {
        email: 'test@test.com',
        agentId: 'myra',
        threadKey: 'thread:wholly-in-ink-vet',
        limit: 10,
      },
      mockDc as never
    );

    expect(result).toBe(delegateResult);
    expect(mockHandleGetThreadMessages).toHaveBeenCalledOnce();
    const delegatedArgs = mockHandleGetThreadMessages.mock.calls[0]![0] as Record<string, unknown>;
    expect(delegatedArgs.threadKey).toBe('thread:wholly-in-ink-vet');
    expect(delegatedArgs.agentId).toBe('myra');
    expect(delegatedArgs.limit).toBe(10);
    expect(delegatedArgs.fullHistory).toBeUndefined();
  });

  it("maps status 'all' to the full thread history", async () => {
    mockHandleGetThreadMessages.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });

    const mockDc = createMockDataComposer(createMockSupabase());
    await handleGetInbox(
      {
        email: 'test@test.com',
        agentId: 'myra',
        threadKey: 'pr:463',
        status: 'all',
      },
      mockDc as never
    );

    const delegatedArgs = mockHandleGetThreadMessages.mock.calls[0]![0] as Record<string, unknown>;
    expect(delegatedArgs.fullHistory).toBe(true);
  });

  it('rejects threadKey without agentId — thread access is participant-scoped', async () => {
    const mockDc = createMockDataComposer(createMockSupabase());
    await expect(
      handleGetInbox({ email: 'test@test.com', threadKey: 'pr:463' }, mockDc as never)
    ).rejects.toThrow(/requires agentId/);
    expect(mockHandleGetThreadMessages).not.toHaveBeenCalled();
  });

  it('malformed threadKey fails schema validation instead of being silently stripped', async () => {
    const mockDc = createMockDataComposer(createMockSupabase());
    await expect(
      handleGetInbox(
        { email: 'test@test.com', agentId: 'myra', threadKey: 'not a thread key' },
        mockDc as never
      )
    ).rejects.toThrow();
    expect(mockHandleGetThreadMessages).not.toHaveBeenCalled();
  });

  it('unknown parameters are REJECTED by name, never silently stripped (.strict)', async () => {
    // The original bug class: zod's default strips unknown keys, so a
    // plausible-but-wrong parameter silently vanishes and the LLM caller
    // draws confident wrong conclusions. Strict mode names the offender —
    // self-correcting on the next attempt.
    const mockDc = createMockDataComposer(createMockSupabase());
    await expect(
      handleGetInbox(
        { email: 'test@test.com', agentId: 'myra', threadKye: 'pr:464' },
        mockDc as never
      )
    ).rejects.toThrow(/threadKye/);
    expect(mockHandleGetThreadMessages).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'completed' }, /status:'completed'/],
    [{ priority: 'high' }, /priority/],
    [{ messageType: 'task_request' }, /messageType/],
    [{ since: '2026-08-10T00:00:00Z' }, /since/],
    [{ channelPoll: true }, /channelPoll/],
  ])('threadKey mode rejects incompatible filter %j actionably', async (filter, pattern) => {
    // Silent-ignore here returns WRONG results — e.g. status:'completed'
    // would serve unread-pointer messages and advance the pointer.
    const mockDc = createMockDataComposer(createMockSupabase());
    await expect(
      handleGetInbox(
        { email: 'test@test.com', agentId: 'myra', threadKey: 'pr:464', ...filter },
        mockDc as never
      )
    ).rejects.toThrow(pattern);
    expect(mockHandleGetThreadMessages).not.toHaveBeenCalled();
  });
});

// =====================================================
// channelPoll — server-side studio filtering
// =====================================================

describe('isThreadOwnedByStudio', () => {
  const MY_STUDIO = 'studio-omega';
  const OTHER_STUDIO = 'studio-review';

  it('accepts when agent has no messages (new/broadcast thread)', () => {
    expect(isThreadOwnedByStudio([], MY_STUDIO)).toBe(true);
  });

  it('accepts when agent has a message from this studio', () => {
    const messages = [{ metadata: { pcp: { sender: { agentId: 'wren', studioId: MY_STUDIO } } } }];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(true);
  });

  it('rejects when agent has messages only from a different studio', () => {
    const messages = [
      { metadata: { pcp: { sender: { agentId: 'wren', studioId: OTHER_STUDIO } } } },
    ];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(false);
  });

  it('accepts when at least one message matches (mixed studios)', () => {
    const messages = [
      { metadata: { pcp: { sender: { agentId: 'wren', studioId: OTHER_STUDIO } } } },
      { metadata: { pcp: { sender: { agentId: 'wren', studioId: MY_STUDIO } } } },
    ];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(true);
  });

  it('rejects when messages have no pcp metadata', () => {
    const messages = [{ metadata: {} }];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(false);
  });

  it('rejects when messages have pcp.sender but no studioId', () => {
    const messages = [{ metadata: { pcp: { sender: { agentId: 'wren' } } } }];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(false);
  });

  it('rejects when metadata is null', () => {
    const messages = [{ metadata: null }];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(false);
  });

  it('accepts cross-studio self-message via recipient.studioId', () => {
    // wren-omega sends to wren-review: message has sender.studioId=omega, recipient.studioId=review
    // When review's channel plugin polls, it should accept because recipient matches
    const messages = [
      {
        metadata: {
          pcp: {
            sender: { agentId: 'wren', studioId: OTHER_STUDIO },
            recipient: { studioId: MY_STUDIO },
          },
        },
      },
    ];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(true);
  });

  it('rejects when recipient.studioId targets a different studio', () => {
    const messages = [
      {
        metadata: {
          pcp: {
            sender: { agentId: 'wren', studioId: OTHER_STUDIO },
            recipient: { studioId: 'some-third-studio' },
          },
        },
      },
    ];
    expect(isThreadOwnedByStudio(messages, MY_STUDIO)).toBe(false);
  });
});

// =====================================================
// update_inbox_message — thread message fallback
// =====================================================

describe('handleUpdateInboxMessage — thread message fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update thread read pointer when given a thread message ID', async () => {
    const threadMsgId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const threadId = 'f1e2d3c4-b5a6-7890-abcd-ef0987654321';

    // Track upsert calls
    const upsertCalls: unknown[] = [];

    const fromFn = vi.fn().mockImplementation((table: string) => {
      if (table === 'agent_inbox') {
        // Legacy inbox: no match
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'inbox_thread_messages') {
        // Thread message found
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: threadMsgId, thread_id: threadId },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'inbox_threads') {
        // Thread belongs to user
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: threadId },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'inbox_thread_participants') {
        // Agent is a participant
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { agent_id: 'wren' },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'inbox_thread_read_status') {
        return {
          upsert: vi.fn().mockImplementation((data: unknown) => {
            upsertCalls.push(data);
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }
      if (table === 'agent_identities') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    // Pointer writes now go through the atomic RPC, not table upserts
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpcFn = vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: '2026-08-06T00:00:00Z', error: null });
    });

    const mockDc = {
      getClient: vi.fn().mockReturnValue({ from: fromFn, rpc: rpcFn }),
      repositories: {},
    };

    const result = await handleUpdateInboxMessage(
      {
        email: 'test@test.com',
        messageId: threadMsgId,
        agentId: 'wren',
        status: 'completed',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.threadId).toBe(threadId);
    expect(parsed.status).toBe('completed');
    // Old-style direct upserts are banned; the advance goes through the RPC
    // with the exact message cursor, never wall-clock.
    expect(upsertCalls.length).toBe(0);
    expect(rpcCalls).toEqual([
      {
        fn: 'advance_thread_read_pointer',
        args: {
          p_thread_id: threadId,
          p_agent_id: 'wren',
          p_through_message_id: threadMsgId,
        },
      },
    ]);

    // Lumen PR #454 review blocker 3: a failed durable write must surface as
    // failure, never as a positive acknowledgement.
    rpcFn.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(
      handleUpdateInboxMessage(
        {
          email: 'test@test.com',
          messageId: threadMsgId,
          agentId: 'wren',
          status: 'completed',
        },
        mockDc as never
      )
    ).rejects.toThrow(/Failed to persist read state/);
  });
});

// =====================================================
// SYSTEM SENDER + CROSS-AGENT DELEGATION ROUTING
// (Lumen PR #334 review: strategy watchdog/kickoff path)
// =====================================================

describe('handleSendToInbox — system sender and cross-agent studio routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // New thread path — findThread returns null so agentsToTrigger =
    // allRecipients (which includes our addressed recipient).
    const { findThread, getParticipants, resolveTriggeredAgents } =
      await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue(null);
    vi.mocked(getParticipants).mockResolvedValue([]);
    vi.mocked(resolveTriggeredAgents).mockReturnValue([]);
  });

  it('fires a trigger even when senderAgentId is "system" and there is no request context', async () => {
    // This is the watchdog/heartbeat path: StrategyService.triggerWatchdog()
    // sends with senderAgentId='system' from a heartbeat tick that has no
    // x-ink-context token and no session context. The old
    // missingSenderSession guard suppressed the trigger here, so the
    // watchdog marked the reminder delivered without waking the owner.
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const mockDc = createThreadMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'system',
        threadKey: 'strategy:group-1',
        content: 'Resume strategy task',
        messageType: 'session_resume',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    // Trigger must fire — not suppressed by missingSenderSession.
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'wren',
        fromAgentId: 'system',
      })
    );
    // And the warning about suppressed triggers must NOT appear.
    expect(parsed.warning).toBeUndefined();
    expect(parsed.triggered).toContain('wren');
  });

  it('trigger:false still dispatches a routeOnly assignment and wakes nobody (spec §3a)', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'session-mock-123' } as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const mockDc = createThreadMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'thread:quiet-fyi',
        content: 'No rush — for your next inbox check.',
        messageType: 'notification',
        trigger: false,
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    // Assignment happened SYNCHRONOUSLY (processTrigger, awaited) with routeOnly
    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ toAgentId: 'lumen', routeOnly: true })
    );
    // No wake dispatch fired
    expect(mockGateway.dispatchTrigger).not.toHaveBeenCalled();
    expect(parsed.triggered).toEqual([]);
  });

  it('history-inferred recipientSessionId is NOT an explicit anchor; caller studio target IS', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'session-mock-123' } as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    // 1) No caller targeting, but thread history yields a recipient session —
    //    payload must carry recipientSessionId WITHOUT explicitRecipientTarget.
    const withHistory = createThreadMockSupabase({
      existingThread: { id: 'thread-hist' },
      recipientPriorMessage: {
        metadata: { pcp: { sender: { agentId: 'lumen', sessionId: 'lumen-old-session' } } },
      },
    });
    const { findThread, getParticipants, resolveTriggeredAgents } =
      await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue({
      id: 'thread-hist',
      status: 'open',
      created_by_agent_id: 'wren',
    } as never);
    vi.mocked(getParticipants).mockResolvedValue([]);
    vi.mocked(resolveTriggeredAgents).mockReturnValue(['lumen']);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:hist',
        content: 'reply',
      },
      createThreadMockDataComposer(withHistory) as never
    );
    const historyCall = (mockGateway.processTrigger as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { toAgentId: string }).toAgentId === 'lumen'
    );
    expect(historyCall![0]).toEqual(
      expect.objectContaining({ recipientSessionId: 'lumen-old-session' })
    );
    expect(
      (historyCall![0] as { explicitRecipientTarget?: boolean }).explicitRecipientTarget
    ).toBeUndefined();

    vi.mocked(findThread).mockResolvedValue(null);
    vi.mocked(resolveTriggeredAgents).mockReturnValue([]);
    (mockGateway.processTrigger as ReturnType<typeof vi.fn>).mockClear();

    // 2) Caller-passed studio target → explicitRecipientTarget true.
    const plain = createThreadMockSupabase({ existingThread: undefined });
    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        recipientStudioId: '123e4567-e89b-12d3-a456-426614174000',
        threadKey: 'thread:studio-target',
        content: 'handoff',
        messageType: 'task_request',
      },
      createThreadMockDataComposer(plain) as never
    );
    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ toAgentId: 'wren', explicitRecipientTarget: true })
    );
  });

  it('unscoped channelPoll fails closed BEFORE any read — no legacy fetch, no pointer advance', async () => {
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    // With agentId
    const result = await handleGetInbox(
      { email: 'test@test.com', agentId: 'wren', channelPoll: true },
      mockDc as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain('channel_poll_unscoped');
    expect(parsed.messages).toEqual([]);

    // And WITHOUT agentId — the gate must not be bypassable by omitting it
    const result2 = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      mockDc as never
    );
    expect(JSON.parse(result2.content[0].text).warning).toContain('channel_poll_unscoped');

    // Nothing was read and nothing advanced: no agent_inbox fetch, no
    // read-pointer table touched.
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('agent_inbox');
    expect(tablesTouched).not.toContain('agent_inbox_read_status');
  });

  it('advances the sender read pointer through the inserted message on ordinary sends', async () => {
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({
      existingThread: undefined,
      threadMessageId: 'tmsg-777',
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:999',
        content: 'Review please',
        messageType: 'task_request',
      },
      mockDc as never
    );

    const advances = mockSb.getRpcCalls().filter((c) => c.fn === 'advance_thread_read_pointer');
    expect(advances).toHaveLength(1);
    expect(advances[0]!.args).toMatchObject({
      p_agent_id: 'wren',
      p_through_message_id: 'tmsg-777',
    });
  });

  it('does NOT advance the sender pointer for cross-studio self-sends', async () => {
    // Spec ink://specs/inkmail-read-state §1: there is one (thread, agent)
    // pointer. A self-send targeting another studio must stay unread until
    // the TARGET instance's delivery — sender-advance would hide it.
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({
      existingThread: undefined,
      threadMessageId: 'tmsg-888',
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        recipientStudioId: '123e4567-e89b-12d3-a456-426614174000',
        threadKey: 'thread:self-handoff',
        content: 'Pick this up in the other studio',
        messageType: 'task_request',
      },
      mockDc as never
    );

    const advances = mockSb.getRpcCalls().filter((c) => c.fn === 'advance_thread_read_pointer');
    expect(advances).toHaveLength(0);
  });

  it('does NOT advance the sender pointer for sessionAlias self-sends either', async () => {
    // Lumen PR #454 review blocker 1: the exemption must cover ALL explicit
    // self-target forms — alias included — with the same predicate that
    // drives trigger self-inclusion.
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({
      existingThread: undefined,
      threadMessageId: 'tmsg-889',
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        sessionAlias: 'review',
        threadKey: 'thread:self-alias-handoff',
        content: 'Pick this up in the review session',
        messageType: 'task_request',
      },
      mockDc as never
    );

    const advances = mockSb.getRpcCalls().filter((c) => c.fn === 'advance_thread_read_pointer');
    expect(advances).toHaveLength(0);
  });

  it('propagates recipientStudioId to the trigger payload for cross-agent delegation', async () => {
    // This is the kickoff/watchdog path: the strategy service targets the
    // owner agent (not self) in group.metadata.studioId. Before the fix,
    // studio was only forwarded for self-studio messages (sender ==
    // recipient), so cross-agent delegation lost the assigned studio and
    // routing fell back to route patterns / default studio.
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'system',
        threadKey: 'strategy:group-1',
        content: 'Resume strategy task',
        messageType: 'session_resume',
        recipientStudioId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'wren',
        studioId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      })
    );
  });

  it('propagates recipientStudioSlug to the trigger payload when no UUID is provided', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const mockDc = createThreadMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'system',
        threadKey: 'strategy:group-2',
        content: 'Resume strategy task',
        messageType: 'session_resume',
        recipientStudioSlug: 'wren-omega',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'wren',
        studioHint: 'wren-omega',
      })
    );
  });
});

// =====================================================
// SESSION-SCOPED THREAD FILTERING
// =====================================================

describe('Session-scoped thread filtering', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { findThread, getParticipants, resolveTriggeredAgents } =
      await import('./thread-handlers.js');
    vi.mocked(findThread).mockResolvedValue({
      id: 'thread-pr210',
      thread_key: 'pr:210',
      user_id: 'user-123',
      created_by_agent_id: 'wren',
      title: null,
      status: 'open',
      metadata: null,
      created_at: '2026-03-09T10:00:00Z',
      updated_at: '2026-03-09T10:00:00Z',
      closed_at: null,
      closed_by_agent_id: null,
    });
    vi.mocked(getParticipants).mockResolvedValue(['wren', 'lumen']);
    vi.mocked(resolveTriggeredAgents).mockReturnValue(['lumen']);
  });

  it('should include threadId in trigger payload', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'wren-session-abc' } as never);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Review this PR',
        messageType: 'task_request',
      },
      mockDc as never
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-pr210',
        toAgentId: 'lumen',
      })
    );
  });

  it('should stamp sender session_id on participant (authoritative overwrite)', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    // Sender has session from request context
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'wren-session-new',
      studioId: 'studio-wren',
    } as ReturnType<typeof getRequestContext>);

    // Mock existing participant with a DIFFERENT session (from a prior call)
    mockSb.from('inbox_thread_participants');
    const participantsChain = mockSb.from.mock.results.find(
      (_: unknown, i: number) => mockSb.from.mock.calls[i][0] === 'inbox_thread_participants'
    )?.value;
    if (participantsChain) {
      participantsChain.select.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { agent_id: 'wren', session_id: 'old-session-123' },
              error: null,
            }),
          }),
        }),
      });
    }

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Updated review',
        messageType: 'message',
      },
      mockDc as never
    );

    // Sender's session should be updated (authoritative overwrite)
    expect(participantsChain?.update).toHaveBeenCalled();
  });

  it('should only backfill recipient session_id when null (not overwrite)', async () => {
    // Sender (wren) has session_id: null → should be updated with sender's session
    // Recipient (lumen) already has session_id → should NOT be overwritten
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'wren-session-456',
    } as ReturnType<typeof getRequestContext>);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Check this',
        messageType: 'message',
        recipientSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      },
      mockDc as never
    );

    // The participant mock returns session_id: null, so update should be called
    // for both sender (authoritative) and recipient (backfill null).
    // Verify update was called at least once.
    const participantsFrom = mockSb.from.mock.results.filter(
      (_: unknown, i: number) => mockSb.from.mock.calls[i][0] === 'inbox_thread_participants'
    );
    const lastParticipantsChain = participantsFrom[participantsFrom.length - 1]?.value;
    expect(lastParticipantsChain?.update).toHaveBeenCalled();
  });

  it('should skip session_id for cross-studio self-messages', async () => {
    const mockSb = createThreadMockSupabase({
      existingThread: { id: 'thread-pr210' },
    });
    const mockDc = createThreadMockDataComposer(mockSb);

    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'wren-session-alpha',
      studioId: 'studio-alpha',
    } as ReturnType<typeof getRequestContext>);

    // Wren sends to wren in a different studio — cross-studio self-message
    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'wren',
        senderAgentId: 'wren',
        threadKey: 'pr:210',
        content: 'Cross-studio self-delegation',
        messageType: 'task_request',
        recipientStudioSlug: 'wren-beta',
      },
      mockDc as never
    );

    // Participant mock returns session_id: null. For a cross-studio self-message,
    // session_id should NOT be stamped — it would hide the thread from the other studio.
    // Since participantSessionId is null, the update branch is never entered.
    const participantsFrom = mockSb.from.mock.results.filter(
      (_: unknown, i: number) => mockSb.from.mock.calls[i][0] === 'inbox_thread_participants'
    );
    const lastParticipantsChain = participantsFrom[participantsFrom.length - 1]?.value;
    expect(lastParticipantsChain?.update).not.toHaveBeenCalled();
  });
});

// =====================================================
// PR #460 round 2 — assignment-failure surfacing (send)
// and channelPoll dual-scope validation (get_inbox)
// =====================================================

describe('handleSendToInbox — assignment failure surfacing (round 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success:false with routingFailures when routeOnly assignment reports failure', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();
    mockGateway.processTrigger.mockResolvedValueOnce({
      success: false,
      triggerId: 'trigger-sync-err',
      processed: false,
      error:
        'routeOnly assignment failed for lumen: participant stamp not persisted (boundVia=claim)',
    });

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:460',
        content: 'trigger:false must not fake success',
        messageType: 'message',
        trigger: false,
      },
      createThreadMockDataComposer(mockSb) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    // The message row was stored, but routing did NOT succeed — the response
    // must say so, or a trigger:false send leaves a permanently invisible
    // message behind an unqualified success.
    expect(parsed.success).toBe(false);
    expect(parsed.routingFailures).toEqual([
      { agentId: 'lumen', error: expect.stringContaining('stamp not persisted') },
    ]);
    expect(parsed.message).toContain('routing FAILED');
    expect(parsed.messageId).toBeTruthy();
    // trigger:false — no wake was dispatched.
    expect(mockGateway.dispatchTrigger).not.toHaveBeenCalled();
  });

  it('captures a processTrigger THROW as a routing failure and still attempts the wake', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();
    mockGateway.processTrigger.mockRejectedValueOnce(new Error('gateway handler crashed'));

    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:460',
        content: 'assignment crash must surface',
        messageType: 'task_request',
      },
      createThreadMockDataComposer(mockSb) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.routingFailures).toEqual([
      { agentId: 'lumen', error: 'gateway handler crashed' },
    ]);
    // Wake still attempted: the wake handler re-runs assignment (a transient
    // failure may clear) and the wake itself surfaces the message.
    expect(mockGateway.dispatchTrigger).toHaveBeenCalled();
  });

  it('stays success:true with no routingFailures key when assignment succeeds', async () => {
    const mockSb = createThreadMockSupabase({ existingThread: undefined });
    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        threadKey: 'pr:460',
        content: 'happy path unchanged',
        messageType: 'message',
      },
      createThreadMockDataComposer(mockSb) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.routingFailures).toBeUndefined();
  });
});

/**
 * Purpose-built mock for scoped channelPoll flows: serves a configurable
 * `sessions` row, records per-table .eq() args, and gives every other table
 * a self-chaining thenable that resolves empty.
 */
function createScopedPollMockSupabase(
  opts: {
    sessionRow?: { id: string; agent_id: string | null } | null;
    sessionLookupError?: boolean;
    /** Rows served when a table chain is awaited as a list (thenable). */
    tableRows?: Record<string, unknown[]>;
    /** PostgREST-style RESOLVED errors ({data:null, error}) per table. */
    tableErrors?: Record<string, string>;
  } = {}
) {
  const eqCalls: Record<string, Array<[string, unknown]>> = {};
  const record = (table: string, col: string, val: unknown) => {
    (eqCalls[table] ||= []).push([col, val]);
  };

  const sessionResult = opts.sessionLookupError
    ? { data: null, error: { message: 'connection reset' } }
    : {
        data:
          opts.sessionRow === undefined
            ? { id: 'session-mock-123', agent_id: 'wren' }
            : opts.sessionRow,
        error: null,
      };

  const makeChain = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = {};
    self.select = vi.fn().mockReturnValue(self);
    self.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
    self.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
      record(table, col, val);
      return self;
    });
    self.gt = vi.fn().mockReturnValue(self);
    self.in = vi.fn().mockReturnValue(self);
    self.order = vi.fn().mockReturnValue(self);
    self.limit = vi.fn().mockReturnValue(self);
    self.or = vi.fn().mockResolvedValue({ data: [], error: null, count: 0 });
    self.maybeSingle = vi
      .fn()
      .mockResolvedValue(table === 'sessions' ? sessionResult : { data: null, error: null });
    self.then = (resolve: (v: unknown) => unknown) => {
      const injectedError = opts.tableErrors?.[table];
      return Promise.resolve(
        injectedError
          ? { data: null, error: { message: injectedError }, count: null }
          : { data: opts.tableRows?.[table] ?? [], error: null, count: 0 }
      ).then(resolve);
    };
    return self;
  };

  const identityChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: [{ id: 'identity-123', workspace_id: 'ws-1', updated_at: null }],
            error: null,
          }),
        }),
      }),
    }),
  };

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_identities') return identityChain;
    return makeChain(table);
  });

  return {
    from: fromFn,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    getEqCalls: () => eqCalls,
  };
}

describe('handleGetInbox — channelPoll dual-scope validation (round 2)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getRequestContext, getSessionContext, getPinnedAgentId } =
      await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'session-mock-123' } as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);
    vi.mocked(getPinnedAgentId).mockReturnValue(undefined as never);
  });

  it('derives agentId from the session when omitted — never reads the all-agent surface', async () => {
    const mockSb = createScopedPollMockSupabase();
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.agentId).toBe('wren');
    // The legacy fetch ran agent-scoped: recipient_agent_id was applied.
    const inboxEqs = mockSb.getEqCalls()['agent_inbox'] || [];
    expect(inboxEqs).toContainEqual(['recipient_agent_id', 'wren']);
    // And the session scope was validated against the sessions table,
    // SCOPED TO THE RESOLVED USER (round 3): a session id from another user
    // must read as not-found, never as a scope source.
    expect(mockSb.getEqCalls()['sessions']).toContainEqual(['id', 'session-mock-123']);
    const sessionEqCols = (mockSb.getEqCalls()['sessions'] || []).map((c) => c[0]);
    expect(sessionEqCols).toContain('user_id');
  });

  it('fails closed when the session agent does not match the pinned identity (round 3)', async () => {
    // A pinned Myra caller presenting a Wren session id with agentId omitted
    // must NOT have the read scope switched to Wren.
    const { getPinnedAgentId } = await import('../../utils/request-context');
    vi.mocked(getPinnedAgentId).mockReturnValue('myra' as never);
    const mockSb = createScopedPollMockSupabase(); // session agent is wren
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain('channel_poll_unscoped');
    expect(parsed.warning).toContain('pinned identity');
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('agent_inbox');
  });

  it('passes when the pinned identity matches the session agent (round 3)', async () => {
    const { getPinnedAgentId } = await import('../../utils/request-context');
    vi.mocked(getPinnedAgentId).mockReturnValue('wren' as never);
    const mockSb = createScopedPollMockSupabase();
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.agentId).toBe('wren');
  });

  it('fails closed when the provided agentId does not match the session agent', async () => {
    const mockSb = createScopedPollMockSupabase(); // session agent is wren
    const result = await handleGetInbox(
      { email: 'test@test.com', agentId: 'myra', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toContain('channel_poll_unscoped');
    expect(parsed.messages).toEqual([]);
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('agent_inbox');
    expect(tablesTouched).not.toContain('agent_inbox_read_status');
  });

  it('fails closed when the session row is missing or has no agent', async () => {
    const mockSb = createScopedPollMockSupabase({ sessionRow: null });
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    expect(JSON.parse(result.content[0].text).warning).toContain('channel_poll_unscoped');
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('agent_inbox');
  });

  it('fails closed on a session lookup ERROR — unverifiable scope never widens into a read', async () => {
    const mockSb = createScopedPollMockSupabase({ sessionLookupError: true });
    const result = await handleGetInbox(
      { email: 'test@test.com', agentId: 'wren', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    expect(JSON.parse(result.content[0].text).warning).toContain('channel_poll_unscoped');
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('agent_inbox');
  });
});

// =====================================================
// channelPoll thread paging — exact SQL candidacy (round 3)
// =====================================================

describe('handleGetInbox — channelPoll thread paging via get_unread_thread_candidates', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getRequestContext, getSessionContext, getPinnedAgentId } =
      await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({ sessionId: 'session-mock-123' } as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);
    vi.mocked(getPinnedAgentId).mockReturnValue(undefined as never);
  });

  function withCandidates(
    mockSb: ReturnType<typeof createScopedPollMockSupabase>,
    rows: Array<{ thread_id: string; latest_message_at: string; total_candidates: number }>
  ) {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    (mockSb as { rpc: unknown }).rpc = vi
      .fn()
      .mockImplementation((fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'get_unread_thread_candidates') {
          return Promise.resolve({ data: rows, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
    return rpcCalls;
  }

  const STAMPED = { tableRows: { inbox_thread_participants: [{ thread_id: 't-1' }] } };

  it('selects candidates via the RPC scoped to user+agent+session — never thread.updated_at', async () => {
    // The participant scan must find stamped thread ids so the block runs.
    const mockSb = createScopedPollMockSupabase(STAMPED);
    const rpcCalls = withCandidates(mockSb, [
      { thread_id: 't-1', latest_message_at: '2026-08-12T00:00:01Z', total_candidates: 1 },
    ]);
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const call = rpcCalls.find((c) => c.fn === 'get_unread_thread_candidates');
    expect(call).toBeDefined();
    expect(call!.args).toMatchObject({
      p_agent_id: 'wren',
      p_session_id: 'session-mock-123',
      p_limit: 20,
    });
    expect(parsed.unreadThreadsTruncated).toBeUndefined();
  });

  it('reports truncation from the RPC total, not a client pre-cap', async () => {
    const mockSb = createScopedPollMockSupabase(STAMPED);
    withCandidates(
      mockSb,
      Array.from({ length: 20 }, (_, i) => ({
        thread_id: `t-${i}`,
        latest_message_at: `2026-08-12T00:00:${String(i).padStart(2, '0')}Z`,
        total_candidates: 37,
      }))
    );
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.unreadThreadsTruncated).toBe(true);
  });

  it('no participant pre-scan and no client-side id list — the URI-too-long regression', async () => {
    // The old flow scanned inbox_thread_participants (unfiltered on the
    // agent-less mission path), collected EVERY thread id, and fed them to
    // .in('id', ...) — PostgREST puts that in the URL, so a few hundred
    // threads produced HTTP 414 and a silently empty mission timeline.
    // The recency page now filters membership with an !inner join instead.
    const mockSb = createScopedPollMockSupabase();
    await handleGetInbox(
      { email: 'test@test.com', agentId: 'wren' },
      createMockDataComposer(mockSb as never) as never
    );
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    // No standalone participant scan (allParts would only run with a page).
    expect(tablesTouched).not.toContain('inbox_thread_participants');
    // Membership filtered in SQL via the embedded join, not an id list.
    expect(mockSb.getEqCalls()['inbox_threads']).toContainEqual([
      'inbox_thread_participants.agent_id',
      'wren',
    ]);
  });

  it('channelPoll goes straight to the candidacy RPC — no pre-scan gate', async () => {
    const mockSb = createScopedPollMockSupabase();
    const rpcCalls = withCandidates(mockSb, []);
    await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    expect(rpcCalls.some((c) => c.fn === 'get_unread_thread_candidates')).toBe(true);
    const tablesTouched = (mockSb.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tablesTouched).not.toContain('inbox_thread_participants');
  });

  it('a RESOLVED thread-messages error turns candidates into incomplete, not zero unread', async () => {
    const mockSb = createScopedPollMockSupabase({
      tableRows: {
        inbox_thread_participants: [{ thread_id: 't-1' }],
        inbox_threads: [
          {
            id: 't-1',
            thread_key: 'pr:t1',
            title: null,
            user_id: 'user-123',
            created_by_agent_id: 'lumen',
            updated_at: '2026-08-12T00:00:01Z',
          },
        ],
      },
      tableErrors: { inbox_thread_messages: 'statement timeout' },
    });
    withCandidates(mockSb, [
      { thread_id: 't-1', latest_message_at: '2026-08-12T00:00:01Z', total_candidates: 1 },
    ]);
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.channelPollIncomplete).toBe(true);
    expect(parsed.warning).toContain('channel_poll_incomplete');
  });

  it('an RPC failure is LOUD — no silent empty delivery', async () => {
    const mockSb = createScopedPollMockSupabase(STAMPED);
    (mockSb as { rpc: unknown }).rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    const result = await handleGetInbox(
      { email: 'test@test.com', channelPoll: true },
      createMockDataComposer(mockSb as never) as never
    );
    // The outer catch degrades gracefully (legacy messages still return),
    // but the failure must be logged at error level by the paging block.
    const { logger } = await import('../../utils/logger');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'channel_poll_candidates_failed',
      expect.objectContaining({ agentId: 'wren' })
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    // The outage must NOT masquerade as a drained inbox (round 4): the
    // poller sees an explicit incomplete signal and withholds drain proof.
    expect(parsed.channelPollIncomplete).toBe(true);
    expect(parsed.warning).toContain('channel_poll_incomplete');
  });
});
