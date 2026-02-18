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
    processTrigger: vi.fn().mockResolvedValue({
      success: true,
      triggerId: 'trigger-1',
      processed: true,
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
    related_session_id: null,
    related_artifact_uri: null,
    metadata: {},
    read_at: null,
  };

  const insertReturn = overrides.insertReturn || { data: defaultMessage, error: null };

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

  it('should include threadKey in DB insert when provided', async () => {
    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Review PR #32',
        messageType: 'task_request',
        threadKey: 'pr:32',
      },
      mockDc as never
    );

    // Verify the insert was called with thread_key
    expect(mockSb._chainable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_key: 'pr:32',
      })
    );
  });

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

  it('should include threadKey in response when provided', async () => {
    const mockSb = createMockSupabase({
      insertReturn: {
        data: {
          id: 'msg-456',
          created_at: '2026-02-15T10:00:00Z',
          thread_key: 'pr:32',
        },
        error: null,
      },
    });
    const mockDc = createMockDataComposer(mockSb);

    const result = await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Review PR #32',
        threadKey: 'pr:32',
      },
      mockDc as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.threadKey).toBe('pr:32');
    expect(parsed.hint).toBeUndefined();
  });

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

  it('should pass threadKey in trigger payload', async () => {
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();

    const mockSb = createMockSupabase();
    const mockDc = createMockDataComposer(mockSb);

    await handleSendToInbox(
      {
        email: 'test@test.com',
        recipientAgentId: 'lumen',
        senderAgentId: 'wren',
        content: 'Review PR #32',
        messageType: 'task_request',
        trigger: true,
        threadKey: 'pr:32',
      },
      mockDc as never
    );

    // The trigger is fire-and-forget, so check the gateway was called with threadKey
    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: 'pr:32',
      })
    );
  });

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

    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'myra',
      })
    );
  });

  it('should pass relatedSessionId through trigger payload', async () => {
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
        relatedSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
        content: 'Resume this session',
      },
      mockDc as never
    );

    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedSessionId: 'b85490f5-0836-4bdd-8193-f6cfa2562a41',
      })
    );
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
        content: 'Human-sent coordination message',
      },
      mockDc as never
    );

    expect(mockGateway.processTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAgentId: 'system',
      })
    );
  });
});
