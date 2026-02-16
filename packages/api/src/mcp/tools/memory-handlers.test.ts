/**
 * Memory Handler Tests
 *
 * Tests for MCP tool schemas and handlers related to sessions,
 * session phases, and the unified update_session_phase tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startSessionSchema,
  listSessionsSchema,
  updateSessionPhaseSchema,
  handleUpdateSessionPhase,
  handleStartSession,
} from './memory-handlers';

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
  };

  const mockProjectsRepo = {
    findAllByUser: vi.fn(),
  };

  const mockProjectTasksRepo = {
    create: vi.fn(),
  };

  return {
    getClient: vi.fn(),
    repositories: {
      memory: mockMemoryRepo,
      projects: mockProjectsRepo,
      projectTasks: mockProjectTasksRepo,
    },
  };
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

  it('should accept deprecated workspaceId alias', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
  });

  it('should reject non-UUID studioId', () => {
    const result = startSessionSchema.safeParse({
      email: 'test@test.com',
      agentId: 'wren',
      studioId: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
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

  it('should accept deprecated workspaceId alias', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.success).toBe(true);
  });

  it('should reject non-UUID studioId', () => {
    const result = listSessionsSchema.safeParse({
      email: 'test@test.com',
      studioId: 'invalid',
    });

    expect(result.success).toBe(false);
  });
});

describe('updateSessionPhaseSchema', () => {
  it('should accept phase only', () => {
    const result = updateSessionPhaseSchema.safeParse({
      email: 'test@test.com',
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe('implementing');
    }
  });

  it('should accept blocked phase with note', () => {
    const result = updateSessionPhaseSchema.safeParse({
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
    const result = updateSessionPhaseSchema.safeParse({
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
    const result = updateSessionPhaseSchema.safeParse({
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
      const result = updateSessionPhaseSchema.safeParse({
        email: 'test@test.com',
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status enum values', () => {
    const result = updateSessionPhaseSchema.safeParse({
      email: 'test@test.com',
      status: 'invalid-status',
    });
    expect(result.success).toBe(false);
  });

  it('should accept sessionId as optional UUID', () => {
    const result = updateSessionPhaseSchema.safeParse({
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
    const result = updateSessionPhaseSchema.safeParse({
      email: 'test@test.com',
      sessionId: 'not-a-uuid',
      phase: 'implementing',
    });
    expect(result.success).toBe(false);
  });

  it('should accept free-text phase values (extensible)', () => {
    const result = updateSessionPhaseSchema.safeParse({
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

describe('handleUpdateSessionPhase', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  const mockSession = {
    id: 'session-123',
    email: 'test@test.com',
    agentId: 'wren',
    studioId: undefined,
    workspaceId: undefined,
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
  });

  // ---------------------------------------------------
  // Basic phase updates
  // ---------------------------------------------------

  describe('basic phase updates', () => {
    it('should update phase on active session (auto-resolved)', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('phase → implementing');
      expect(parsed.session.currentPhase).toBe('implementing');

      // Verify repo calls
      expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
        'user-123',
        undefined,
        undefined
      );
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({ currentPhase: 'implementing' })
      );
    });

    it('should update phase on explicitly specified session', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const result = await handleUpdateSessionPhase(
        {
          email: 'test@test.com',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          phase: 'reviewing',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      // Should NOT call getActiveSession when sessionId is provided
      expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
    });

    it('should update phase with agentId filter for active session lookup', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'investigating', agentId: 'wren' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
        'user-123',
        'wren',
        undefined
      );
    });

    it('should resolve session by studioId when sessionId not provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const studioId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing', agentId: 'wren', studioId },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
        'user-123',
        'wren',
        studioId
      );
    });

    it('should prefer sessionId over studioId for resolution', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const studioId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'reviewing', sessionId, studioId },
        mockDataComposer as never
      );

      // When sessionId is provided, getActiveSession should NOT be called
      expect(mockDataComposer.repositories.memory.getActiveSession).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.memory.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ currentPhase: 'reviewing' })
      );
    });

    it('should support deprecated workspaceId alias for session resolution', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      const workspaceId = '550e8400-e29b-41d4-a716-446655440099';
      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing', agentId: 'wren', workspaceId },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.getActiveSession).toHaveBeenCalledWith(
        'user-123',
        'wren',
        workspaceId
      );
    });
  });

  // ---------------------------------------------------
  // Unified session fields
  // ---------------------------------------------------

  describe('unified session fields', () => {
    it('should update backendSessionId', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionPhase(
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

    it('should update status', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockSession);

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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

    it('should create memory for complete phase', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'complete',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-101',
        content: 'Session entered phase: complete',
      });

      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'complete' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.memoryCreated).toBeDefined();
    });

    it('should create memory with default content when no note provided', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue({
        ...mockSession,
        currentPhase: 'blocked:unknown-issue',
      });
      mockDataComposer.repositories.memory.remember.mockResolvedValue({
        id: 'memory-102',
        content: 'Session entered phase: blocked:unknown-issue',
      });

      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'blocked:unknown-issue' },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.memory.remember).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Session entered phase: blocked:unknown-issue',
        })
      );
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

        const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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
        content: 'Session entered phase: blocked:test',
      });

      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'blocked:test' },
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
      mockDataComposer.repositories.projectTasks.create.mockResolvedValue({
        id: 'task-1',
        title: '[blocked:awaiting-input] Need user feedback',
      });

      const result = await handleUpdateSessionPhase(
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

      expect(mockDataComposer.repositories.projectTasks.create).toHaveBeenCalledWith(
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
      mockDataComposer.repositories.projectTasks.create.mockResolvedValue({
        id: 'task-2',
        title: '[waiting:ci-build] CI running',
      });

      const result = await handleUpdateSessionPhase(
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

      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'blocked:test', createTask: false },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.projects.findAllByUser).not.toHaveBeenCalled();
      expect(mockDataComposer.repositories.projectTasks.create).not.toHaveBeenCalled();
    });

    it('should NOT create task for non-blocked/waiting phases even with createTask=true', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(mockUpdatedSession);

      await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing', createTask: true },
        mockDataComposer as never
      );

      expect(mockDataComposer.repositories.projectTasks.create).not.toHaveBeenCalled();
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
      mockDataComposer.repositories.projectTasks.create.mockRejectedValue(
        new Error('Database constraint violation')
      );

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'blocked:test', createTask: true },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.taskCreated).toBeUndefined();
      expect(mockDataComposer.repositories.projectTasks.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------
  // Error handling
  // ---------------------------------------------------

  describe('error handling', () => {
    it('should error when no fields provided', async () => {
      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('At least one field must be provided');
    });

    it('should error when no active session found', async () => {
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(null);

      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No active session found');
    });

    it('should error when session not found by ID', async () => {
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(null);

      const result = await handleUpdateSessionPhase(
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

      const result = await handleUpdateSessionPhase(
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
        workspaceId: 'workspace-abc',
        currentPhase: 'implementing',
      };
      mockDataComposer.repositories.memory.getActiveSession.mockResolvedValue(mockSession);
      mockDataComposer.repositories.memory.updateSession.mockResolvedValue(sessionWithWorkspace);

      const result = await handleUpdateSessionPhase(
        { email: 'test@test.com', phase: 'implementing' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.session.id).toBe('session-123');
      expect(parsed.session.agentId).toBe('wren');
      expect(parsed.session.studioId).toBe('workspace-abc');
      expect(parsed.session.workspaceId).toBe('workspace-abc');
      expect(parsed.session.currentPhase).toBe('implementing');
    });
  });
});

// =====================================================
// THREAD KEY TESTS
// =====================================================

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
    const formats = ['pr:32', 'spec:cli-hooks', 'issue:45', 'branch:wren/feat/x', 'thread:perf-audit'];
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
    workspaceId: undefined,
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
    workspaceId: undefined,
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
      undefined
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
      studioId
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
});
