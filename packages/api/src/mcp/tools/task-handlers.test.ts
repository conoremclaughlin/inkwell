/**
 * Task Handler Tests
 *
 * Tests for MCP tool handlers related to task creation,
 * listing, updating, completion, and stats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleCreateTask,
  handleListTasks,
  handleUpdateTask,
  handleCompleteTask,
  handleGetTaskStats,
} from './task-handlers';

// =====================================================
// MOCK SETUP
// =====================================================

// Mock user-resolver: preserve the real schema but mock resolveUser
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

// Mock enforce-identity
vi.mock('../../auth/enforce-identity', () => ({
  getEffectiveAgentId: vi.fn().mockReturnValue('wren'),
}));

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
  pinSessionAgent: vi.fn(),
  getPinnedAgentId: vi.fn().mockReturnValue(null),
  getRequestContext: vi.fn().mockReturnValue(undefined),
}));

/**
 * Creates a mock DataComposer with repositories.
 * Repositories use vi.fn() so each test can configure return values.
 */
function createMockDataComposer() {
  const mockTasksRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    listByUser: vi.fn(),
    listActiveTasks: vi.fn(),
    update: vi.fn(),
    completeTask: vi.fn(),
    getProjectStats: vi.fn(),
  };

  const mockProjectsRepo = {
    findById: vi.fn(),
  };

  const mockMemoryRepo = {
    remember: vi.fn(),
  };

  return {
    getClient: vi.fn(),
    repositories: {
      tasks: mockTasksRepo,
      projects: mockProjectsRepo,
      memory: mockMemoryRepo,
    },
  };
}

// Import the mock so we can manipulate resolveUser per-test
import { resolveUser } from '../../services/user-resolver';

const resolveUserMock = vi.mocked(resolveUser);

function parseResponse(response: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(response.content[0].text);
}

// =====================================================
// handleCreateTask
// =====================================================

describe('handleCreateTask', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should create a task successfully', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-123',
      name: 'Test Project',
    });
    dc.repositories.tasks.create.mockResolvedValue({
      id: 'task-1',
      title: 'Implement feature X',
      description: 'Build the new feature',
      status: 'pending',
      priority: 'high',
      tags: ['backend'],
      created_at: '2026-03-10T10:00:00Z',
    });

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        projectId: 'proj-1',
        title: 'Implement feature X',
        description: 'Build the new feature',
        priority: 'high',
        tags: ['backend'],
        createdBy: 'wren',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.task.id).toBe('task-1');
    expect(data.task.title).toBe('Implement feature X');
    expect(data.task.description).toBe('Build the new feature');
    expect(data.task.status).toBe('pending');
    expect(data.task.priority).toBe('high');
    expect(data.task.tags).toEqual(['backend']);

    expect(dc.repositories.tasks.create).toHaveBeenCalledWith({
      project_id: 'proj-1',
      user_id: 'user-123',
      title: 'Implement feature X',
      description: 'Build the new feature',
      priority: 'high',
      tags: ['backend'],
      created_by: 'wren',
    });
  });

  it('should default createdBy to "claude" when not provided', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-123',
      name: 'Test Project',
    });
    dc.repositories.tasks.create.mockResolvedValue({
      id: 'task-1',
      title: 'Some task',
      status: 'pending',
      priority: 'medium',
      tags: null,
      created_at: '2026-03-10T10:00:00Z',
    });

    await handleCreateTask(
      {
        userId: 'user-123',
        projectId: 'proj-1',
        title: 'Some task',
        priority: 'medium',
      },
      dc as any
    );

    expect(dc.repositories.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: 'claude' })
    );
  });

  it('should return error when user is not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleCreateTask(
      {
        userId: 'nonexistent',
        projectId: 'proj-1',
        title: 'Some task',
        priority: 'medium',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
    expect(dc.repositories.projects.findById).not.toHaveBeenCalled();
  });

  it('should return error when project is not found', async () => {
    dc.repositories.projects.findById.mockResolvedValue(null);

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        projectId: 'proj-nonexistent',
        title: 'Some task',
        priority: 'medium',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Project not found');
    expect(dc.repositories.tasks.create).not.toHaveBeenCalled();
  });

  it('should return error when project does not belong to user', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'other-user-456',
      name: 'Someone Elses Project',
    });

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        projectId: 'proj-1',
        title: 'Some task',
        priority: 'medium',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Project does not belong to this user');
    expect(dc.repositories.tasks.create).not.toHaveBeenCalled();
  });
});

