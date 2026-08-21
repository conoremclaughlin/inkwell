/**
 * Memory Handler Tests
 *
 * Tests for MCP tool schemas and handlers related to sessions,
 * session phases, and the unified update_session_state tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startSessionSchema,
  listSessionsSchema,
  updateSessionStateSchema,
  handleUpdateSessionState,
  handleStartSession,
  handleGetSession,
  handleCompactSession,
  handleEndSession,
  curateRecallSchema,
  handleCurateRecall,
  mapSessionForBootstrap,
  isCallerSessionEligible,
} from './memory-handlers';
import {
  getPinnedAgentId,
  getRequestContext,
  getSessionContext,
} from '../../utils/request-context';

// =====================================================
// MOCK SETUP
// =====================================================

// Mock user-resolver: preserve the real schema but mock resolveUserOrThrow
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

// Mock request-context
vi.mock('../../utils/request-context', () => ({
  setSessionContext: vi.fn(),
  getSessionContext: vi.fn().mockReturnValue(undefined),
  pinSessionAgent: vi.fn(),
  getPinnedAgentId: vi.fn().mockReturnValue(null),
  getRequestContext: vi.fn().mockReturnValue(undefined),
}));

// Mock cloud skills
vi.mock('../../skills/cloud-service', () => ({
  getCloudSkillsService: vi.fn().mockReturnValue({
    loadUserSkills: vi.fn().mockResolvedValue([]),
  }),
}));

/**
 * Creates a mock DataComposer with repositories.
 * Repositories use vi.fn() so each test can configure return values.
 */
function createMockDataComposer() {
  const mockMemoryRepo = {
    getActiveSession: vi.fn(),
    findOwnedActiveSessions: vi.fn().mockResolvedValue([]),
    getActiveSessionByThreadKey: vi.fn(),
    updateSession: vi.fn(),
    remember: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    recall: vi.fn(),
    addSessionLog: vi.fn(),
    getSessionLogs: vi.fn(),
    verifyOwnership: vi.fn().mockResolvedValue(new Set()),
    verifySessionOwnership: vi.fn().mockResolvedValue(true),
  };

  const mockProjectsRepo = {
    findAllByUser: vi.fn(),
  };

  const mockProjectTasksRepo = {
    create: vi.fn(),
  };

  const mockActivityStreamRepo = {
    logActivity: vi.fn().mockResolvedValue({
      id: 'activity-123',
      type: 'state_change',
      agentId: 'wren',
      createdAt: new Date('2026-02-10T10:00:00Z'),
    }),
  };

  const mockRecallFeedbackRepo = {
    saveFeedback: vi.fn().mockResolvedValue(0),
    getDismissalCount: vi.fn().mockResolvedValue(0),
  };

  return {
    getClient: vi.fn(),
    repositories: {
      memory: mockMemoryRepo,
      projects: mockProjectsRepo,
      tasks: mockProjectTasksRepo,
      activityStream: mockActivityStreamRepo,
      recallFeedback: mockRecallFeedbackRepo,
    },
  };
}

// vi.clearAllMocks() resets recorded calls but NOT implementations, so a
// mockReturnValue set inside one describe would otherwise persist into every
// later describe in the file. Restore the module defaults before each test;
// suites that need a pinned identity opt in via their own beforeEach.
beforeEach(() => {
  callerIsAnonymous();
});

// =====================================================
// IDENTITY HELPERS
//
// Authorization reads the VERIFIED request identity, so tests have to model
// how a caller actually authenticated rather than just pinning a slug. The
// earlier suite set getPinnedAgentId() to 'wren' and left the request context
// undefined, which is the stdio shape — that hid every HTTP path, where the
// pin is null and the token carries the identity (Lumen, PR #501 round 2).
// =====================================================

/**
 * An agent-bound bearer token: the shape the HTTP MCP server produces for
 * every SB. Note getPinnedAgentId() is null here — that is the real HTTP
 * condition, and the path the old suite never exercised.
 */
function callerIsAgent(
  agentId: string,
  sbId?: string,
  ctxExtra: Record<string, unknown> = {}
): void {
  vi.mocked(getPinnedAgentId).mockReturnValue(null);
  vi.mocked(getSessionContext).mockReturnValue(undefined as never);
  vi.mocked(getRequestContext).mockReturnValue({
    userId: 'user-123',
    agentTokenBound: true,
    tokenAgentId: agentId,
    ...(sbId ? { tokenSbId: sbId } : {}),
    agentId,
    ...(sbId ? { sbId } : {}),
    callerProfile: 'agent',
    timestamp: new Date(),
    ...ctxExtra,
  } as never);
}

/**
 * A runner token the server minted FOR a specific session and contact — the
 * signed binding. `headerSessionId` models what the caller puts in the
 * unsigned x-ink-context header, which may disagree with the claim.
 */
function callerIsRunner(
  agentId: string,
  sbId: string,
  binding: { sessionId?: string; contactId?: string },
  headerSessionId?: string
): void {
  callerIsAgent(agentId, sbId, {
    ...(binding.sessionId ? { tokenSessionId: binding.sessionId } : {}),
    ...(binding.contactId ? { tokenContactId: binding.contactId } : {}),
    ...(headerSessionId ? { sessionId: headerSessionId } : {}),
  });
}

/** A stdio caller: no request context, identity from the bootstrap pin. */
function callerIsStdioAgent(agentId: string, sbId?: string): void {
  vi.mocked(getRequestContext).mockReturnValue(undefined);
  vi.mocked(getPinnedAgentId).mockReturnValue(agentId);
  vi.mocked(getSessionContext).mockReturnValue({ agentId, sbId } as never);
}

/**
 * A human user/admin token. callerProfile is 'agent' deliberately: the HTTP
 * server sets that on every request, so it must not be read as "authenticated
 * as an agent".
 */
function callerIsUserToken(ctxExtra: Record<string, unknown> = {}): void {
  vi.mocked(getPinnedAgentId).mockReturnValue(null);
  vi.mocked(getSessionContext).mockReturnValue(undefined as never);
  vi.mocked(getRequestContext).mockReturnValue({
    userId: 'user-123',
    callerProfile: 'agent',
    timestamp: new Date(),
    ...ctxExtra,
  } as never);
}

/**
 * A permissive chainable stand-in for the Supabase client. end_session's
 * success path releases the studio lease and clears channel_routes, neither of
 * which this suite is testing — it only needs them not to throw.
 */
function chainableClient(): never {
  const make = (): never =>
    new Proxy(function () {} as never, {
      get: (_t, prop) =>
        // Terminating a PostgREST chain resolves to { data, error }; the
        // handler calls .then() on it directly, so this has to be a real
        // function rather than another link in the chain.
        prop === 'then'
          ? (resolve: (v: unknown) => unknown) =>
              Promise.resolve(resolve({ data: null, error: null }))
          : make(),
      apply: () => make(),
    }) as never;
  return make();
}

/** No identity at all. */
function callerIsAnonymous(): void {
  vi.mocked(getPinnedAgentId).mockReturnValue(null);
  vi.mocked(getSessionContext).mockReturnValue(undefined as never);
  vi.mocked(getRequestContext).mockReturnValue(undefined);
}

// =====================================================
// SCHEMA TESTS
// =====================================================

describe('startSessionSchema', () => {
  it('should accept studioId as optional UUID', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      studioId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.studioId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should accept request without studioId', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.studioId).toBeUndefined();
    }
  });

  it('should accept non-UUID studioId (e.g. "main")', () => {
    // studioId accepts any string; non-UUID values like "main" are filtered
    // by isStudioUuid() before reaching DB queries — see handleStartSession.
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      studioId: 'main',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.studioId).toBe('main');
    }
  });

  it('should still require user identification', () => {
    const result = startSessionSchema.safeParse({
      agentId: 'wren',
      studioId: '550e8400-e29b-41d4-a716-446655440000',
    });

    // The base schema allows resolution by userId, email, phone, or platform+platformId
    // With none of these, it should still parse (resolution happens at handler level)
    expect(result.success).toBe(true);
  });

  it('should accept client-provided sessionId and forceNew', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      forceNew: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.data.forceNew).toBe(true);
    }
  });
});

describe('listSessionsSchema', () => {
  it('should accept studioId as optional UUID', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      studioId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.studioId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should accept request without studioId', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.studioId).toBeUndefined();
    }
  });

  it('should accept both agentId and studioId together', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      studioId: '550e8400-e29b-41d4-a716-446655440000',
      limit: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe('wren');
      expect(result.data.studioId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.data.limit).toBe(10);
    }
  });

  it('should reject non-UUID studioId', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      studioId: 'invalid',
    });

    expect(result.success).toBe(false);
  });
});

