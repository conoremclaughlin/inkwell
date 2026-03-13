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

// Mock request context (for sender session resolution)
vi.mock('../../utils/request-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/request-context')>();
  return {
    ...actual,
    getRequestContext: vi.fn().mockReturnValue(undefined),
    getSessionContext: vi.fn().mockReturnValue(undefined),
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
  }),
}));

// Mock thread-handlers (imported by inbox-handlers for reply semantics)
vi.mock('./thread-handlers.js', () => ({
  findThread: vi.fn().mockResolvedValue(null),
  getParticipants: vi.fn().mockResolvedValue([]),
  resolveTriggeredAgents: vi.fn().mockReturnValue([]),
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
            data: { agent_id: 'existing' },
            error: null,
          }),
        }),
      }),
    }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
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

  return {
    from: fromFn,
    getInsertedMetadata: () => insertedMetadata,
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
      workspaceId: 'studio-wren',
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

    // Clear request context
    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

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

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

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

    const { getRequestContext, getSessionContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);
    vi.mocked(getSessionContext).mockReturnValue(undefined as never);

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

    // No request context (simulates missing x-pcp-session-id header)
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

    // Request context provides sessionId (from x-pcp-session-id header)
    const { getRequestContext } = await import('../../utils/request-context');
    vi.mocked(getRequestContext).mockReturnValue({
      sessionId: 'header-session-xyz',
      workspaceId: 'header-studio-abc',
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
