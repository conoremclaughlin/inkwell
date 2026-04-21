/**
 * Strategy Handler Tests
 *
 * Tests for MCP tool handlers that manage work strategy lifecycle.
 * These handlers are thin wrappers around StrategyService — the tests
 * verify user resolution, service delegation, and response formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleStartStrategy,
  handlePauseStrategy,
  handleResumeStrategy,
  handleCancelStrategy,
  handleGetStrategyStatus,
} from './strategy-handlers';

// =====================================================
// MOCK SETUP
// =====================================================

// vi.hoisted ensures these are available before vi.mock hoisting
const mocks = vi.hoisted(() => ({
  startStrategy: vi.fn(),
  pauseStrategy: vi.fn(),
  resumeStrategy: vi.fn(),
  cancelStrategy: vi.fn(),
  getStrategyStatus: vi.fn(),
}));

// Use a real class so `new StrategyService()` works after clearAllMocks
vi.mock('../../services/strategy.service', () => ({
  StrategyService: class MockStrategyService {
    startStrategy = mocks.startStrategy;
    pauseStrategy = mocks.pauseStrategy;
    resumeStrategy = mocks.resumeStrategy;
    cancelStrategy = mocks.cancelStrategy;
    getStrategyStatus = mocks.getStrategyStatus;
  },
}));

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUser: vi.fn().mockResolvedValue({
      user: { id: 'user-123' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../auth/enforce-identity', () => ({
  getEffectiveAgentId: vi.fn().mockReturnValue('wren'),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveUser } from '../../services/user-resolver';

const resolveUserMock = vi.mocked(resolveUser);

function parseResponse(response: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(response.content[0].text);
}

function createMockDataComposer() {
  return { getClient: vi.fn(), repositories: {} } as any;
}

// =====================================================
// Tests
// =====================================================

describe('handleStartStrategy', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should resolve user and delegate to StrategyService', async () => {
    mocks.startStrategy.mockResolvedValue({
      action: 'next_task',
      nextTask: {
        id: 'task-1',
        title: 'First task',
        description: 'Do the thing',
        task_order: 0,
        status: 'in_progress',
      },
      prompt: 'You are working the persistence strategy...',
    });

    const response = await handleStartStrategy(
      {
        userId: 'user-123',
        groupId: 'group-1',
        strategy: 'persistence',
        verificationMode: 'self',
      },
      dc
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.action).toBe('next_task');
    expect(data.nextTask).toMatchObject({
      id: 'task-1',
      title: 'First task',
      taskOrder: 0,
    });

    expect(mocks.startStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
      })
    );
  });

  it('should pass strategy config to service', async () => {
    mocks.startStrategy.mockResolvedValue({
      action: 'next_task',
      nextTask: null,
      prompt: 'No tasks yet...',
    });

    await handleStartStrategy(
      {
        userId: 'user-123',
        groupId: 'group-1',
        strategy: 'persistence',
        verificationMode: 'self',
        checkInInterval: 3,
        checkInNotify: 'myra',
        supervisorId: 'supervisor-uuid',
        verificationGates: ['tests', 'build'],
      },
      dc
    );

    expect(mocks.startStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          checkInInterval: 3,
          checkInNotify: 'myra',
          supervisorId: 'supervisor-uuid',
          verificationGates: ['tests', 'build'],
        }),
      })
    );
  });

  it('should return error for unknown user', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleStartStrategy(
      {
        userId: 'nonexistent',
        groupId: 'group-1',
        strategy: 'persistence',
        verificationMode: 'self',
      },
      dc
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
    expect(mocks.startStrategy).not.toHaveBeenCalled();
  });

  it('should return error on service failure', async () => {
    mocks.startStrategy.mockRejectedValue(new Error('Strategy already active'));

    const response = await handleStartStrategy(
      {
        userId: 'user-123',
        groupId: 'group-1',
        strategy: 'persistence',
        verificationMode: 'self',
      },
      dc
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Strategy already active');
  });

  it('should handle null nextTask in response', async () => {
    mocks.startStrategy.mockResolvedValue({
      action: 'group_complete',
      nextTask: null,
      stats: { total: 0, completed: 0 },
    });

    const response = await handleStartStrategy(
      {
        userId: 'user-123',
        groupId: 'group-1',
        strategy: 'persistence',
        verificationMode: 'self',
      },
      dc
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.nextTask).toBeNull();
  });
});

describe('handlePauseStrategy', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should pause strategy and return result', async () => {
    mocks.pauseStrategy.mockResolvedValue({
      id: 'group-1',
      title: 'My Strategy',
      status: 'paused',
      strategy: 'persistence',
      strategy_paused_at: '2026-04-12T10:00:00Z',
    });

    const response = await handlePauseStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.status).toBe('paused');
    expect(data.pausedAt).toBe('2026-04-12T10:00:00Z');

    expect(mocks.pauseStrategy).toHaveBeenCalledWith('group-1', 'user-123');
  });

  it('should return error on service failure', async () => {
    mocks.pauseStrategy.mockRejectedValue(new Error('Strategy is not active'));

    const response = await handlePauseStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Strategy is not active');
  });
});

describe('handleResumeStrategy', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should resume strategy and return next task', async () => {
    mocks.resumeStrategy.mockResolvedValue({
      action: 'next_task',
      nextTask: {
        id: 'task-3',
        title: 'Resume from here',
        description: 'Continue working',
        task_order: 2,
        status: 'in_progress',
      },
      prompt: 'Resuming persistence strategy...',
    });

    const response = await handleResumeStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.action).toBe('next_task');
    expect(data.nextTask).toMatchObject({
      id: 'task-3',
      title: 'Resume from here',
      taskOrder: 2,
    });

    expect(mocks.resumeStrategy).toHaveBeenCalledWith('group-1', 'user-123');
  });

  it('should return error when strategy is not paused', async () => {
    mocks.resumeStrategy.mockRejectedValue(new Error('Strategy is not paused'));

    const response = await handleResumeStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Strategy is not paused');
  });
});

describe('handleCancelStrategy', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should cancel strategy and pass reason to service', async () => {
    mocks.cancelStrategy.mockResolvedValue({
      id: 'group-1',
      title: 'My Strategy',
      status: 'cancelled',
      strategy: 'persistence',
    });

    const response = await handleCancelStrategy(
      { userId: 'user-123', groupId: 'group-1', reason: 'scope changed' },
      dc
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.status).toBe('cancelled');
    expect(data.reason).toBe('scope changed');
    expect(mocks.cancelStrategy).toHaveBeenCalledWith('group-1', 'user-123', 'scope changed');
  });

  it('should work without a reason', async () => {
    mocks.cancelStrategy.mockResolvedValue({
      id: 'group-1',
      title: 'My Strategy',
      status: 'cancelled',
      strategy: 'persistence',
    });

    const response = await handleCancelStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.reason).toBeNull();
    expect(mocks.cancelStrategy).toHaveBeenCalledWith('group-1', 'user-123', undefined);
  });

  it('should return error when strategy is already completed', async () => {
    mocks.cancelStrategy.mockRejectedValue(new Error('Strategy is already completed'));

    const response = await handleCancelStrategy({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Strategy is already completed');
  });
});

describe('handleGetStrategyStatus', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should return formatted status with progress', async () => {
    mocks.getStrategyStatus.mockResolvedValue({
      groupId: 'group-1',
      title: 'Test Strategy',
      strategy: 'persistence',
      status: 'active',
      progress: {
        total: 5,
        completed: 3,
        pending: 1,
        inProgress: 1,
        blocked: 0,
        completionRate: 60,
      },
      currentTask: {
        id: 'task-4',
        title: 'Current work',
        status: 'in_progress',
        taskOrder: 3,
      },
      summary: '"Test Strategy" — 3/5 tasks done (60%) — working on: "Current work"',
    });

    const response = await handleGetStrategyStatus({ userId: 'user-123', groupId: 'group-1' }, dc);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.progress.total).toBe(5);
    expect(data.progress.completed).toBe(3);
    expect(data.progress.completionRate).toBe(60);
    expect(data.summary).toContain('3/5 tasks done');

    expect(mocks.getStrategyStatus).toHaveBeenCalledWith('group-1', 'user-123');
  });
});