// =====================================================
// handleListTasks
// =====================================================

describe('handleListTasks', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  const sampleTasks = [
    {
      id: 'task-1',
      title: 'Task one',
      description: 'First task',
      status: 'pending',
      priority: 'high',
      tags: ['api'],
      project_id: 'proj-1',
      created_at: '2026-03-09T10:00:00Z',
      completed_at: null,
    },
    {
      id: 'task-2',
      title: 'Task two',
      description: null,
      status: 'in_progress',
      priority: 'medium',
      tags: null,
      project_id: 'proj-1',
      created_at: '2026-03-10T10:00:00Z',
      completed_at: null,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should list tasks in activeOnly mode', async () => {
    dc.repositories.tasks.listActiveTasks.mockResolvedValue(sampleTasks);
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
    });

    const response = await handleListTasks(
      {
        userId: 'user-123',
        activeOnly: true,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(2);
    expect(dc.repositories.tasks.listActiveTasks).toHaveBeenCalledWith('user-123', undefined);
    expect(dc.repositories.tasks.listByUser).not.toHaveBeenCalled();
  });

  it('should list tasks filtered by status', async () => {
    const completedTasks = [
      {
        id: 'task-3',
        title: 'Completed task',
        description: 'Done',
        status: 'completed',
        priority: 'low',
        tags: [],
        project_id: null,
        created_at: '2026-03-08T10:00:00Z',
        completed_at: '2026-03-10T15:00:00Z',
      },
    ];
    dc.repositories.tasks.listByUser.mockResolvedValue(completedTasks);

    const response = await handleListTasks(
      {
        userId: 'user-123',
        status: 'completed',
        activeOnly: false,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].status).toBe('completed');
    expect(data.tasks[0].completedAt).toBe('2026-03-10T15:00:00Z');
    expect(dc.repositories.tasks.listByUser).toHaveBeenCalledWith('user-123', {
      status: 'completed',
      projectId: undefined,
      limit: 50,
    });
  });

  it('should enrich tasks with project names', async () => {
    dc.repositories.tasks.listByUser.mockResolvedValue(sampleTasks);
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      name: 'My Project',
    });

    const response = await handleListTasks(
      {
        userId: 'user-123',
        activeOnly: false,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    // Both tasks have proj-1, so findById should be called once (deduped by Set)
    expect(dc.repositories.projects.findById).toHaveBeenCalledTimes(1);
    expect(dc.repositories.projects.findById).toHaveBeenCalledWith('proj-1');
    expect(data.tasks[0].projectName).toBe('My Project');
    expect(data.tasks[1].projectName).toBe('My Project');
  });

  it('should set projectName to null when task has no project', async () => {
    const tasksWithoutProject = [
      {
        id: 'task-4',
        title: 'Unscoped task',
        description: null,
        status: 'pending',
        priority: 'medium',
        tags: null,
        project_id: null,
        created_at: '2026-03-10T10:00:00Z',
        completed_at: null,
      },
    ];
    dc.repositories.tasks.listByUser.mockResolvedValue(tasksWithoutProject);

    const response = await handleListTasks(
      {
        userId: 'user-123',
        activeOnly: false,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.tasks[0].projectName).toBeNull();
    // No project to look up
    expect(dc.repositories.projects.findById).not.toHaveBeenCalled();
  });

  it('should return "Unknown" when project lookup returns null', async () => {
    const tasksWithMissingProject = [
      {
        id: 'task-5',
        title: 'Orphaned task',
        description: null,
        status: 'pending',
        priority: 'medium',
        tags: null,
        project_id: 'proj-deleted',
        created_at: '2026-03-10T10:00:00Z',
        completed_at: null,
      },
    ];
    dc.repositories.tasks.listByUser.mockResolvedValue(tasksWithMissingProject);
    dc.repositories.projects.findById.mockResolvedValue(null);

    const response = await handleListTasks(
      {
        userId: 'user-123',
        activeOnly: false,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.tasks[0].projectName).toBe('Unknown');
  });

  it('should return error when user is not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleListTasks(
      {
        userId: 'nonexistent',
        activeOnly: false,
        limit: 50,
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
  });
});

// =====================================================
// handleUpdateTask
// =====================================================

describe('handleUpdateTask', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should update a task successfully', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Old title',
      status: 'pending',
    });
    dc.repositories.tasks.update.mockResolvedValue({
      id: 'task-1',
      title: 'New title',
      description: 'Updated description',
      status: 'in_progress',
      priority: 'high',
      tags: ['updated'],
      completed_at: null,
    });

    const response = await handleUpdateTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
        title: 'New title',
        description: 'Updated description',
        status: 'in_progress',
        priority: 'high',
        tags: ['updated'],
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.task.title).toBe('New title');
    expect(data.task.status).toBe('in_progress');
    expect(data.task.priority).toBe('high');
    expect(data.task.tags).toEqual(['updated']);

    expect(dc.repositories.tasks.update).toHaveBeenCalledWith('task-1', {
      title: 'New title',
      description: 'Updated description',
      status: 'in_progress',
      priority: 'high',
      tags: ['updated'],
    });
  });

  it('should only include provided fields in update payload', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Original',
      status: 'pending',
    });
    dc.repositories.tasks.update.mockResolvedValue({
      id: 'task-1',
      title: 'Original',
      description: null,
      status: 'in_progress',
      priority: 'medium',
      tags: null,
      completed_at: null,
    });

    await handleUpdateTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
        status: 'in_progress',
      },
      dc as any
    );

    // Only status should be in the updates object
    expect(dc.repositories.tasks.update).toHaveBeenCalledWith('task-1', {
      status: 'in_progress',
    });
  });

  it('should return error when task is not found', async () => {
    dc.repositories.tasks.findById.mockResolvedValue(null);

    const response = await handleUpdateTask(
      {
        userId: 'user-123',
        taskId: 'task-nonexistent',
        title: 'Whatever',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Task not found');
    expect(dc.repositories.tasks.update).not.toHaveBeenCalled();
  });

  it('should return error when task does not belong to user', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'other-user-456',
      title: 'Not yours',
    });

    const response = await handleUpdateTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
        title: 'Trying to update',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Task does not belong to this user');
    expect(dc.repositories.tasks.update).not.toHaveBeenCalled();
  });

  it('should return error when user is not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleUpdateTask(
      {
        userId: 'nonexistent',
        taskId: 'task-1',
        title: 'Whatever',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
  });
});

