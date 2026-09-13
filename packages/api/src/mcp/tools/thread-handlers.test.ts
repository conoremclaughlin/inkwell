/**
 * Thread Handler Tests
 *
 * Tests for group thread messaging: trigger resolution, validation,
 * thread lifecycle, and participant management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveTriggeredAgents,
  resolveEffectiveFloor,
  isLaterInstant,
  type SbRef,
  type TriggerPrincipal,
} from './thread-handlers';

/**
 * Dispatch operates on SB principals only (spec inkmail-thread-scope §7).
 * Participants are `{ sbId, agentId }` refs; targets and recipients are
 * canonical ids; people never enter the set. `sb()` keeps the fixtures
 * readable: the id is derived from the slug.
 */
const sb = (agentId: string): SbRef => ({ sbId: `sb-${agentId}`, agentId });
const sbs = (...slugs: string[]): SbRef[] => slugs.map(sb);
const ids = (refs: SbRef[]): string[] => refs.map((r) => r.sbId);
const sender = (agentId: string): TriggerPrincipal => ({ kind: 'sb', ...sb(agentId) });
const PERSON: TriggerPrincipal = { kind: 'user' };
const SYSTEM: TriggerPrincipal = { kind: 'system' };

describe('resolveTriggeredAgents', () => {
  describe('1:1 threads (2 participants)', () => {
    it('should trigger the other participant', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('should trigger creator when non-creator replies in 1:1', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('is 1:1 by SB count: one other SB plus two people reading is still the other SB (§7)', () => {
      // People hold participant rows but never enter the dispatch set; the
      // caller passes only the SB refs, so cardinality here is SB cardinality.
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('lumen'));
    });
  });

  describe('group threads (3+ participants)', () => {
    const participants = sbs('wren', 'lumen', 'aster', 'myra');

    it('should trigger creator only when non-creator replies', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should trigger all others when creator replies with a plain message', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        messageType: 'message',
      });
      expect(result).toEqual(sbs('lumen', 'aster', 'myra'));
    });

    it('should trigger all others when creator replies with no messageType (default)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('lumen', 'aster', 'myra'));
    });

    it('should trigger only explicit recipient when creator targets one person', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('myra')),
      });
      expect(result).toEqual(sbs('myra'));
    });

    it('should trigger only explicit recipient when non-creator targets one person', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('myra')),
      });
      expect(result).toEqual(sbs('myra'));
    });

    it('explicit recipients sit ahead of the creator fallback (a preservation clause, §7)', () => {
      // A non-creator's plain message addressed to one SB wakes that SB —
      // never the creator — on a thread with an SB creator.
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: sender('wren'),
        messageType: 'message',
        recipients: ids(sbs('aster')),
      });
      expect(result).toEqual(sbs('aster'));
    });

    it('should trigger no one when creator explicitly targets self (same studio)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('wren')),
      });
      expect(result).toEqual([]);
    });

    it('should trigger no one when non-creator explicitly targets self (same studio)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('lumen')),
      });
      expect(result).toEqual([]);
    });

    it('an empty explicit-recipient intersection stays empty — it is the answer, not a miss (§7)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ['sb-benson'],
      });
      expect(result).toEqual([]);
    });

    it('should trigger self when explicitly targeting self with selfStudioTarget', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('wren')),
        selfStudioTarget: true,
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should filter explicit recipients to actual participants', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        recipients: ids(sbs('myra', 'benson')),
      });
      expect(result).toEqual(sbs('myra'));
    });

    it('a non-creator reply on a HUMAN-created thread wakes all other SBs — a decision, not a fallthrough (§7)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: PERSON,
        messageType: 'message',
      });
      expect(result).toEqual(sbs('wren', 'aster', 'myra'));
    });

    it('a system-created thread routes the same way as a human-created one', () => {
      const result = resolveTriggeredAgents({
        sender: sender('lumen'),
        sbParticipants: participants,
        creator: SYSTEM,
      });
      expect(result).toEqual(sbs('wren', 'aster', 'myra'));
    });
  });

  describe('actionable message types in group threads', () => {
    const participants = sbs('wren', 'lumen', 'aster', 'myra');

    it('should trigger recipients when creator sends task_request', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        messageType: 'task_request',
        recipients: ids(sbs('lumen')),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('should trigger all other participants when creator sends task_request without explicit recipients', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        messageType: 'task_request',
      });
      expect(result).toEqual(sbs('lumen', 'aster', 'myra'));
    });

    it('should trigger recipients when creator sends session_resume', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: participants,
        creator: sender('wren'),
        messageType: 'session_resume',
        recipients: ids(sbs('aster')),
      });
      expect(result).toEqual(sbs('aster'));
    });

    it('should filter recipients to actual participants only', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        messageType: 'task_request',
        recipients: ids(sbs('lumen', 'aster')), // aster is not a participant
      });
      expect(result).toEqual(sbs('lumen'));
    });
  });

  describe('self-thread (1 participant)', () => {
    it('should trigger no one for plain messages', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
      });
      expect(result).toEqual([]);
    });

    it('should trigger self for session_resume (strategy self-trigger)', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
        messageType: 'session_resume',
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should trigger self for task_request', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
        messageType: 'task_request',
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should not trigger self for notification', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
        messageType: 'notification',
      });
      expect(result).toEqual([]);
    });
  });

  describe('triggerAll override', () => {
    it('should trigger all participants except sender', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen', 'aster', 'myra'),
        creator: sender('wren'),
        triggerAll: true,
      });
      expect(result).toEqual(sbs('lumen', 'aster', 'myra'));
    });

    it('should work in 1:1 threads', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        triggerAll: true,
      });
      expect(result).toEqual(sbs('lumen'));
    });
  });

  describe('triggerAgents override', () => {
    it('should trigger only specified participants', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen', 'aster', 'myra'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('lumen')),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('should silently ignore non-participants', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('aster', 'lumen')),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('should not trigger the sender even if listed', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen', 'aster'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('wren', 'lumen')),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('should take precedence over triggerAll', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen', 'aster', 'myra'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('aster')),
        triggerAll: true,
      });
      // triggerAgents takes precedence (spec: triggerAgents > triggerAll > default)
      expect(result).toEqual(sbs('aster'));
    });
  });

  describe('cross-studio self-messaging (selfStudioTarget)', () => {
    it('should trigger sender on self-thread when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
        selfStudioTarget: true,
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should NOT trigger sender on self-thread when selfStudioTarget is false', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren'),
        creator: sender('wren'),
        selfStudioTarget: false,
      });
      expect(result).toEqual([]);
    });

    it('should include sender in triggerAll when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        triggerAll: true,
        selfStudioTarget: true,
      });
      expect(result).toEqual(sbs('wren', 'lumen'));
    });

    it('should include sender in explicit triggerAgents when selfStudioTarget is true', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('wren')),
        selfStudioTarget: true,
      });
      expect(result).toEqual(sbs('wren'));
    });

    it('should still exclude sender from explicit triggerAgents without selfStudioTarget', () => {
      const result = resolveTriggeredAgents({
        sender: sender('wren'),
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
        triggerAgents: ids(sbs('wren')),
      });
      expect(result).toEqual([]);
    });
  });

  describe('a person or the system as sender (§7: never spawned, never "self")', () => {
    it("a person's reply wakes every SB participant", () => {
      const result = resolveTriggeredAgents({
        sender: PERSON,
        sbParticipants: sbs('wren', 'lumen'),
        creator: sender('wren'),
      });
      expect(result).toEqual(sbs('wren', 'lumen'));
    });

    it("a person's reply is never narrowed by addressed recipients — every SB hears (§7; Lumen, #618)", () => {
      // Addressing narrows a thread START, which the creation branch handles
      // before this function is ever called; on an existing thread the
      // addressed list is whatever the caller happened to pass, and the
      // person's reply must reach every SB regardless.
      const result = resolveTriggeredAgents({
        sender: PERSON,
        sbParticipants: sbs('wren', 'lumen', 'aster'),
        creator: PERSON,
        recipients: ids(sbs('lumen')),
      });
      expect(result).toEqual(sbs('wren', 'lumen', 'aster'));
    });

    it('an explicit wake list that was given but resolves to nobody wakes nobody — never the defaults (Lumen, #618)', () => {
      expect(
        resolveTriggeredAgents({
          sender: sender('wren'),
          sbParticipants: sbs('wren', 'lumen', 'aster'),
          creator: sender('wren'),
          recipients: ids(sbs('lumen')),
          triggerAgents: [],
        })
      ).toEqual([]);
      expect(
        resolveTriggeredAgents({
          sender: PERSON,
          sbParticipants: sbs('wren', 'lumen'),
          creator: PERSON,
          triggerAgents: [],
        })
      ).toEqual([]);
    });

    it('explicit triggerAgents from a person are honoured, filtered to SB participants', () => {
      const result = resolveTriggeredAgents({
        sender: PERSON,
        sbParticipants: sbs('wren', 'lumen'),
        creator: PERSON,
        triggerAgents: ids(sbs('lumen', 'benson')),
      });
      expect(result).toEqual(sbs('lumen'));
    });

    it('the system wakes every SB participant unless it addresses some', () => {
      expect(
        resolveTriggeredAgents({
          sender: SYSTEM,
          sbParticipants: sbs('wren', 'lumen'),
          creator: sender('wren'),
        })
      ).toEqual(sbs('wren', 'lumen'));
      expect(
        resolveTriggeredAgents({
          sender: SYSTEM,
          sbParticipants: sbs('wren', 'lumen'),
          creator: sender('wren'),
          recipients: ids(sbs('lumen')),
        })
      ).toEqual(sbs('lumen'));
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

// Identity resolution is a boundary these handler tests do not exercise:
// every slug resolves to the identity `sb-<slug>` in workspace 'ws-1', owned
// by the resolved user. The resolvers themselves are covered where the real
// tables are (the DB-tier suites). Column helpers stay real.
vi.mock('../../services/principals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/principals')>();
  const sbOf = (agentId: string) => ({
    kind: 'sb' as const,
    sbId: `sb-${agentId}`,
    agentId,
    userId: 'user-123',
    workspaceId: 'ws-1',
  });
  return {
    ...actual,
    resolveSbInWorkspace: vi.fn(async (_c: unknown, _ws: string, agentId: string) => sbOf(agentId)),
    resolveSbsInWorkspace: vi.fn(async (_c: unknown, _ws: string, agentIds: string[]) =>
      agentIds.map(sbOf)
    ),
    resolveSbById: vi.fn(async (_c: unknown, sbId: string) => sbOf(sbId.replace(/^sb-/, ''))),
    resolveSbsByIds: vi.fn(async (_c: unknown, sbIds: string[]) =>
      sbIds.map((id) => sbOf(id.replace(/^sb-/, '')))
    ),
    workspaceOfSb: vi.fn(async () => 'ws-1'),
    personalWorkspaceOf: vi.fn(async () => 'ws-1'),
  };
});
vi.mock('./caller-principal', () => ({
  resolveCallerSb: vi.fn(async (_c: unknown, userId: string, agentId: string) => ({
    kind: 'sb',
    sbId: `sb-${agentId}`,
    agentId,
    userId,
    workspaceId: 'ws-1',
  })),
  resolveCallerWorkspace: vi.fn(async (_c: unknown, userId: string, agentId?: string | null) => ({
    workspaceId: 'ws-1',
    sb: agentId
      ? { kind: 'sb', sbId: `sb-${agentId}`, agentId, userId, workspaceId: 'ws-1' }
      : null,
  })),
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
    sender_kind: 'sb',
    sender_sb_id: 'sb-wren',
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
    workspace_id: 'ws-1',
    created_by_kind: 'sb',
    created_by_sb_id: 'sb-wren',
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

    // Should trigger lumen and aster (not wren — sender), each named by its
    // canonical identity beside the slug (spec inkmail-thread-scope §1a).
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledTimes(2);
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'lumen',
        toSbId: 'sb-lumen',
        threadKey: 'spec:test',
        threadMessageId: 'tmsg-123',
      })
    );
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        toAgentId: 'aster',
        toSbId: 'sb-aster',
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
  sender_kind: string;
  sender_sb_id: string | null;
  sender_agent_id: string | null;
  content: string;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function guardMsg(id: string, ageHours: number): GuardMsg {
  return {
    id,
    created_at: hoursAgo(ageHours),
    message_type: 'message',
    sender_kind: 'sb',
    sender_sb_id: 'sb-lumen',
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
          workspace_id: 'ws-1',
          title: null,
          status: 'open',
          created_by_kind: 'sb',
          created_by_sb_id: 'sb-lumen',
        });
      case 'inbox_thread_participants':
        return simpleRow({
          sb_id: 'sb-wren',
          user_id: null,
          session_id: null,
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

describe('handleCloseThread — lease/teardown wiring (v18 S2)', () => {
  it('feeds the studios the lease rode into teardown as candidates (Lumen r1 P1-2)', async () => {
    // The candidates line is one argument in one call — exactly the kind of
    // wiring that dies silently behind green unit tests on either side of
    // it. This drives the real handler and asserts the hand-off.
    const { handleCloseThread } = await import('./thread-handlers');
    const { StudioLeaseService } = await import('../../services/studio-lease.service.js');
    const { StudioOverflowService } = await import('../../services/studio-overflow.service.js');
    const userResolver = await import('../../services/user-resolver');
    const { makeFakeSupabase } = await import('../../services/sessions/fake-supabase.js');

    const resolveSpy = vi
      .spyOn(userResolver, 'resolveUserOrThrow')
      .mockResolvedValue({ user: { id: 'user-1' } } as never);
    const releaseSpy = vi
      .spyOn(StudioLeaseService.prototype, 'releaseByThread')
      .mockResolvedValue({ released: 0, deferred: 0, removed: 1, studioIds: ['eph-1'] });
    const teardownSpy = vi
      .spyOn(StudioOverflowService.prototype, 'teardownEphemeralStudiosForThread')
      .mockResolvedValue(0);

    const tables = {
      inbox_threads: [
        {
          id: 't1',
          workspace_id: 'ws-1',
          thread_key: 'pr:9',
          status: 'open',
          created_by_kind: 'sb',
          created_by_sb_id: 'sb-wren',
        },
      ],
      inbox_thread_participants: [{ thread_id: 't1', workspace_id: 'ws-1', sb_id: 'sb-wren' }],
      inbox_thread_messages: [],
    };
    const supabase = makeFakeSupabase(tables);
    const dataComposer = {
      getClient: () => supabase,
      repositories: { studios: {} },
    } as never;

    try {
      const result = await handleCloseThread({ threadKey: 'pr:9', agentId: 'wren' }, dataComposer);
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);

      expect(releaseSpy).toHaveBeenCalledWith('user-1', 'pr:9', { reason: 'thread-closed' });
      expect(teardownSpy).toHaveBeenCalledWith('user-1', 'pr:9', {
        reason: 'thread pr:9 closed',
        candidateStudioIds: ['eph-1'],
      });
    } finally {
      resolveSpy.mockRestore();
      releaseSpy.mockRestore();
      teardownSpy.mockRestore();
    }
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

/**
 * reopen_thread — spec inkmail-thread-scope §2, §6.
 *
 * Reopening is explicit: a reply into a closed thread never reopens it, and
 * these tests drive the tool that does. What they pin is the shape of the
 * write (status, both closure fields, and the audit event move together),
 * who may ask (a participant, same rule as close), and that a reopen which
 * loses a race writes nothing. The flip and the audit event are one SQL
 * function (reopen_inbox_thread, migration 20260913083000); the fake client
 * mirrors it, and thread-reopen.integration.test.ts pins the real one —
 * including that a rejected audit event rolls the flip back.
 */
describe('handleReopenThread — explicit reopen (spec inkmail-thread-scope §2)', () => {
  async function setup(opts: { status?: string; participants?: string[] } = {}) {
    const { handleReopenThread, reopenThreadRow } = await import('./thread-handlers');
    const userResolver = await import('../../services/user-resolver');
    const { StudioLeaseService } = await import('../../services/studio-lease.service.js');
    const { makeFakeSupabase } = await import('../../services/sessions/fake-supabase.js');

    const resolveSpy = vi
      .spyOn(userResolver, 'resolveUserOrThrow')
      .mockResolvedValue({ user: { id: 'user-1' } } as never);
    const releaseSpy = vi.spyOn(StudioLeaseService.prototype, 'releaseByThread');

    const closed = (opts.status ?? 'closed') === 'closed';
    const tables = {
      inbox_threads: [
        {
          id: 't1',
          workspace_id: 'ws-1',
          thread_key: 'pr:9',
          status: closed ? 'closed' : 'open',
          closed_at: closed ? '2026-09-01T00:00:00Z' : null,
          closed_by_kind: closed ? 'sb' : null,
          closed_by_sb_id: closed ? 'sb-lumen' : null,
          closed_by_user_id: null,
          created_by_kind: 'sb',
          created_by_sb_id: 'sb-wren',
        },
      ],
      inbox_thread_participants: (opts.participants ?? ['wren', 'lumen']).map((agentId) => ({
        thread_id: 't1',
        workspace_id: 'ws-1',
        sb_id: `sb-${agentId}`,
      })),
      inbox_thread_messages: [] as Array<Record<string, unknown>>,
      agent_identities: ['wren', 'lumen'].map((agentId) => ({
        id: `sb-${agentId}`,
        agent_id: agentId,
        user_id: 'user-1',
        workspace_id: 'ws-1',
      })),
    };
    const supabase = makeFakeSupabase(tables);
    const dataComposer = { getClient: () => supabase, repositories: {} } as never;
    const call = async (agentId: string) => {
      const result = await handleReopenThread({ threadKey: 'pr:9', agentId }, dataComposer);
      return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    };
    const restore = () => {
      resolveSpy.mockRestore();
      releaseSpy.mockRestore();
    };
    return { call, tables, supabase, reopenThreadRow, releaseSpy, restore };
  }

  it('a participant reopens: status open, both closure fields cleared, one system audit event, nobody woken', async () => {
    const { call, tables, releaseSpy, restore } = await setup();
    try {
      const payload = await call('wren');
      expect(payload).toMatchObject({ success: true, threadKey: 'pr:9', reopenedBy: 'wren' });
      expect(payload.alreadyOpen).toBeUndefined();

      const thread = tables.inbox_threads[0];
      expect(thread.status).toBe('open');
      expect(thread.closed_at).toBeNull();
      expect(thread.closed_by_kind).toBeNull();
      expect(thread.closed_by_sb_id).toBeNull();
      expect(thread.closed_by_user_id).toBeNull();

      // Exactly one row landed, and it is an audit event — not a deliverable
      // message that would count as unread or wake anyone. The system says so
      // by kind and borrows nobody's identity (§3).
      expect(tables.inbox_thread_messages).toHaveLength(1);
      expect(tables.inbox_thread_messages[0]).toMatchObject({
        thread_id: 't1',
        sender_kind: 'system',
        sender_sb_id: null,
        sender_user_id: null,
        sender_agent_id: null,
        message_type: 'system',
        metadata: { type: 'thread_reopened', reopenedBySbId: 'sb-wren' },
      });
      // Close releases studio leases; reopen touches none of that.
      expect(releaseSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('a non-participant is refused and nothing changes', async () => {
    const { call, tables, restore } = await setup({ participants: ['lumen'] });
    try {
      const payload = await call('wren');
      expect(payload.success).toBe(false);
      expect(String(payload.error)).toMatch(/not a participant/);
      expect(tables.inbox_threads[0]).toMatchObject({
        status: 'closed',
        closed_at: '2026-09-01T00:00:00Z',
        closed_by_kind: 'sb',
        closed_by_sb_id: 'sb-lumen',
      });
      expect(tables.inbox_thread_messages).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('an open thread answers alreadyOpen and records no event', async () => {
    const { call, tables, restore } = await setup({ status: 'open' });
    try {
      const payload = await call('wren');
      expect(payload).toMatchObject({ success: true, alreadyOpen: true });
      expect(tables.inbox_thread_messages).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('the flip is guarded on the row still being closed: a second reopen writes nothing', async () => {
    // Two callers can both read "closed" and both try to write. The UPDATE
    // itself carries the guard, so only one of them records the event.
    const { supabase, tables, reopenThreadRow, restore } = await setup();
    try {
      expect(
        await reopenThreadRow(supabase as never, 't1', { kind: 'sb', sbId: 'sb-wren' })
      ).toEqual({ reopened: true });
      expect(
        await reopenThreadRow(supabase as never, 't1', { kind: 'user', userId: 'user-1' })
      ).toEqual({ reopened: false });
      expect(tables.inbox_thread_messages).toHaveLength(1);
      expect(tables.inbox_thread_messages[0]).toMatchObject({
        metadata: { type: 'thread_reopened', reopenedBySbId: 'sb-wren' },
      });
    } finally {
      restore();
    }
  });

  it("a person's recovery is recorded as that person, not as an SB", async () => {
    const { supabase, tables, reopenThreadRow, restore } = await setup();
    try {
      await reopenThreadRow(supabase as never, 't1', { kind: 'user', userId: 'user-1' });
      expect(tables.inbox_thread_messages[0]).toMatchObject({
        sender_kind: 'system',
        sender_agent_id: null,
        message_type: 'system',
        metadata: { type: 'thread_reopened', reopenedByUserId: 'user-1' },
      });
    } finally {
      restore();
    }
  });
});

describe('reopenThreadRow — a failed call is an error, never a silent success', () => {
  // The flip and the audit event are one SQL function now (migration
  // 20260913083000); the client sees one reply. An error reply throws, and a
  // reply that is not the function's boolean throws too — a mocked or
  // unmigrated client must not be read as "reopened".
  const rpcClient = (reply: { data: unknown; error: { message: string } | null }) => ({
    rpc: async () => reply,
  });

  it('propagates an RPC error', async () => {
    const { reopenThreadRow } = await import('./thread-handlers');
    await expect(
      reopenThreadRow(
        rpcClient({ data: null, error: { message: 'audit rejected' } }) as never,
        't1',
        { kind: 'user', userId: 'user-1' }
      )
    ).rejects.toThrow('Failed to reopen thread: audit rejected');
  });

  it('refuses a reply that is not the boolean the function returns', async () => {
    const { reopenThreadRow } = await import('./thread-handlers');
    await expect(
      reopenThreadRow(rpcClient({ data: null, error: null }) as never, 't1', {
        kind: 'sb',
        sbId: 'sb-wren',
      })
    ).rejects.toThrow('Failed to reopen thread: unexpected reply null');
  });

  it('passes the actor to the function as a principal — exactly one id set', async () => {
    const { reopenThreadRow } = await import('./thread-handlers');
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        return { data: true, error: null };
      },
    };
    expect(await reopenThreadRow(client as never, 't1', { kind: 'sb', sbId: 'sb-wren' })).toEqual({
      reopened: true,
    });
    expect(
      await reopenThreadRow(client as never, 't1', { kind: 'user', userId: 'user-1' })
    ).toEqual({ reopened: true });
    expect(calls).toEqual([
      [
        'reopen_inbox_thread',
        { p_thread_id: 't1', p_actor_sb_id: 'sb-wren', p_actor_user_id: null },
      ],
      [
        'reopen_inbox_thread',
        { p_thread_id: 't1', p_actor_sb_id: null, p_actor_user_id: 'user-1' },
      ],
    ]);
  });
});

describe('dispatchTriggers names the target by identity (spec inkmail-thread-scope §1a)', () => {
  it('every payload carries toSbId beside the slug', async () => {
    const { dispatchTriggers } = await import('./thread-handlers');
    const { getAgentGateway } = await import('../../channels/agent-gateway.js');
    const mockGateway = (getAgentGateway as ReturnType<typeof vi.fn>)();
    (mockGateway.dispatchTrigger as ReturnType<typeof vi.fn>).mockClear();

    dispatchTriggers(
      [
        { sbId: 'sb-lumen', agentId: 'lumen' },
        { sbId: 'sb-aster', agentId: 'aster' },
      ],
      { fromAgentId: 'wren', threadKey: 'pr:1', summary: 's', priority: 'normal', threadId: 't1' }
    );

    expect(mockGateway.dispatchTrigger).toHaveBeenCalledTimes(2);
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ toAgentId: 'lumen', toSbId: 'sb-lumen', threadId: 't1' })
    );
    expect(mockGateway.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ toAgentId: 'aster', toSbId: 'sb-aster', threadId: 't1' })
    );
  });
});