describe('updateSessionStateSchema', () => {
  it('should accept phase only', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe('implementing');
    }
  });

  it('should accept blocked phase with note', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      phase: 'blocked:awaiting-user-approval',
      note: 'Need approval on approach C before proceeding',
      createTask: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe('blocked:awaiting-user-approval');
      expect(result.data.note).toBe('Need approval on approach C before proceeding');
      expect(result.data.createTask).toBe(true);
    }
  });

  it('should accept backendSessionId without phase (metadata-only update)', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      backendSessionId: 'claude-session-abc123',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backendSessionId).toBe('claude-session-abc123');
      expect(result.data.phase).toBeUndefined();
    }
  });

  it('should accept all unified fields together', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      phase: 'implementing',
      backendSessionId: 'claude-session-abc123',
      status: 'active',
      context: 'Working on session phase tests',
      workingDir: '/Users/test/project',
      agentId: 'wren',
      studioId: '550e8400-e29b-41d4-a716-446655440099',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe('implementing');
      expect(result.data.backendSessionId).toBe('claude-session-abc123');
      expect(result.data.status).toBe('active');
      expect(result.data.context).toBe('Working on session phase tests');
      expect(result.data.workingDir).toBe('/Users/test/project');
    }
  });

  it('should accept status enum values', () => {
    for (const status of ['active', 'paused', 'resumable', 'completed']) {
      const result = updateSessionStateSchema.safeParse({
        email: 'test@test.com',
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status enum values', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      status: 'invalid-status',
    });
    expect(result.success).toBe(false);
  });

  it('should accept sessionId as optional UUID', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      phase: 'reviewing',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should reject non-UUID sessionId', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      sessionId: 'not-a-uuid',
      phase: 'implementing',
    });
    expect(result.success).toBe(false);
  });

  it('should accept free-text phase values (extensible)', () => {
    const result = updateSessionStateSchema.safeParse({
      email: 'test@test.com',
      phase: 'waiting:ci-pipeline-completion',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe('waiting:ci-pipeline-completion');
    }
  });
});

// =====================================================
// HANDLER TESTS
// =====================================================