// =====================================================
// handleCompleteTask
// =====================================================

describe('handleCompleteTask', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should complete a task successfully', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      description: 'Implement the new feature',
      status: 'completed',
      priority: 'high',
      tags: ['backend'],
      project_id: 'proj-1',
      completed_at: '2026-03-10T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });

    const response = await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.task.id).toBe('task-1');
    expect(data.task.title).toBe('Build feature');
    expect(data.task.status).toBe('completed');
    expect(data.task.completedAt).toBe('2026-03-10T15:00:00Z');
  });

  it('should auto-remember task completion as a memory', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      description: 'Implement the new feature',
      status: 'completed',
      priority: 'critical',
      tags: ['backend', 'api'],
      project_id: 'proj-1',
      completed_at: '2026-03-10T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });

    await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
      },
      dc as any
    );

    expect(dc.repositories.memory.remember).toHaveBeenCalledWith({
      userId: 'user-123',
      content: 'Completed task: Build feature — Implement the new feature',
      summary: 'Completed: Build feature',
      topicKey: 'project:proj-1',
      source: 'session',
      salience: 'high', // critical priority maps to 'high'
      topics: ['task:task-1', 'backend', 'api', 'project:proj-1'],
      agentId: 'wren',
      metadata: { taskId: 'task-1', autoCreated: true },
    });
  });

  it('should set salience to medium for low/medium priority tasks', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Minor fix',
      status: 'pending',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Minor fix',
      description: null,
      status: 'completed',
      priority: 'low',
      tags: null,
      project_id: null,
      completed_at: '2026-03-10T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });

    await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
      },
      dc as any
    );

    expect(dc.repositories.memory.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        salience: 'medium',
        content: 'Completed task: Minor fix', // no description suffix
        topicKey: undefined, // no project_id
      })
    );
  });

  it('should not include project topic when task has no project_id', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-2',
      user_id: 'user-123',
      title: 'Standalone task',
      status: 'pending',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-2',
      title: 'Standalone task',
      description: null,
      status: 'completed',
      priority: 'medium',
      tags: ['misc'],
      project_id: null,
      completed_at: '2026-03-10T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });

    await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-2',
      },
      dc as any
    );

    expect(dc.repositories.memory.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        topics: ['task:task-2', 'misc'], // no project:... entry
        topicKey: undefined,
      })
    );
  });

  it('should succeed even if auto-remember fails', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      description: null,
      status: 'completed',
      priority: 'medium',
      tags: null,
      project_id: null,
      completed_at: '2026-03-10T15:00:00Z',
    });
    dc.repositories.memory.remember.mockRejectedValue(new Error('Memory DB error'));

    const response = await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
      },
      dc as any
    );

    // Task completion should still succeed
    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.task.status).toBe('completed');
  });

  it('should return error when task is not found', async () => {
    dc.repositories.tasks.findById.mockResolvedValue(null);

    const response = await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-nonexistent',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Task not found');
    expect(dc.repositories.tasks.completeTask).not.toHaveBeenCalled();
  });

  it('should return error when task does not belong to user', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'other-user-456',
      title: 'Not yours',
    });

    const response = await handleCompleteTask(
      {
        userId: 'user-123',
        taskId: 'task-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Task does not belong to this user');
    expect(dc.repositories.tasks.completeTask).not.toHaveBeenCalled();
  });

  it('should return error when user is not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleCompleteTask(
      {
        userId: 'nonexistent',
        taskId: 'task-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
  });
});