describe('handleUpdateSessionState', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  const mockSession = {
    id: 'session-123',
    email: 'test@test.com',
    userId: 'user-123',
    agentId: 'wren',
    sbId: 'sb-wren',
    studioId: undefined,
    currentPhase: undefined,
    startedAt: new Date('2026-02-10T10:00:00Z'),
    endedAt: undefined,
    summary: undefined,
    metadata: {},
  };

  const mockUpdatedSession = {
    ...mockSession,
    currentPhase: 'implementing',
  };

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
    // clearAllMocks resets calls but NOT implementations, so identity state set
    // by one test would otherwise leak into the next. Restore the defaults:
    // an authenticated agent call, which is what every real caller looks like.
    callerIsAgent('wren', 'sb-wren');
    // Default: the caller owns the session it resolves/names.
    mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([mockSession]);
    mockDataComposer.repositories.memory.getSession.mockResolvedValue(mockSession);
  });

  // ---------------------------------------------------
  // Basic phase updates
  // ---------------------------------------------------

  describe('basic phase updates', () => {
    it('should update phase on active session (auto-resolved)', async () => {
      // The caller's identity comes from the pinned agent when agentId is omitted.
      // It is never omitted from the lookup itself — see the cross-agent
      // isolation suite below for why an unscoped lookup is unsafe.
      callerIsAgent('wren', 'sb-wren');
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('phase → implementing');
      expect(parsed.session.currentPhase).toBe('implementing');

      // Verify repo calls
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'wren' })
      );
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({ currentPhase: 'implementing' })
      );
    });

    it('should update phase on explicitly specified session', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          phase: 'reviewing',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      // Should NOT run a lookup when sessionId is provided
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).not.toHaveBeenCalled();
    });

    it('should update phase with agentId filter for active session lookup', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'investigating', agentId: 'wren' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'wren' })
      );
    });

    it('should log state_change activity with before/after snapshots', async () => {
      const before = {
        ...mockSession,
        currentPhase: 'investigating',
        lifecycle: 'idle',
        status: 'active',
        backendSessionId: null,
      };
      const after = {
        ...mockSession,
        currentPhase: 'implementing',
        lifecycle: 'running',
        status: 'active',
        backendSessionId: 'claude-abc123',
      };
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(before);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(after);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'implementing',
          lifecycle: 'running',
          backendSessionId: 'claude-abc123',
          agentId: 'wren',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sessionTrace.changedFields).toEqual(
        expect.arrayContaining(['currentPhase', 'lifecycle', 'backendSessionId'])
      );

      expect(mockDataComposer.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          agentId: 'wren',
          type: 'state_change',
          subtype: 'session_update',
          sessionId: 'session-123',
        })
      );
    });

    it('should resolve session by studioId when sessionId not provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const studioId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing', agentId: 'wren', studioId },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'wren', studioId })
      );
    });

    it('should prefer sessionId over studioId for resolution', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const studioId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'reviewing', sessionId, studioId },
        mockDataComposer as never
      );

      // When sessionId is provided, no lookup should run
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ currentPhase: 'reviewing' })
      );
    });

    it('should resolve session by studioId', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const studioId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing', agentId: 'wren', studioId },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'wren', studioId })
      );
    });
  });

  // ---------------------------------------------------
  // Cross-agent isolation
  //
  // Regression coverage for the 2026-08-16 incident: myra's heartbeat called
  // update_session_state(context) with no sessionId and the write landed on
  // lumen's pr:500 session, in a different studio. The implicit lookup ran with
  // both agentId and studioId undefined, which the repository turns into "the
  // most recently started open session for this user" — every agent's session.
  // ---------------------------------------------------

  describe('cross-agent isolation', () => {
    /** lumen's session — started most recently, so it wins any unscoped recency query. */
    const lumenSession = {
      ...mockSession,
      id: 'session-lumen-pr500',
      agentId: 'lumen',
      sbId: 'sb-lumen',
      studioId: 'studio-lumen',
      startedAt: new Date('2026-08-15T04:58:11Z'),
    };

    /** myra's own session — long-lived, so it can never win on recency. */
    const myraSession = {
      ...mockSession,
      id: 'session-myra',
      agentId: 'myra',
      sbId: 'sb-myra',
      studioId: 'studio-myra',
      startedAt: new Date('2026-08-05T18:42:09Z'),
    };

    it('scopes the implicit lookup to the calling agent, not to whoever started last', async () => {
      callerIsAgent('myra', 'sb-myra');
      // Stand in for the real query: only myra's own session may come back once
      // the agent filter is applied. An unscoped call would surface lumen's.
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockImplementation(
        async (p: { agentId?: string }) => (p.agentId === 'myra' ? [myraSession] : [lumenSession])
      );
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', context: 'myra heartbeat notes' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'myra' })
      );
      // The write must land on myra's row, never lumen's.
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-myra',
        expect.objectContaining({ context: 'myra heartbeat notes' })
      );
    });

    it('fails closed when no agent identity can be established', async () => {
      callerIsAnonymous();
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(lumenSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', context: 'anonymous write' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/no agent identity/i);
      // Critically: no unscoped query, and no write at all.
      expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('targets the session named by the request context without a recency query', async () => {
      callerIsAgent('myra', 'sb-myra', { sessionId: 'session-myra' });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...myraSession,
        userId: 'user-123',
      });
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      await handleUpdateSessionState(
        { email: 'test@test.com', context: 'from my own session' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-myra',
        expect.objectContaining({ context: 'from my own session' })
      );
    });

    it('ignores a context sessionId that belongs to another agent', async () => {
      // A token naming lumen's session — the server skips context-session
      // enrichment for agent-bound tokens, so this is not pre-validated.
      callerIsAgent('myra', 'sb-myra', { sessionId: 'session-lumen-pr500' });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...lumenSession,
        userId: 'user-123',
      });
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([myraSession]);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      await handleUpdateSessionState(
        { email: 'test@test.com', context: 'should not reach lumen' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-myra',
        expect.anything()
      );
    });

    // The first version of this fix asserted the opposite here — that an
    // explicit sessionId may target a peer, as "deliberate repair". That test
    // enshrined an IDOR: updateSession filters on the primary key alone and the
    // repository runs as the service role, so a bare UUID reached any session,
    // including another user's. Naming a session is not authorization.
    it('denies an explicit sessionId belonging to another agent', async () => {
      callerIsAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...lumenSession,
        userId: 'user-123',
        sbId: 'sb-lumen',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: '95f7f160-6599-449d-9f63-e31ca20a43ce',
          context: '[marker explaining the clobber]',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/not authorized/i);
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('denies an explicit sessionId belonging to another user', async () => {
      callerIsAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...myraSession,
        userId: 'someone-else',
        sbId: 'sb-myra',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: '95f7f160-6599-449d-9f63-e31ca20a43ce',
          context: 'cross-user write',
        },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(false);
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('allows an explicit sessionId for the caller`s own session', async () => {
      callerIsAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...myraSession,
        userId: 'user-123',
      });
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: '95f7f160-6599-449d-9f63-e31ca20a43ce',
          context: 'my own note',
        },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('distinguishes same-slug identities in different workspaces by sbId', async () => {
      // agent_identities is unique on (user_id, workspace_id, agent_id), so the
      // slug alone cannot be an ownership predicate.
      callerIsAgent('wren', 'sb-wren-workspace-a', { sessionId: 'session-wren-b' });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...mockSession,
        id: 'session-wren-b',
        userId: 'user-123',
        agentId: 'wren',
        sbId: 'sb-wren-workspace-b',
      });
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([]);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', context: 'must not cross workspaces' },
        mockDataComposer as never
      );

      // The context session is rejected, and the scoped lookup uses sbId.
      expect(JSON.parse(result.content[0].text).success).toBe(false);
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sbId: 'sb-wren-workspace-a' })
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('refuses to guess when one identity has sessions in several studios', async () => {
      callerIsAgent('wren', 'sb-wren');
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([
        { ...mockSession, id: 'session-studio-a', studioId: 'studio-a' },
        { ...mockSession, id: 'session-studio-b', studioId: 'studio-b' },
      ]);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', context: 'which worktree?' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/ambiguous/i);
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // Unified session fields
  // ---------------------------------------------------

  describe('unified session fields', () => {
    it('should update backendSessionId', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.listSessions.mockResolvedValue([mockSession]);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', backendSessionId: 'claude-abc123' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('backendSessionId set');

      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({ backendSessionId: 'claude-abc123' })
      );
    });

    it('should report conflict when backendSessionId is already linked to another agent session', async () => {
      const conflictSession = {
        ...mockSession,
        id: 'session-999',
        agentId: 'myra',
        backendSessionId: 'claude-abc123',
      };
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.listSessions.mockResolvedValue([
        conflictSession,
        mockSession,
      ]);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        backendSessionId: 'claude-abc123',
      });

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', backendSessionId: 'claude-abc123', agentId: 'wren' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sessionConflict).toEqual(
        expect.objectContaining({
          backendSessionId: 'claude-abc123',
          conflictingSessionId: 'session-999',
          conflictingAgentId: 'myra',
        })
      );
      expect(mockDataComposer.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          subtype: 'session_backend_conflict',
          sessionId: 'session-123',
        })
      );
    });

    it('should update status', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', status: 'resumable' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('status → resumable');
    });

    it('should update context and workingDir', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          context: 'Writing tests for session phase',
          workingDir: '/Users/test/project',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('context updated');
      expect(parsed.message).toContain('workingDir updated');
    });

    it('should update all fields at once', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'implementing',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'implementing',
          backendSessionId: 'claude-abc123',
          status: 'active',
          context: 'Building feature X',
          workingDir: '/Users/test/project',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-123',
        {
          currentPhase: 'implementing',
          backendSessionId: 'claude-abc123',
          status: 'active',
          context: 'Building feature X',
          workingDir: '/Users/test/project',
        }
      );
    });
  });

  // ---------------------------------------------------
  // Auto-memory on significant phase transitions
  // ---------------------------------------------------

  describe('auto-memory on significant transitions', () => {
    it('should create memory for blocked: phase', async () => {
      const blockedSession = { ...mockSession, currentPhase: 'blocked:awaiting-approval' };
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(blockedSession);
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-456',
        content: '[blocked:awaiting-approval] Need user approval on design',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'blocked:awaiting-approval',
          note: 'Need user approval on design',
          agentId: 'wren',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.memoryCreated).toBeDefined();
      expect(parsed.memoryCreated.id).toBe('memory-456');
      expect(parsed.memoryCreated.content).toContain('blocked:awaiting-approval');
      expect(parsed.memoryCreated.content).toContain('Need user approval on design');

      // Verify memory creation (handler uses resolved user.id, not email)
      expect(mockDataComposer.repositories.memory.remember).toHaveBeenCalledWith({
        userId: 'user-123',
        content: '[blocked:awaiting-approval] Need user approval on design',
        source: 'session',
        salience: 'high',
        topics: ['session-phase', 'blocked'],
        metadata: { sessionId: 'session-123', phase: 'blocked:awaiting-approval' },
        agentId: 'wren',
      });
    });

    it('should create memory for waiting: phase', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'waiting:ci-pipeline',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-789',
        content: '[waiting:ci-pipeline] CI pipeline running for PR #42',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'waiting:ci-pipeline',
          note: 'CI pipeline running for PR #42',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.memoryCreated).toBeDefined();
      expect(parsed.memoryCreated.content).toContain('waiting:ci-pipeline');

      expect(mockDataComposer.repositories.memory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          topics: ['session-phase', 'waiting'],
          salience: 'high',
        })
      );
    });

    it('should NOT create memory for complete phase without outcome detail', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'complete',
      });

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'complete' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.memoryCreated).toBeUndefined();
      expect(mockDataComposer.repositories.memory.remember).not.toHaveBeenCalled();
    });

    it('should create memory for complete phase when outcome detail is provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'complete',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-101',
        content: '[complete] Merged PR #214 after resolving sender-metadata propagation bug.',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'complete',
          note: 'Merged PR #214 after resolving sender-metadata propagation bug.',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.memoryCreated).toBeDefined();
      expect(mockDataComposer.repositories.memory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '[complete] Merged PR #214 after resolving sender-metadata propagation bug.',
        })
      );
    });

    it('should NOT create memory when no note or context is provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:unknown-issue',
      });

      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'blocked:unknown-issue' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.remember).not.toHaveBeenCalled();
    });

    it('should NOT create memory for non-significant phases', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      for (const phase of ['investigating', 'implementing', 'reviewing', 'paused']) {
        vi.clearAllMocks();
        mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
        mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
          ...mockSession,
          currentPhase: phase,
        });

        const result = await handleUpdateSessionState(
          { email: 'test@test.com', phase },
          mockDataComposer as never
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.memoryCreated).toBeUndefined();
        expect(mockDataComposer.repositories.memory.remember).not.toHaveBeenCalled();
      }
    });

    it('should NOT create memory when only non-phase fields are updated', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', backendSessionId: 'abc123', status: 'active' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.memoryCreated).toBeUndefined();
      expect(mockDataComposer.repositories.memory.remember).not.toHaveBeenCalled();
    });

    it('should use session agentId for memory when param agentId not provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:test',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-103',
        content: '[blocked:test] Awaiting review from Wren.',
      });

      await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'blocked:test',
          note: 'Awaiting review from Wren.',
        },
        mockDataComposer as never
      );

      // Should use session's agentId ('wren') since no agentId in params
      expect(mockDataComposer.repositories.memory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'wren',
        })
      );
    });
  });

  // ---------------------------------------------------
  // Auto-task creation
  // ---------------------------------------------------

  describe('auto-task creation', () => {
    it('should create task when createTask=true and phase is blocked', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:awaiting-input',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-104',
        content: 'test',
      });
      mockDataComposer.repositories.projects.findAllByUser.mockResolvedValue([
        { id: 'project-1', name: 'PCP' },
      ]);
      mockDataComposer.repositories.tasks.create.mockResolvedValue({
        id: 'task-1',
        title: '[blocked:awaiting-input] Need user feedback',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'blocked:awaiting-input',
          note: 'Need user feedback',
          createTask: true,
          agentId: 'wren',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskCreated).toBeDefined();
      expect(parsed.taskCreated.id).toBe('task-1');

      expect(mockDataComposer.repositories.tasks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'project-1',
          user_id: 'user-123',
          title: '[blocked:awaiting-input] Need user feedback',
          priority: 'high',
          tags: expect.arrayContaining(['agent-orchestration', 'session-phase', 'wren']),
          created_by: 'wren',
        })
      );
    });

    it('should create task for waiting phase', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'waiting:ci-build',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-105',
        content: 'test',
      });
      mockDataComposer.repositories.projects.findAllByUser.mockResolvedValue([
        { id: 'project-1', name: 'PCP' },
      ]);
      mockDataComposer.repositories.tasks.create.mockResolvedValue({
        id: 'task-2',
        title: '[waiting:ci-build] CI running',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'waiting:ci-build',
          note: 'CI running',
          createTask: true,
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskCreated).toBeDefined();
    });

    it('should NOT create task when createTask=false', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:test',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-106',
        content: 'test',
      });

      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'blocked:test', createTask: false },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.projects.findAllByUser).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.tasks.create).not.toHaveBeenCalled();
    });

    it('should NOT create task for non-blocked/waiting phases even with createTask=true', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing', createTask: true },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.tasks.create).not.toHaveBeenCalled();
    });

    it('should gracefully handle task creation failure', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:test',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-107',
        content: 'test',
      });
      mockDataComposer.repositories.projects.findAllByUser.mockResolvedValue([
        { id: 'project-1', name: 'PCP' },
      ]);
      mockDataComposer.repositories.tasks.create.mockRejectedValue(
        new Error('Database constraint violation')
      );

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'blocked:test', createTask: true },
        mockDataComposer as never
      );

      // Should succeed overall, with a non-fatal task error
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.taskError).toBe('Failed to create task (non-fatal)');
    });

    it('should skip task creation when no projects exist', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:test',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-108',
        content: 'test',
      });
      mockDataComposer.repositories.projects.findAllByUser.mockResolvedValue([]);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'blocked:test', createTask: true },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.taskCreated).toBeUndefined();
      expect(mockDataComposer.repositories.tasks.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // Error handling
  // ---------------------------------------------------

  describe('error handling', () => {
    it('should error when no fields provided', async () => {
      const result = await handleUpdateSessionState(
        { email: 'test@test.com' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('At least one field must be provided');
    });

    it('should error when no active session found', async () => {
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([]);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No active session found');
    });

    it('should error when session not found by ID', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(null);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: '00000000-0000-0000-0000-000000000000',
          phase: 'implementing',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Session not found');
    });
  });

  // ---------------------------------------------------
  // Response message format
  // ---------------------------------------------------

  describe('response message format', () => {
    it('should include all updated fields in message', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'reviewing',
      });

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          phase: 'reviewing',
          status: 'active',
          backendSessionId: 'abc',
          context: 'testing',
          workingDir: '/tmp',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain('phase → reviewing');
      expect(parsed.message).toContain('status → active');
      expect(parsed.message).toContain('backendSessionId set');
      expect(parsed.message).toContain('context updated');
      expect(parsed.message).toContain('workingDir updated');
    });

    it('should include session info in response', async () => {
      const sessionWithWorkspace = {
        ...mockSession,
        studioId: 'workspace-abc',
        currentPhase: 'implementing',
      };
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(sessionWithWorkspace);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.session.id).toBe('session-123');
      expect(parsed.session.agentId).toBe('wren');
      expect(parsed.session.studioId).toBe('workspace-abc');
      expect(parsed.session.currentPhase).toBe('implementing');
    });
  });
});