// =====================================================
// handleGetTaskStats
// =====================================================

describe('handleGetTaskStats', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should return task stats with completion rate', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-123',
      name: 'My Project',
    });
    dc.repositories.tasks.getProjectStats.mockResolvedValue({
      total: 10,
      completed: 7,
      pending: 2,
      in_progress: 1,
      blocked: 0,
    });

    const response = await handleGetTaskStats(
      {
        userId: 'user-123',
        projectId: 'proj-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.stats.projectId).toBe('proj-1');
    expect(data.stats.projectName).toBe('My Project');
    expect(data.stats.total).toBe(10);
    expect(data.stats.completed).toBe(7);
    expect(data.stats.completionRate).toBe(70);
  });

  it('should return 0 completion rate when no tasks exist', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-123',
      name: 'Empty Project',
    });
    dc.repositories.tasks.getProjectStats.mockResolvedValue({
      total: 0,
      completed: 0,
      pending: 0,
      in_progress: 0,
      blocked: 0,
    });

    const response = await handleGetTaskStats(
      {
        userId: 'user-123',
        projectId: 'proj-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.stats.completionRate).toBe(0);
    expect(data.stats.total).toBe(0);
  });

  it('should round completion rate to nearest integer', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-123',
      name: 'Project',
    });
    dc.repositories.tasks.getProjectStats.mockResolvedValue({
      total: 3,
      completed: 1,
      pending: 1,
      in_progress: 1,
      blocked: 0,
    });

    const response = await handleGetTaskStats(
      {
        userId: 'user-123',
        projectId: 'proj-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    // 1/3 = 33.33... -> rounds to 33
    expect(data.stats.completionRate).toBe(33);
  });

  it('should return error when project is not found', async () => {
    dc.repositories.projects.findById.mockResolvedValue(null);

    const response = await handleGetTaskStats(
      {
        userId: 'user-123',
        projectId: 'proj-nonexistent',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Project not found');
    expect(dc.repositories.tasks.getProjectStats).not.toHaveBeenCalled();
  });

  it('should return error when project does not belong to user', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'other-user-456',
      name: 'Not Yours',
    });

    const response = await handleGetTaskStats(
      {
        userId: 'user-123',
        projectId: 'proj-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Project does not belong to this user');
    expect(dc.repositories.tasks.getProjectStats).not.toHaveBeenCalled();
  });

  it('should return error when user is not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleGetTaskStats(
      {
        userId: 'nonexistent',
        projectId: 'proj-1',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.error).toBe('User not found');
  });
});