// =====================================================
// THREAD KEY TESTS
// =====================================================

// =====================================================
// AUTHORIZATION BOUNDARY (PR #501 round 3)
//
// Three gaps Lumen found in round two, each one a way to reach a session the
// caller does not own. They share a shape: an identity check that consults
// something weaker than the verified request identity.
// =====================================================

describe('session authorization boundary', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  const TARGET_UUID = '95f7f160-6599-449d-9f63-e31ca20a43ce';

  /** Lumen's session — the thing a caller must never reach. */
  const lumenSession = {
    id: 'session-lumen',
    userId: 'user-123',
    agentId: 'lumen',
    sbId: 'sb-lumen',
    studioId: 'studio-lumen',
    startedAt: new Date('2026-08-15T04:58:11Z'),
    metadata: {},
  };

  const myraSession = {
    id: 'session-myra',
    userId: 'user-123',
    agentId: 'myra',
    sbId: 'sb-myra',
    startedAt: new Date('2026-08-05T18:42:09Z'),
    metadata: {},
  };

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
    callerIsAgent('myra', 'sb-myra');
    mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([]);
    mockDataComposer.repositories.memory.getSessionLogs.mockResolvedValue([]);
  });

  const denied = (result: { content: Array<{ text: string }> }) => {
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not authorized/i);
  };

  // ---------------------------------------------------
  // Gap 1: authorization bound to the verified request identity
  //
  // getEffectiveAgentId() and the old agentBound flag both consulted the
  // process-global bootstrap pin. On HTTP that pin is null, so an agent-bound
  // bearer resolved to "no identity" and fell through to user/admin authority.
  // ---------------------------------------------------
  describe('binds to the verified request identity, not the bootstrap pin', () => {
    it('denies update_session_state on a peer session when the pin is null', async () => {
      expect(vi.mocked(getPinnedAgentId)()).toBeNull(); // the HTTP condition
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'clobber' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('denies get_session logs on a peer session when the pin is null', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      const result = await handleGetSession(
        { email: 'test@test.com', sessionId: TARGET_UUID, includeLogs: true },
        mockDataComposer as never
      );

      denied(result);
      expect(mockDataComposer.repositories.memory.getSessionLogs).not.toHaveBeenCalled();
    });

    it('denies compact_session on a peer session when the pin is null', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleCompactSession(
          { email: 'test@test.com', sessionId: TARGET_UUID },
          mockDataComposer as never
        )
      );
    });

    it('does not let params.agentId stand in for the request identity', async () => {
      // The old path ran the caller-supplied slug through getEffectiveAgentId(),
      // which returns it verbatim when nothing is pinned.
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleUpdateSessionState(
          {
            email: 'test@test.com',
            sessionId: TARGET_UUID,
            agentId: 'lumen',
            context: 'claiming to be lumen',
          },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('still allows the caller its own session', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(myraSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', sessionId: TARGET_UUID, context: 'my own note' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('keeps same-user repair authority for a human user token', async () => {
      // callerProfile is 'agent' on every HTTP request, so it must not be read
      // as "authenticated as an agent" — a user token still repairs its own rows.
      callerIsUserToken();
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(lumenSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', sessionId: TARGET_UUID, context: 'operator repair' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('never crosses users, whatever the caller presents', async () => {
      callerIsUserToken();
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...lumenSession,
        userId: 'someone-else',
      });

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'cross-user' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // Gap 2: a canonical target requires a canonical caller
  //
  // Agent-bound tokens without a canonical claim are valid today, and the slug
  // fallback fired whenever EITHER side lacked sbId — so such a caller could
  // reach a modern session owned by a same-named identity in another workspace.
  // ---------------------------------------------------
  describe('does not slug-authorize a canonical target', () => {
    it('denies a caller with no sbId against a target that has one', async () => {
      callerIsAgent('lumen'); // agent-bound, no canonical claim
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'same slug, no sbId' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('denies the same slug in a different workspace', async () => {
      callerIsAgent('wren', 'sb-wren-workspace-a');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...lumenSession,
        agentId: 'wren',
        sbId: 'sb-wren-workspace-b',
      });

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'across workspaces' },
          mockDataComposer as never
        )
      );
    });

    it('still accepts the slug for a legacy target row that predates sb_id', async () => {
      callerIsAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...myraSession,
        sbId: undefined,
      });
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', sessionId: TARGET_UUID, context: 'legacy row' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });
  });

  // ---------------------------------------------------
  // Gap 3: per-contact isolation
  //
  // One SB identity serves many contacts, so identity ownership alone does not
  // separate two conversations. The caller's contact scope comes from its
  // ambient session, because the HTTP path never populates ctx.contactId.
  // ---------------------------------------------------
  // ---------------------------------------------------
  // Gap 3: per-contact isolation, bound to the SIGNED claim
  //
  // Round three killed the previous mechanism. Deriving the caller's contact
  // scope from the ambient session named by x-ink-context was not an
  // authentication boundary: the header is unsigned, and a runner serving
  // contact A can name contact B's session under the SAME sbId, so the
  // identity check passes and the caller inherits B's scope.
  // ---------------------------------------------------
  describe('preserves per-contact session isolation', () => {
    const contactA = { ...myraSession, id: 'session-contact-a', contactId: 'contact-a' };
    const contactB = { ...myraSession, id: 'session-contact-b', contactId: 'contact-b' };

    it('allows a runner its own contact session', async () => {
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactA);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(contactA);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', sessionId: TARGET_UUID, context: 'my own contact' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('denies a runner another contact under the SAME identity', async () => {
      // The attack the previous mechanism allowed. Same sbId on both sides, so
      // the identity check cannot separate them — only the signed claim can.
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactB);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'into contact B' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('ignores a forged x-ink-context naming the other contact', async () => {
      // Signed for contact A; header claims B's session. The header must not
      // move the scope — under the old ambient-derivation it did, because B's
      // session passes the sbId check.
      callerIsRunner(
        'myra',
        'sb-myra',
        { sessionId: 'session-contact-a', contactId: 'contact-a' },
        'session-contact-b'
      );
      // Explicit target is B, and the forged header also names B — so if the
      // header could move the scope, this would succeed.
      mockDataComposer.repositories.memory.getSession.mockImplementation(async (id: string) =>
        id === 'session-contact-a' ? contactA : contactB
      );

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'forged header' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('denies reading another contact`s logs under the same identity', async () => {
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactB);

      denied(
        await handleGetSession(
          { email: 'test@test.com', sessionId: TARGET_UUID, includeLogs: true },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.getSessionLogs).not.toHaveBeenCalled();
    });

    it('denies compacting another contact`s session under the same identity', async () => {
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactB);

      denied(
        await handleCompactSession(
          { email: 'test@test.com', sessionId: TARGET_UUID },
          mockDataComposer as never
        )
      );
    });

    it('denies ending another contact`s session under the same identity', async () => {
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactB);

      denied(
        await handleEndSession(
          { email: 'test@test.com', sessionId: TARGET_UUID },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.endSession).not.toHaveBeenCalled();
    });

    it('ignores an unsigned x-ink-context contactId entirely', async () => {
      // The header can carry contactId too. It must not be a fallback when the
      // token holds no claim, or the whole binding is decorative — a caller
      // would simply omit the claim and assert the scope it wants.
      callerIsAgent('myra', 'sb-myra', { contactId: 'contact-a' });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactA);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'header-claimed scope' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('prefers the signed claim when the header disagrees', async () => {
      callerIsAgent('myra', 'sb-myra', {
        tokenContactId: 'contact-a',
        contactId: 'contact-b',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactB);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'header says B' },
          mockDataComposer as never
        )
      );
    });

    it('denies an agent with no signed contact claim every contact session', async () => {
      // Fail closed, matching resolveObservePermission's contact_isolated stance:
      // without a claim there is no authenticated per-contact distinction.
      callerIsAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactA);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'unclaimed' },
          mockDataComposer as never
        )
      );
    });

    it('denies a contact-scoped runner an owner session', async () => {
      // Symmetric, mirroring findOwnedActiveSessions' disjoint sets.
      callerIsRunner('myra', 'sb-myra', { contactId: 'contact-a' });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(myraSession);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'contact into owner' },
          mockDataComposer as never
        )
      );
    });

    it('scopes the implicit lookup to the signed session', async () => {
      callerIsRunner('myra', 'sb-myra', {
        sessionId: 'session-contact-a',
        contactId: 'contact-a',
      });
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(contactA);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(contactA);

      await handleUpdateSessionState(
        { email: 'test@test.com', context: 'implicit within contact A' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-contact-a',
        expect.objectContaining({ context: 'implicit within contact A' })
      );
    });

    it('resolves implicitly to the SIGNED session, not the header one', async () => {
      callerIsRunner(
        'myra',
        'sb-myra',
        { sessionId: 'session-contact-a', contactId: 'contact-a' },
        'session-contact-b'
      );
      mockDataComposer.repositories.memory.getSession.mockImplementation(async (id: string) =>
        id === 'session-contact-b' ? contactB : contactA
      );
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(contactA);

      await handleUpdateSessionState(
        { email: 'test@test.com', context: 'signed wins' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-contact-a',
        expect.anything()
      );
    });
  });

  // ---------------------------------------------------
  // end_session had NO boundary at all: an explicit UUID went straight to
  // endSession(), and the implicit branch used the old slug+recency lookup.
  // ---------------------------------------------------
  describe('end_session is authorized like the others', () => {
    beforeEach(() => {
      // The handler chains .catch() onto the cli_attached clear.
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);
      mockDataComposer.getClient.mockReturnValue(chainableClient());
    });

    it('denies ending a peer session', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleEndSession(
          { email: 'test@test.com', sessionId: TARGET_UUID },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.endSession).not.toHaveBeenCalled();
    });

    it('denies ending another user`s session', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...myraSession,
        userId: 'someone-else',
      });

      denied(
        await handleEndSession(
          { email: 'test@test.com', sessionId: TARGET_UUID },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.endSession).not.toHaveBeenCalled();
    });

    it('allows ending the caller`s own session', async () => {
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(myraSession);
      mockDataComposer.repositories.memory.endSession.mockResolvedValue(myraSession);

      const result = await handleEndSession(
        { email: 'test@test.com', sessionId: TARGET_UUID },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
      // The authorized target is ended by the id the caller named.
      expect(mockDataComposer.repositories.memory.endSession).toHaveBeenCalledWith(
        TARGET_UUID,
        undefined
      );
    });

    it('uses the canonical resolver, not the old recency lookup', async () => {
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([myraSession]);
      mockDataComposer.repositories.memory.endSession.mockResolvedValue(myraSession);

      await handleEndSession({ email: 'test@test.com' }, mockDataComposer as never);

      expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.memory.findOwnedActiveSessions).toHaveBeenCalledWith(
        expect.objectContaining({ sbId: 'sb-myra' })
      );
    });

    it('refuses to guess when the identity has sessions in several studios', async () => {
      mockDataComposer.repositories.memory.findOwnedActiveSessions.mockResolvedValue([
        { ...myraSession, id: 'a', studioId: 'studio-a' },
        { ...myraSession, id: 'b', studioId: 'studio-b' },
      ]);

      const result = await handleEndSession({ email: 'test@test.com' }, mockDataComposer as never);

      expect(JSON.parse(result.content[0].text).success).toBe(false);
      expect(mockDataComposer.repositories.memory.endSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // stdio callers
  //
  // The other half of the identity surface. Mutation testing found this whole
  // branch unasserted: every test above sets a request context, so nothing
  // pinned what happens when there is none.
  // ---------------------------------------------------
  describe('stdio callers', () => {
    it('allows a pinned stdio caller its own session', async () => {
      callerIsStdioAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(myraSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(myraSession);

      const result = await handleUpdateSessionState(
        { email: 'test@test.com', sessionId: TARGET_UUID, context: 'stdio own' },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('denies a pinned stdio caller a peer session', async () => {
      callerIsStdioAgent('myra', 'sb-myra');
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'stdio peer' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });

    it('denies a pinned stdio caller whose session context names a different agent', async () => {
      // sbId is only adopted when the session context describes the pinned
      // agent, so a mismatched context cannot lend its canonical identity.
      callerIsStdioAgent('myra', 'sb-myra');
      vi.mocked(getSessionContext).mockReturnValue({
        agentId: 'lumen',
        sbId: 'sb-lumen',
      } as never);
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, context: 'borrowed sbId' },
          mockDataComposer as never
        )
      );
    });

    it('treats an unpinned stdio call as the local operator, not as the agent it names', async () => {
      // No pin and no request context is the pre-bootstrap local operator, who
      // keeps same-user repair authority. The point of the explicit agentId
      // here is that it must NOT convert the call into an agent-bound one —
      // it is attribution, and an agent-bound caller with no canonical claim
      // would be refused this target rather than granted it.
      callerIsAnonymous();
      mockDataComposer.repositories.memory.getSession.mockResolvedValue(lumenSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(lumenSession);

      const result = await handleUpdateSessionState(
        {
          email: 'test@test.com',
          sessionId: TARGET_UUID,
          agentId: 'lumen',
          context: 'operator repair from the CLI',
        },
        mockDataComposer as never
      );

      expect(JSON.parse(result.content[0].text).success).toBe(true);
    });

    it('still refuses to cross users on an unpinned stdio call', async () => {
      callerIsAnonymous();
      mockDataComposer.repositories.memory.getSession.mockResolvedValue({
        ...lumenSession,
        userId: 'someone-else',
      });

      denied(
        await handleUpdateSessionState(
          { email: 'test@test.com', sessionId: TARGET_UUID, agentId: 'lumen', context: 'nope' },
          mockDataComposer as never
        )
      );
      expect(mockDataComposer.repositories.memory.updateSession).not.toHaveBeenCalled();
    });
  });
});

describe('startSessionSchema - threadKey', () => {
  it('should accept threadKey as optional string', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'lumen',
      threadKey: 'pr:32',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadKey).toBe('pr:32');
    }
  });

  it('should accept request without threadKey', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'lumen',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadKey).toBeUndefined();
    }
  });

  it('should accept threadKey with studioId together', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'lumen',
      threadKey: 'pr:32',
      studioId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadKey).toBe('pr:32');
      expect(result.data.studioId).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should accept various threadKey formats', () => {
    const formats = [
      'pr:32',
      'spec:cli-hooks',
      'issue:45',
      'branch:wren/feat/x',
      'thread:perf-audit',
    ];
    for (const key of formats) {
      const result = startSessionSchema.safeParse({
        email: 'test@test.com',
        agentId: 'lumen',
        threadKey: key,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('handleStartSession - threadKey matching', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  const mockSession = {
    id: 'session-existing',
    userId: 'user-123',
    agentId: 'lumen',
    studioId: undefined,
    threadKey: 'pr:32',
    currentPhase: 'reviewing',
    startedAt: new Date('2026-02-10T10:00:00Z'),
    endedAt: undefined,
    summary: undefined,
    metadata: {},
  };

  const mockNewSession = {
    id: 'session-new',
    userId: 'user-123',
    agentId: 'lumen',
    studioId: undefined,
    threadKey: 'pr:99',
    currentPhase: undefined,
    startedAt: new Date('2026-02-15T10:00:00Z'),
    endedAt: undefined,
    summary: undefined,
    metadata: {},
  };

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
  });

  it('should match existing session by threadKey', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(mockSession);

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen', threadKey: 'pr:32' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.session.id).toBe('session-existing');
    expect(parsed.session.threadKey).toBe('pr:32');
    expect(parsed.session.isExisting).toBe(true);

    // Should have queried by threadKey, scoped by studioId (undefined here)
    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).toHaveBeenCalledWith(
      'user-123',
      'lumen',
      'pr:32',
      undefined,
      undefined, // contactId
      undefined // sbId — canonical owner when the caller has one
    );
    // Should NOT have fallen through to studioId lookup
    expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
    // Should NOT have created a new session
    expect(mockDataComposer.repositories.memory.startSession).not.toHaveBeenCalled();
  });

  it('should fall through to studioId match when threadKey has no match', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(null);
    const studioSession = { ...mockSession, threadKey: undefined, studioId: 'studio-abc' };
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(studioSession);

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen', threadKey: 'pr:999' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.session.isExisting).toBe(true);

    // Should have tried threadKey first, then fallen through
    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).toHaveBeenCalled();
    expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalled();
  });

  it('should create new session with threadKey when no match found', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(null);
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue(mockNewSession);

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen', threadKey: 'pr:99' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Session started successfully');
    expect(parsed.session.id).toBe('session-new');
    expect(parsed.session.threadKey).toBe('pr:99');

    // Should have passed threadKey to startSession
    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        agentId: 'lumen',
        threadKey: 'pr:99',
      })
    );
  });

  it('should scope threadKey lookup by studioId when provided', async () => {
    const studioId = '550e8400-e29b-41d4-a716-446655440000';
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(mockSession);

    await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen', threadKey: 'pr:32', studioId },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).toHaveBeenCalledWith(
      'user-123',
      'lumen',
      'pr:32',
      studioId,
      undefined, // contactId
      undefined // sbId
    );
  });

  it('should skip threadKey lookup when agentId is not provided', async () => {
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue({
      ...mockNewSession,
      agentId: undefined,
      threadKey: 'pr:99',
    });

    await handleStartSession(
      { email: 'test@test.com', threadKey: 'pr:99' },
      mockDataComposer as never
    );

    // threadKey lookup requires agentId, so should skip it
    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).not.toHaveBeenCalled();
    expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalled();
  });

  it('should skip threadKey lookup when threadKey is not provided', async () => {
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue({
      ...mockNewSession,
      threadKey: undefined,
    });

    await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).not.toHaveBeenCalled();
  });

  it('should include threadKey in existing session response', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(mockSession);

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen', threadKey: 'pr:32' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session.threadKey).toBe('pr:32');
  });

  it('should include null threadKey in response when not set', async () => {
    const sessionNoThread = { ...mockSession, threadKey: undefined };
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(sessionNoThread);

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'lumen' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session.threadKey).toBeNull();
  });

  it('should create new session when forceNew is true even if active exists', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(mockSession);
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue(mockNewSession);

    const result = await handleStartSession(
      {
        email: 'test@test.com',
        agentId: 'lumen',
        threadKey: 'pr:32',
        forceNew: true,
      },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.session.id).toBe('session-new');
    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).not.toHaveBeenCalled();
    expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalled();
  });

  it('should pass sessionId through to startSession', async () => {
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(null);
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue(mockNewSession);

    await handleStartSession(
      {
        email: 'test@test.com',
        agentId: 'lumen',
        forceNew: true,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '550e8400-e29b-41d4-a716-446655440000',
      })
    );
  });
});

// =====================================================
// start_session authorization (PR #501 round 3)
// =====================================================

describe('handleStartSession - identity and contact scope', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  const newSession = {
    id: 'session-new',
    userId: 'user-123',
    agentId: 'myra',
    sbId: 'sb-myra',
    studioId: undefined,
    startedAt: new Date('2026-08-20T10:00:00Z'),
    metadata: {},
  };

  // contactId is schema-validated as a UUID.
  const CONTACT_A = '11111111-1111-4111-8111-111111111111';
  const CONTACT_B = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
    callerIsAgent('myra', 'sb-myra');
    mockDataComposer.repositories.memory.getActiveSessionByThreadKey.mockResolvedValue(null);
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue(newSession);
  });

  // ---- Reuse must be canonical, not slug-only -------------------------
  it('scopes the threadKey reuse lookup by the canonical owner', async () => {
    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra', threadKey: 'pr:501' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.getActiveSessionByThreadKey).toHaveBeenCalledWith(
      'user-123',
      'myra',
      'pr:501',
      undefined,
      undefined,
      'sb-myra'
    );
  });

  it('scopes the studio reuse lookup by the canonical owner', async () => {
    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
      'user-123',
      'myra',
      undefined,
      undefined,
      'sb-myra'
    );
  });

  it('refuses to hand back a same-slug session from another workspace', async () => {
    // The canonical creator used to be computed only at insert time, so reuse
    // matched on the slug and could return another workspace's session —
    // including its backendSessionId, which resumes that conversation.
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue({
      ...newSession,
      id: 'session-other-workspace',
      sbId: 'sb-myra-workspace-b',
      backendSessionId: 'backend-secret',
    });

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'myra' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session.isExisting).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('backend-secret');
    expect(JSON.stringify(parsed)).not.toContain('session-other-workspace');
    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalled();
  });

  it('stamps the new row with the verified canonical identity', async () => {
    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ sbId: 'sb-myra' })
    );
  });

  // ---- Contact scope is identity, not a parameter ---------------------
  it('refuses an agent-bound caller a contactId it was not issued for', async () => {
    callerIsRunner('myra', 'sb-myra', { contactId: CONTACT_A });

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'myra', contactId: CONTACT_B },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/contact scope/i);
    expect(mockDataComposer.repositories.memory.startSession).not.toHaveBeenCalled();
  });

  it('refuses an agent-bound caller any contactId when it holds no claim', async () => {
    callerIsAgent('myra', 'sb-myra'); // no signed contact binding

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'myra', contactId: CONTACT_A },
      mockDataComposer as never
    );

    expect(JSON.parse(result.content[0].text).success).toBe(false);
    expect(mockDataComposer.repositories.memory.startSession).not.toHaveBeenCalled();
  });

  it('accepts the contactId the runner was issued for', async () => {
    callerIsRunner('myra', 'sb-myra', { contactId: CONTACT_A });

    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra', contactId: CONTACT_A },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT_A })
    );
  });

  it('applies the signed contact scope even when the caller omits it', async () => {
    callerIsRunner('myra', 'sb-myra', { contactId: CONTACT_A });

    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT_A })
    );
  });

  it('still lets a user token open a session in a contact scope', async () => {
    // Channel plumbing driven by a human/admin token keeps working.
    callerIsUserToken();

    await handleStartSession(
      { email: 'test@test.com', agentId: 'myra', contactId: CONTACT_A },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT_A })
    );
  });
});

describe('handleStartSession - studioId="main" scope resolution', () => {
  // Regression: before resolveStudioScope, studioId="main" collapsed to undefined,
  // dropping the filter entirely. A main-repo attach could reattach to any
  // active studio session for the same agent; new "main" sessions never wrote
  // studio_id=NULL. See PR #322.
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
  });

  it('passes null (not undefined) to getActiveSession when studioId="main"', async () => {
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue({
      id: 'session-main',
      userId: 'user-123',
      agentId: 'wren',
      studioId: undefined,
      threadKey: undefined,
      currentPhase: undefined,
      startedAt: new Date('2026-04-16T10:00:00Z'),
      endedAt: undefined,
      summary: undefined,
      metadata: {},
    });

    await handleStartSession(
      { email: 'test@test.com', agentId: 'wren', studioId: 'main' },
      mockDataComposer as never
    );

    // null means "studio_id IS NULL" — not "any studio"
    expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
      'user-123',
      'wren',
      null,
      undefined, // contactId
      undefined // sbId
    );
  });

  it('persists studio_id=null on insert when studioId="main"', async () => {
    mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);
    mockDataComposer.repositories.memory.startSession.mockResolvedValue({
      id: 'session-main',
      userId: 'user-123',
      agentId: 'wren',
      studioId: undefined,
      threadKey: undefined,
      currentPhase: undefined,
      startedAt: new Date('2026-04-16T10:00:00Z'),
      endedAt: undefined,
      summary: undefined,
      metadata: {},
    });

    await handleStartSession(
      { email: 'test@test.com', agentId: 'wren', studioId: 'main' },
      mockDataComposer as never
    );

    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        agentId: 'wren',
        studioId: null, // explicit NULL — not undefined
      })
    );
  });

  it('does not reattach to a feature-studio session when attaching with studioId="main"', async () => {
    // Simulates the bug: an active session exists in a feature studio.
    // A "main" attach must NOT return it — null filter should scope to studio_id IS NULL.
    // The mock mirrors the repo's real behavior: null means "IS NULL", so it returns null.
    mockDataComposer.repositories.memory.getActiveSession.mockImplementation(
      async (_userId: string, _agentId?: string, studioId?: string | null | undefined) => {
        if (studioId === null) return null; // no root session exists
        // Would return a feature-studio session for undefined (the buggy path) —
        // this test documents that we never hit that branch.
        return {
          id: 'session-feature-studio',
          userId: 'user-123',
          agentId: 'wren',
          studioId: '550e8400-e29b-41d4-a716-446655440001',
          threadKey: undefined,
          currentPhase: undefined,
          startedAt: new Date(),
          endedAt: undefined,
          summary: undefined,
          metadata: {},
        };
      }
    );
    mockDataComposer.repositories.memory.startSession.mockResolvedValue({
      id: 'session-main-new',
      userId: 'user-123',
      agentId: 'wren',
      studioId: undefined,
      threadKey: undefined,
      currentPhase: undefined,
      startedAt: new Date(),
      endedAt: undefined,
      summary: undefined,
      metadata: {},
    });

    const result = await handleStartSession(
      { email: 'test@test.com', agentId: 'wren', studioId: 'main' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    // Should have created a fresh root-repo session, not reattached to the feature studio
    expect(parsed.session.id).toBe('session-main-new');
    expect(mockDataComposer.repositories.memory.startSession).toHaveBeenCalled();
  });
});

// =====================================================
// HIERARCHICAL MEMORY TESTS
// =====================================================

import { rememberSchema, buildKnowledgeSummary } from './memory-handlers';
import type { Memory } from '../../data/models/memory';

describe('rememberSchema - hierarchical memory fields', () => {
  it('should accept summary field', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'Full detailed content about JWT auth...',
      summary: 'Self-issued JWTs for MCP auth',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('Self-issued JWTs for MCP auth');
    }
  });

  it('should accept topicKey field', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'Some memory content',
      topicKey: 'decision:jwt-auth',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topicKey).toBe('decision:jwt-auth');
    }
  });

  it('should accept topicSummary field', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'Some memory content',
      topicKey: 'project:pcp/memory',
      topicSummary: 'Hierarchical memory design for PCP',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topicSummary).toBe('Hierarchical memory design for PCP');
    }
  });

  it('should accept all hierarchical fields together', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'Detailed content...',
      summary: 'One-liner summary',
      topicKey: 'convention:git',
      topicSummary: 'Git workflow conventions',
      salience: 'high',
      topics: ['git', 'conventions'],
    });
    expect(result.success).toBe(true);
  });

  it('should work without hierarchical fields (backward compat)', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'Simple memory without new fields',
      salience: 'medium',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBeUndefined();
      expect(result.data.topicKey).toBeUndefined();
      expect(result.data.topicSummary).toBeUndefined();
    }
  });
});

describe('rememberSchema - open source provenance', () => {
  // The DB CHECK constraint on memories.source was dropped (migration
  // 20260219080201) and the MemorySource model type is open, but the tool
  // schema used to be a strict 5-value enum that rejected descriptive
  // provenance. It must now accept any non-empty string.
  it('accepts canonical source values', () => {
    for (const source of ['conversation', 'observation', 'user_stated', 'inferred', 'session']) {
      const result = rememberSchema.safeParse({
        email: 'test@test.com',
        content: 'x',
        source,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts free-form provenance sources (the fix)', () => {
    for (const source of ['pr-review', 'codex-review', 'posthoc-review', 'reflection']) {
      const result = rememberSchema.safeParse({
        email: 'test@test.com',
        content: 'x',
        source,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBe(source);
      }
    }
  });

  it('still rejects an empty-string source', () => {
    const result = rememberSchema.safeParse({
      email: 'test@test.com',
      content: 'x',
      source: '',
    });
    expect(result.success).toBe(false);
  });

  it('works without a source (optional)', () => {
    const result = rememberSchema.safeParse({ email: 'test@test.com', content: 'x' });
    expect(result.success).toBe(true);
  });
});

describe('buildKnowledgeSummary', () => {
  function makeMemory(overrides: Partial<Memory> & { content: string }): Memory {
    return {
      id: `mem-${Math.random().toString(36).slice(2, 8)}`,
      userId: 'user-123',
      source: 'observation',
      salience: 'high',
      topics: [],
      metadata: {},
      version: 1,
      createdAt: new Date('2026-02-15T12:00:00Z'),
      ...overrides,
    };
  }

  it('should group memories by topicKey', () => {
    const memories = [
      makeMemory({
        content: 'JWT auth approach',
        topicKey: 'decision:jwt-auth',
        topics: ['decision:jwt-auth'],
      }),
      makeMemory({
        content: 'Git workflow rules',
        topicKey: 'convention:git',
        topics: ['convention:git'],
      }),
      makeMemory({
        content: 'More JWT details',
        topicKey: 'decision:jwt-auth',
        topics: ['decision:jwt-auth'],
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    expect(result.topicIndex).toHaveLength(2);
    const jwtTopic = result.topicIndex.find((t) => t.topicKey === 'decision:jwt-auth');
    const gitTopic = result.topicIndex.find((t) => t.topicKey === 'convention:git');
    expect(jwtTopic?.memoryCount).toBe(2);
    expect(gitTopic?.memoryCount).toBe(1);
  });

  it('should use summary field when available', () => {
    const memories = [
      makeMemory({
        content: 'Very long detailed content about JWT authentication...',
        summary: 'Self-issued JWTs for MCP auth',
        topicKey: 'decision:jwt-auth',
        topics: ['decision:jwt-auth'],
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    expect(result.knowledgeSummary).toContain('Self-issued JWTs for MCP auth');
    expect(result.knowledgeSummary).not.toContain('Very long detailed');
  });

  it('should truncate content when no summary is provided', () => {
    const longContent = 'A'.repeat(500);
    const memories = [
      makeMemory({
        content: longContent,
        topicKey: 'test:long',
        topics: ['test:long'],
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    // Should be truncated to ~200 chars + '...'
    expect(result.knowledgeSummary.length).toBeLessThan(500);
    expect(result.knowledgeSummary).toContain('...');
  });

  it('should truncate long summaries to prevent budget bypass', () => {
    const longSummary = 'B'.repeat(500);
    const memories = [
      makeMemory({
        content: 'Full content',
        summary: longSummary,
        topicKey: 'test:long-summary',
        topics: ['test:long-summary'],
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    // The summary should be truncated to 200 chars, not used raw
    expect(result.knowledgeSummary).not.toContain(longSummary);
    expect(result.knowledgeSummary).toContain('...');
  });

  it('should fall back to first topic when no topicKey', () => {
    const memories = [makeMemory({ content: 'No topic key', topics: ['fallback-topic'] })];

    const result = buildKnowledgeSummary(memories);

    expect(result.topicIndex[0].topicKey).toBe('fallback-topic');
  });

  it('should use "uncategorized" when no topics at all', () => {
    const memories = [makeMemory({ content: 'No topics or topicKey', topics: [] })];

    const result = buildKnowledgeSummary(memories);

    expect(result.topicIndex[0].topicKey).toBe('uncategorized');
  });

  it('should include topicSummary from metadata', () => {
    const memories = [
      makeMemory({
        content: 'Some content',
        topicKey: 'project:pcp',
        topics: ['project:pcp'],
        metadata: { topicSummary: 'Personal Context Protocol' },
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    expect(result.knowledgeSummary).toContain('project:pcp — Personal Context Protocol');
    expect(result.topicIndex[0].topicSummary).toBe('Personal Context Protocol');
  });

  it('should respect character budget', () => {
    // Create many memories that would exceed a small budget
    process.env.BOOTSTRAP_MEMORY_BUDGET = '200';
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        content: `Memory ${i}: ${'x'.repeat(100)}`,
        topicKey: `topic:${i}`,
        topics: [`topic:${i}`],
      })
    );

    const result = buildKnowledgeSummary(memories);

    // knowledgeSummary should be within budget
    expect(result.knowledgeSummary.length).toBeLessThanOrEqual(250); // some overhead for headers
    // But topic index should include all topics
    expect(result.topicIndex).toHaveLength(10);
    // memoriesIncluded should be less than total
    expect(result.memoriesIncluded).toBeLessThan(10);

    delete process.env.BOOTSTRAP_MEMORY_BUDGET;
  });

  it('should return empty summary for empty memories array', () => {
    const result = buildKnowledgeSummary([]);

    expect(result.knowledgeSummary).toBe('');
    expect(result.topicIndex).toHaveLength(0);
    expect(result.memoriesIncluded).toBe(0);
  });

  it('should sort topics by most recent activity first', () => {
    const memories = [
      makeMemory({
        content: 'Old topic',
        topicKey: 'topic:old',
        topics: ['topic:old'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      makeMemory({
        content: 'New topic',
        topicKey: 'topic:new',
        topics: ['topic:new'],
        createdAt: new Date('2026-02-18T00:00:00Z'),
      }),
    ];

    const result = buildKnowledgeSummary(memories);

    expect(result.topicIndex[0].topicKey).toBe('topic:new');
    expect(result.topicIndex[1].topicKey).toBe('topic:old');
  });
});

// =====================================================
// CURATE RECALL TESTS
// =====================================================

describe('curateRecallSchema', () => {
  it('accepts accepted + dismissed arrays with scores', () => {
    const result = curateRecallSchema.safeParse({
      email: 'test@test.com',
      query: 'merge strategy',
      accepted: [{ memoryId: '550e8400-e29b-41d4-a716-446655440000', finalScore: 0.85 }],
      dismissed: [
        {
          memoryId: '550e8400-e29b-41d4-a716-446655440001',
          semanticScore: 0.2,
          textScore: 0.1,
          finalScore: 0.17,
        },
      ],
      agentId: 'wren',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accepted).toHaveLength(1);
      expect(result.data.dismissed).toHaveLength(1);
    }
  });

  it('defaults accepted and dismissed to empty arrays', () => {
    const result = curateRecallSchema.safeParse({
      email: 'test@test.com',
      query: 'test',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accepted).toEqual([]);
      expect(result.data.dismissed).toEqual([]);
    }
  });

  it('rejects non-UUID memoryId', () => {
    const result = curateRecallSchema.safeParse({
      email: 'test@test.com',
      query: 'test',
      dismissed: [{ memoryId: 'not-a-uuid' }],
    });

    expect(result.success).toBe(false);
  });
});

describe('handleCurateRecall', () => {
  it('saves feedback and returns dismissed IDs', async () => {
    const composer = createMockDataComposer();
    composer.repositories.recallFeedback.saveFeedback.mockResolvedValue(3);
    composer.repositories.memory.verifyOwnership.mockResolvedValue(
      new Set([
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440001',
        '550e8400-e29b-41d4-a716-446655440002',
      ])
    );

    const result = await handleCurateRecall(
      {
        email: 'test@test.com',
        query: 'merge strategy',
        accepted: [
          {
            memoryId: '550e8400-e29b-41d4-a716-446655440000',
            semanticScore: 0.9,
            finalScore: 0.85,
          },
        ],
        dismissed: [
          { memoryId: '550e8400-e29b-41d4-a716-446655440001', finalScore: 0.1 },
          { memoryId: '550e8400-e29b-41d4-a716-446655440002', finalScore: 0.05 },
        ],
        agentId: 'wren',
      },
      composer as any
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.feedbackSaved).toBe(3);
    expect(body.dismissedMemoryIds).toEqual([
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
    ]);

    const feedbackCall = composer.repositories.recallFeedback.saveFeedback.mock.calls[0][0];
    expect(feedbackCall.entries).toHaveLength(3);
    expect(feedbackCall.entries[0].verdict).toBe('accepted');
    expect(feedbackCall.entries[1].verdict).toBe('dismissed');
    expect(feedbackCall.entries[2].verdict).toBe('dismissed');
  });

  it('handles empty curation (no accepted, no dismissed)', async () => {
    const composer = createMockDataComposer();
    composer.repositories.recallFeedback.saveFeedback.mockResolvedValue(0);

    const result = await handleCurateRecall(
      { email: 'test@test.com', query: 'anything' },
      composer as any
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.feedbackSaved).toBe(0);
    expect(body.dismissedMemoryIds).toEqual([]);
  });

  it('rejects memory IDs not owned by the user', async () => {
    const composer = createMockDataComposer();
    composer.repositories.memory.verifyOwnership.mockResolvedValue(
      new Set(['550e8400-e29b-41d4-a716-446655440000'])
    );

    await expect(
      handleCurateRecall(
        {
          email: 'test@test.com',
          query: 'test',
          accepted: [{ memoryId: '550e8400-e29b-41d4-a716-446655440000' }],
          dismissed: [{ memoryId: '550e8400-e29b-41d4-a716-446655440099' }],
        },
        composer as any
      )
    ).rejects.toThrow('not found or not owned');
  });

  it('rejects session ID not owned by the user', async () => {
    const composer = createMockDataComposer();
    composer.repositories.memory.verifySessionOwnership.mockResolvedValue(false);

    await expect(
      handleCurateRecall(
        {
          email: 'test@test.com',
          query: 'test',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
        },
        composer as any
      )
    ).rejects.toThrow('not found or not owned');
  });
});

// =====================================================
// mapSessionForBootstrap — context injection
// =====================================================

describe('mapSessionForBootstrap', () => {
  const baseSession = {
    id: 'session-abc',
    agentId: 'wren',
    studioId: 'studio-1',
    threadKey: 'pr:343',
    lifecycle: 'idle',
    currentPhase: 'implementing',
    context: 'server running on :4001, vitest watching',
    startedAt: new Date('2026-05-07T00:00:00Z'),
  };

  it('includes context for the caller session', () => {
    const result = mapSessionForBootstrap(baseSession, 'session-abc');
    expect(result.context).toBe('server running on :4001, vitest watching');
    expect(result.currentPhase).toBe('implementing');
  });

  it('omits context for non-caller sessions', () => {
    const result = mapSessionForBootstrap(baseSession, 'session-other');
    expect(result).not.toHaveProperty('context');
    expect(result.currentPhase).toBe('implementing');
  });

  it('omits context when callerSessionId is undefined', () => {
    const result = mapSessionForBootstrap(baseSession, undefined);
    expect(result).not.toHaveProperty('context');
  });

  it('omits context key entirely when caller session has no context set', () => {
    const noContextSession = { ...baseSession, context: undefined };
    const result = mapSessionForBootstrap(noContextSession, 'session-abc');
    expect(result).not.toHaveProperty('context');
  });

  it('always includes phase and lifecycle for all sessions', () => {
    const result = mapSessionForBootstrap(baseSession, 'session-other');
    expect(result.lifecycle).toBe('idle');
    expect(result.currentPhase).toBe('implementing');
    expect(result.agentId).toBe('wren');
    expect(result.studioId).toBe('studio-1');
  });
});

// =====================================================
// isCallerSessionEligible — agent identity boundary
// =====================================================

describe('isCallerSessionEligible', () => {
  it('allows same user + same agent', () => {
    expect(isCallerSessionEligible({ userId: 'user-1', agentId: 'wren' }, 'user-1', 'wren')).toBe(
      true
    );
  });

  it('rejects different user', () => {
    expect(isCallerSessionEligible({ userId: 'user-2', agentId: 'wren' }, 'user-1', 'wren')).toBe(
      false
    );
  });

  it('rejects cross-agent session even with same user', () => {
    expect(isCallerSessionEligible({ userId: 'user-1', agentId: 'lumen' }, 'user-1', 'wren')).toBe(
      false
    );
  });

  it('allows when bootstrap agentId is undefined (no filter)', () => {
    expect(
      isCallerSessionEligible({ userId: 'user-1', agentId: 'lumen' }, 'user-1', undefined)
    ).toBe(true);
  });

  it('allows when session has no agentId and bootstrap has agentId', () => {
    expect(isCallerSessionEligible({ userId: 'user-1' }, 'user-1', 'wren')).toBe(false);
  });

  it('allows when neither has agentId', () => {
    expect(isCallerSessionEligible({ userId: 'user-1' }, 'user-1', undefined)).toBe(true);
  });
});

// =====================================================
// callerSession extraction pattern (bootstrap response)
// =====================================================

describe('callerSession extraction from mergedSessions', () => {
  const sessions = [
    {
      id: 'session-abc',
      agentId: 'wren',
      studioId: 'studio-1',
      backendSessionId: 'backend-xyz',
      context: 'server on :4001',
      startedAt: new Date('2026-05-07T00:00:00Z'),
    },
    {
      id: 'session-def',
      agentId: 'lumen',
      studioId: 'studio-2',
      backendSessionId: 'backend-uvw',
      context: null,
      startedAt: new Date('2026-05-07T01:00:00Z'),
    },
  ];

  function extractCallerSession(
    mergedSessions: typeof sessions,
    callerSessionId: string | undefined
  ) {
    if (!callerSessionId) return null;
    const cs = mergedSessions.find((s) => s.id === callerSessionId);
    return cs
      ? {
          id: cs.id,
          backendSessionId: cs.backendSessionId || null,
          studioId: cs.studioId || null,
          agentId: cs.agentId || null,
          context: cs.context || null,
        }
      : null;
  }

  it('returns full session IDs for the caller', () => {
    const result = extractCallerSession(sessions, 'session-abc');
    expect(result).toEqual({
      id: 'session-abc',
      backendSessionId: 'backend-xyz',
      studioId: 'studio-1',
      agentId: 'wren',
      context: 'server on :4001',
    });
  });

  it('returns null when callerSessionId is undefined', () => {
    expect(extractCallerSession(sessions, undefined)).toBeNull();
  });

  it('returns null when callerSessionId is not in the list', () => {
    expect(extractCallerSession(sessions, 'session-unknown')).toBeNull();
  });

  it('includes backendSessionId for session resumption', () => {
    const result = extractCallerSession(sessions, 'session-abc');
    expect(result?.backendSessionId).toBe('backend-xyz');
  });

  it('returns null context when session has no context', () => {
    const result = extractCallerSession(sessions, 'session-def');
    expect(result?.context).toBeNull();
  });
});
