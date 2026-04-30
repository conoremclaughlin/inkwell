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
  handleCreateTaskGroup,
  handleListTaskGroups,
  handleUpdateTaskGroup,
  handleCloseTask,
  handleCloseTaskGroup,
  handleAddTaskGroupComment,
  handleListTaskGroupComments,
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
    findByGroupId: vi.fn(),
    listByUser: vi.fn(),
    listActiveTasks: vi.fn(),
    update: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    closeTask: vi.fn(),
    getProjectStats: vi.fn(),
  };

  const mockTaskGroupsRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    listByUser: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findActiveStrategies: vi.fn(),
    taskCountsByGroup: vi.fn().mockResolvedValue({}),
  };

  const mockProjectsRepo = {
    findById: vi.fn(),
  };

  const mockMemoryRepo = {
    remember: vi.fn(),
  };

  const mockActivityStreamRepo = {
    logActivity: vi.fn().mockResolvedValue({ id: 'activity-1' }),
  };

  // Minimal supabase client stub for identity/agent_identities lookups
  // and task_group_comments inserts/queries.
  const identityChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'comment-auto',
            task_group_id: 'group-1',
            content: '',
            comment_type: 'conclusion',
            created_at: '2026-04-29T10:00:00Z',
          },
          error: null,
        }),
      }),
    }),
    then: undefined as unknown,
  };
  const mockClient = {
    from: vi.fn().mockReturnValue(identityChain),
  };

  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    repositories: {
      tasks: mockTasksRepo,
      taskGroups: mockTaskGroupsRepo,
      projects: mockProjectsRepo,
      memory: mockMemoryRepo,
      activityStream: mockActivityStreamRepo,
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
      completed_at: null,
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

    // Status + completed_at clearing for non-completed transitions
    expect(dc.repositories.tasks.update).toHaveBeenCalledWith('task-1', {
      status: 'in_progress',
      completed_at: null,
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

// =====================================================
// handleCreateTask — task group support
// =====================================================

describe('handleCreateTask — task group support', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should create a task with taskGroupId and taskOrder', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'user-123',
      title: 'Build OAuth',
    });
    dc.repositories.tasks.create.mockResolvedValue({
      id: 'task-1',
      title: 'Implement /token endpoint',
      description: 'Build the token exchange',
      status: 'pending',
      priority: 'high',
      tags: [],
      task_group_id: 'group-1',
      task_order: 2,
      created_at: '2026-04-09T10:00:00Z',
    });

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        taskGroupId: 'group-1',
        taskOrder: 2,
        title: 'Implement /token endpoint',
        description: 'Build the token exchange',
        priority: 'high',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.task.taskGroupId).toBe('group-1');
    expect(data.task.taskOrder).toBe(2);
    expect(dc.repositories.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        task_group_id: 'group-1',
        task_order: 2,
      })
    );
  });

  it('should create a standalone task without projectId or groupId', async () => {
    dc.repositories.tasks.create.mockResolvedValue({
      id: 'task-1',
      title: 'Quick note',
      status: 'pending',
      priority: 'medium',
      tags: [],
      task_group_id: null,
      task_order: null,
      created_at: '2026-04-09T10:00:00Z',
    });

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        title: 'Quick note',
        priority: 'medium',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.task.taskGroupId).toBeNull();
    expect(dc.repositories.projects.findById).not.toHaveBeenCalled();
    expect(dc.repositories.taskGroups.findById).not.toHaveBeenCalled();
  });

  it('should return error when task group does not belong to user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'other-user-456',
      title: 'Not yours',
    });

    const response = await handleCreateTask(
      {
        userId: 'user-123',
        taskGroupId: 'group-1',
        title: 'Some task',
        priority: 'medium',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group does not belong to this user');
  });
});

// =====================================================
// handleCreateTaskGroup
// =====================================================

describe('handleCreateTaskGroup', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('creates a task group and returns normalized fields', async () => {
    dc.repositories.taskGroups.create.mockResolvedValue({
      id: 'grp-1',
      user_id: 'user-123',
      identity_id: null,
      project_id: null,
      title: 'Ship feature X',
      description: 'Multi-PR rollout',
      status: 'active',
      priority: 'high',
      tags: ['feature'],
      metadata: {},
      autonomous: false,
      max_sessions: null,
      sessions_used: 0,
      context_summary: null,
      next_run_after: null,
      output_target: 'pr',
      output_status: null,
      thread_key: 'thread:feat-x',
      created_at: '2026-04-16T10:00:00Z',
      updated_at: '2026-04-16T10:00:00Z',
    });

    const response = await handleCreateTaskGroup(
      {
        userId: 'user-123',
        title: 'Ship feature X',
        description: 'Multi-PR rollout',
        priority: 'high',
        status: 'active',
        tags: ['feature'],
        outputTarget: 'pr',
        threadKey: 'thread:feat-x',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.group.id).toBe('grp-1');
    expect(data.group.title).toBe('Ship feature X');
    expect(data.group.priority).toBe('high');
    expect(data.group.outputTarget).toBe('pr');
    expect(data.group.threadKey).toBe('thread:feat-x');
    expect(dc.repositories.taskGroups.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        title: 'Ship feature X',
        description: 'Multi-PR rollout',
        status: 'active',
        priority: 'high',
        tags: ['feature'],
        output_target: 'pr',
        thread_key: 'thread:feat-x',
      })
    );
  });

  it('validates project ownership when projectId is provided', async () => {
    dc.repositories.projects.findById.mockResolvedValue({
      id: 'proj-1',
      user_id: 'other-user-999',
      name: 'Not yours',
    });

    const response = await handleCreateTaskGroup(
      {
        userId: 'user-123',
        title: 'Scoped group',
        projectId: '00000000-0000-0000-0000-000000000001',
        priority: 'normal',
        status: 'active',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Project does not belong to this user');
    expect(dc.repositories.taskGroups.create).not.toHaveBeenCalled();
  });

  it('returns error when user is not found (create)', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleCreateTaskGroup(
      {
        userId: 'nonexistent',
        title: 'Anything',
        priority: 'normal',
        status: 'active',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('User not found');
    expect(dc.repositories.taskGroups.create).not.toHaveBeenCalled();
  });
});

// =====================================================
// handleUpdateTaskGroup
// =====================================================

describe('handleUpdateTaskGroup', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  const existingGroup = {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 'user-123',
    identity_id: null,
    project_id: null,
    title: 'Feature X',
    description: null,
    status: 'active',
    priority: 'normal',
    tags: [],
    metadata: { preset: 'wren' },
    autonomous: false,
    max_sessions: null,
    sessions_used: 0,
    context_summary: null,
    next_run_after: null,
    output_target: null,
    output_status: null,
    thread_key: null,
    owner_agent_id: null,
    created_at: '2026-04-18T10:00:00Z',
    updated_at: '2026-04-18T10:00:00Z',
  };

  it('closes a group with completed status and records closedReason in metadata', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      status: 'completed',
      metadata: { preset: 'wren', closed_reason: 'Shipped via PR #100' },
    });

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        status: 'completed',
        closedReason: 'Shipped via PR #100',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.group.status).toBe('completed');
    expect(data.group.metadata).toEqual({ preset: 'wren', closed_reason: 'Shipped via PR #100' });

    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      expect.objectContaining({
        status: 'completed',
        metadata: { preset: 'wren', closed_reason: 'Shipped via PR #100' },
      })
    );
  });

  it('merges metadata by default, preserving existing keys', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      metadata: { preset: 'wren', studioSlug: 'wren-omega' },
    });

    await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        metadata: { studioSlug: 'wren-omega' },
      } as any,
      dc as any
    );

    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      expect.objectContaining({
        metadata: { preset: 'wren', studioSlug: 'wren-omega' },
      })
    );
  });

  it('replaces metadata when mergeMetadata is false', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      metadata: { studioSlug: 'wren-omega' },
    });

    await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        metadata: { studioSlug: 'wren-omega' },
        mergeMetadata: false,
      } as any,
      dc as any
    );

    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      expect.objectContaining({
        metadata: { studioSlug: 'wren-omega' },
      })
    );
  });

  it('rejects update when group belongs to a different user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      ...existingGroup,
      user_id: 'someone-else',
    });

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        status: 'completed',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group does not belong to this user');
    expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
  });

  it('returns error when group does not exist', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(null);

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        status: 'completed',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group not found');
    expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
  });

  it('rejects identityId that does not belong to this user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    // Identity lookup returns nothing — not owned by this user
    (dc.getClient() as any).from().single.mockResolvedValueOnce({ data: null, error: null });

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        identityId: '99999999-9999-9999-9999-999999999999',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('identityId not found or does not belong to this user/workspace.');
    expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
  });

  it('scopes identityId lookup to the workspace when request context supplies one', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    const { getRequestContext } = await import('../../utils/request-context');
    (getRequestContext as any).mockReturnValueOnce({
      workspaceId: 'ws-match',
    });
    // Identity lookup returns nothing — same user, but different workspace
    const chain = (dc.getClient() as any).from();
    chain.single.mockResolvedValueOnce({ data: null, error: null });

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        identityId: '77777777-7777-7777-7777-777777777777',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('identityId not found or does not belong to this user/workspace.');
    expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'ws-match');
    expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
  });

  it('accepts identityId that belongs to this user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    (dc.getClient() as any).from().single.mockResolvedValueOnce({
      data: { id: '77777777-7777-7777-7777-777777777777' },
      error: null,
    });
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      identity_id: '77777777-7777-7777-7777-777777777777',
    });

    const response = await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        identityId: '77777777-7777-7777-7777-777777777777',
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      expect.objectContaining({
        identity_id: '77777777-7777-7777-7777-777777777777',
      })
    );
  });

  it('accepts explicit null identityId as a clear without a lookup', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      identity_id: null,
    });

    await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        identityId: null,
      } as any,
      dc as any
    );

    // No identity lookup should have been issued — null bypasses validation.
    const fromMock = (dc.getClient() as any).from;
    expect(fromMock).not.toHaveBeenCalledWith('agent_identities');
    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555',
      expect.objectContaining({
        identity_id: null,
      })
    );
  });

  it('does not touch identity_id when identityId is not provided', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(existingGroup);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...existingGroup,
      status: 'paused',
    });

    await handleUpdateTaskGroup(
      {
        userId: 'user-123',
        groupId: '11111111-2222-3333-4444-555555555555',
        status: 'paused',
      } as any,
      dc as any
    );

    const fromMock = (dc.getClient() as any).from;
    expect(fromMock).not.toHaveBeenCalledWith('agent_identities');
    // Repository sees undefined for identity_id — repository's upsert logic is
    // then responsible for leaving the column alone.
    const call = (dc.repositories.taskGroups.update as any).mock.calls[0][1];
    expect(call.identity_id).toBeUndefined();
  });
});

// =====================================================
// handleCompleteTask — strategy advancement
// =====================================================

describe('handleCompleteTask — strategy advancement', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('should check for strategy group when completing a task with task_group_id', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'First task',
      status: 'in_progress',
      task_group_id: 'group-1',
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'First task',
      description: null,
      status: 'completed',
      priority: 'medium',
      tags: [],
      project_id: null,
      task_group_id: 'group-1',
      completed_at: '2026-04-09T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });
    // Group without active strategy — should not try to advance
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'user-123',
      title: 'Build OAuth',
      status: 'active',
      strategy: null,
      strategy_config: {},
    });

    const response = await handleCompleteTask({ userId: 'user-123', taskId: 'task-1' }, dc as any);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    // Verifies the task group was looked up
    expect(dc.repositories.taskGroups.findById).toHaveBeenCalledWith('group-1');
    // No strategy set → no strategy advancement
    expect(data.strategy).toBeUndefined();
  });

  it('should not include strategy field for tasks without a group', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Standalone task',
      status: 'in_progress',
      task_group_id: null,
    });
    dc.repositories.tasks.completeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Standalone task',
      description: null,
      status: 'completed',
      priority: 'medium',
      tags: [],
      project_id: null,
      task_group_id: null,
      completed_at: '2026-04-09T15:00:00Z',
    });
    dc.repositories.memory.remember.mockResolvedValue({ id: 'mem-1' });

    const response = await handleCompleteTask({ userId: 'user-123', taskId: 'task-1' }, dc as any);

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.strategy).toBeUndefined();
  });
});

// =====================================================
// handleListTaskGroups
// =====================================================

describe('handleListTaskGroups', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  const sampleGroups = [
    {
      id: 'grp-1',
      user_id: 'user-123',
      identity_id: null,
      project_id: null,
      title: 'Active group',
      description: null,
      status: 'active',
      priority: 'high',
      tags: [],
      metadata: {},
      autonomous: false,
      max_sessions: null,
      sessions_used: 0,
      context_summary: null,
      next_run_after: null,
      output_target: null,
      output_status: null,
      thread_key: null,
      created_at: '2026-04-16T10:00:00Z',
      updated_at: '2026-04-16T10:00:00Z',
    },
    {
      id: 'grp-2',
      user_id: 'user-123',
      identity_id: null,
      project_id: null,
      title: 'Completed group',
      description: null,
      status: 'completed',
      priority: 'normal',
      tags: [],
      metadata: {},
      autonomous: false,
      max_sessions: null,
      sessions_used: 0,
      context_summary: null,
      next_run_after: null,
      output_target: null,
      output_status: null,
      thread_key: null,
      created_at: '2026-04-15T10:00:00Z',
      updated_at: '2026-04-15T10:00:00Z',
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

  it('returns all groups when statuses is omitted', async () => {
    dc.repositories.taskGroups.listByUser.mockResolvedValue(sampleGroups);
    dc.repositories.taskGroups.taskCountsByGroup.mockResolvedValue({
      'grp-1': { total: 3, pending: 1, in_progress: 1, completed: 1, blocked: 0 },
    });

    const response = await handleListTaskGroups(
      {
        userId: 'user-123',
        autonomousOnly: false,
        includeTaskCounts: true,
        limit: 200,
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.groups).toHaveLength(2);
    expect(dc.repositories.taskGroups.listByUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ status: undefined, limit: 200 })
    );
    expect(data.groups[0].taskCounts).toEqual({
      total: 3,
      pending: 1,
      in_progress: 1,
      completed: 1,
      blocked: 0,
    });
    expect(data.groups[1].taskCounts.total).toBe(0);
  });

  it('treats empty statuses array the same as omitted (all statuses)', async () => {
    dc.repositories.taskGroups.listByUser.mockResolvedValue(sampleGroups);

    await handleListTaskGroups(
      {
        userId: 'user-123',
        statuses: [],
        autonomousOnly: false,
        includeTaskCounts: false,
        limit: 200,
      } as any,
      dc as any
    );

    expect(dc.repositories.taskGroups.listByUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ status: undefined })
    );
  });

  it('passes statuses array through to the repository', async () => {
    dc.repositories.taskGroups.listByUser.mockResolvedValue([sampleGroups[0]]);

    await handleListTaskGroups(
      {
        userId: 'user-123',
        statuses: ['active', 'paused'],
        autonomousOnly: false,
        includeTaskCounts: false,
        limit: 200,
      } as any,
      dc as any
    );

    expect(dc.repositories.taskGroups.listByUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ status: ['active', 'paused'] })
    );
  });

  it('supports single-element statuses arrays', async () => {
    dc.repositories.taskGroups.listByUser.mockResolvedValue([sampleGroups[1]]);

    await handleListTaskGroups(
      {
        userId: 'user-123',
        statuses: ['completed'],
        autonomousOnly: false,
        includeTaskCounts: false,
        limit: 200,
      } as any,
      dc as any
    );

    expect(dc.repositories.taskGroups.listByUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ status: ['completed'] })
    );
  });

  it('skips count aggregation when includeTaskCounts=false', async () => {
    dc.repositories.taskGroups.listByUser.mockResolvedValue(sampleGroups);

    const response = await handleListTaskGroups(
      {
        userId: 'user-123',
        autonomousOnly: false,
        includeTaskCounts: false,
        limit: 200,
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(dc.repositories.taskGroups.taskCountsByGroup).not.toHaveBeenCalled();
    expect(data.groups[0].taskCounts).toBeUndefined();
  });

  it('returns error when user is not found (list)', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleListTaskGroups(
      {
        userId: 'nonexistent',
        autonomousOnly: false,
        includeTaskCounts: true,
        limit: 200,
      } as any,
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('User not found');
    expect(dc.repositories.taskGroups.listByUser).not.toHaveBeenCalled();
  });
});

// =====================================================
// handleCloseTask
// =====================================================

describe('handleCloseTask', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('closes a task with completed outcome', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
      task_group_id: null,
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      status: 'completed',
      outcome: 'completed',
      outcome_reason: null,
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: null,
    });

    const response = await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'completed', summary: 'Done!' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBeFalsy();
    expect(data.success).toBe(true);
    expect(data.task.outcome).toBe('completed');
    expect(data.task.completedAt).toBe('2026-04-29T10:00:00Z');
    expect(dc.repositories.tasks.closeTask).toHaveBeenCalledWith('task-1', 'completed', undefined);
  });

  it('closes a task with skipped outcome and reason', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-2',
      user_id: 'user-123',
      title: 'Optional cleanup',
      status: 'pending',
      task_group_id: null,
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-2',
      title: 'Optional cleanup',
      status: 'blocked',
      outcome: 'skipped',
      outcome_reason: 'Not needed after refactor',
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: null,
    });

    const response = await handleCloseTask(
      {
        userId: 'user-123',
        taskId: 'task-2',
        outcome: 'skipped',
        reason: 'Not needed after refactor',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.task.outcome).toBe('skipped');
    expect(data.task.outcomeReason).toBe('Not needed after refactor');
    expect(dc.repositories.tasks.closeTask).toHaveBeenCalledWith(
      'task-2',
      'skipped',
      'Not needed after refactor'
    );
  });

  it('logs task_completed activity for completed outcome', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
      task_group_id: 'group-1',
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      status: 'completed',
      outcome: 'completed',
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: 'group-1',
    });
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'user-123',
      strategy: null,
      status: 'active',
    });

    await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'completed', summary: 'Shipped it' },
      dc as any
    );

    expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'task_completed',
        taskGroupId: 'group-1',
        payload: expect.objectContaining({
          taskId: 'task-1',
          outcome: 'completed',
          summary: 'Shipped it',
        }),
      })
    );
  });

  it('logs task_closed activity for non-completed outcomes', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Broken thing',
      status: 'in_progress',
      task_group_id: null,
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Broken thing',
      status: 'blocked',
      outcome: 'failed',
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: null,
    });

    await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'failed', reason: 'Dependency missing' },
      dc as any
    );

    expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'task_closed',
        payload: expect.objectContaining({
          outcome: 'failed',
          reason: 'Dependency missing',
        }),
      })
    );
  });

  it('advances strategy when closing a task in a strategy group', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Step 1',
      status: 'in_progress',
      task_group_id: 'group-1',
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Step 1',
      status: 'completed',
      outcome: 'completed',
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: 'group-1',
    });
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'user-123',
      strategy: 'persistence',
      status: 'active',
      strategy_config: {},
    });

    const response = await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(dc.repositories.taskGroups.findById).toHaveBeenCalledWith('group-1');
  });

  it('returns error when task not found', async () => {
    dc.repositories.tasks.findById.mockResolvedValue(null);

    const response = await handleCloseTask(
      { userId: 'user-123', taskId: 'task-404', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task not found');
    expect(dc.repositories.tasks.closeTask).not.toHaveBeenCalled();
  });

  it('returns error when task belongs to different user', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'other-user-456',
      title: 'Not yours',
    });

    const response = await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task does not belong to this user');
  });

  it('returns error when user not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleCloseTask(
      { userId: 'nonexistent', taskId: 'task-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('User not found');
  });

  it('succeeds even when activity logging fails', async () => {
    dc.repositories.tasks.findById.mockResolvedValue({
      id: 'task-1',
      user_id: 'user-123',
      title: 'Build feature',
      status: 'in_progress',
      task_group_id: null,
    });
    dc.repositories.tasks.closeTask.mockResolvedValue({
      id: 'task-1',
      title: 'Build feature',
      status: 'completed',
      outcome: 'completed',
      completed_at: '2026-04-29T10:00:00Z',
      task_group_id: null,
    });
    dc.repositories.activityStream.logActivity.mockRejectedValue(new Error('Activity DB error'));

    const response = await handleCloseTask(
      { userId: 'user-123', taskId: 'task-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
  });
});

// =====================================================
// handleCloseTaskGroup
// =====================================================

describe('handleCloseTaskGroup', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  const activeGroup = {
    id: 'group-1',
    user_id: 'user-123',
    title: 'Feature rollout',
    status: 'active',
    strategy: null,
    strategy_config: {},
  };

  const sampleTasks = [
    { id: 't-1', status: 'completed', outcome: 'completed', title: 'Task 1' },
    { id: 't-2', status: 'completed', outcome: 'completed', title: 'Task 2' },
    { id: 't-3', status: 'pending', outcome: null, title: 'Task 3' },
    { id: 't-4', status: 'blocked', outcome: 'skipped', title: 'Task 4' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('closes a group with completed outcome and auto-generated conclusion', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue(sampleTasks);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
      outcome: 'completed',
    });

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.group.outcome).toBe('completed');
    expect(data.group.conclusion).toContain('2/4 tasks completed');
    expect(data.group.conclusion).toContain('1 skipped');
    expect(data.group.conclusion).toContain('1 pending');
    expect(data.group.stats.total).toBe(4);
    expect(data.group.stats.completed).toBe(2);
    expect(data.group.stats.skipped).toBe(1);
    expect(data.group.stats.pending).toBe(1);
  });

  it('uses provided conclusion instead of auto-generating', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue(sampleTasks);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
    });

    const response = await handleCloseTaskGroup(
      {
        userId: 'user-123',
        groupId: 'group-1',
        outcome: 'completed',
        conclusion: 'Shipped successfully via PR #100',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.group.conclusion).toBe('Shipped successfully via PR #100');
    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      'group-1',
      expect.objectContaining({
        conclusion: 'Shipped successfully via PR #100',
      })
    );
  });

  it('sets status to cancelled for non-completed outcomes', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue(sampleTasks);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'cancelled',
      outcome: 'abandoned',
    });

    await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'abandoned' },
      dc as any
    );

    expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
      'group-1',
      expect.objectContaining({ status: 'cancelled', outcome: 'abandoned' })
    );
  });

  it('posts a conclusion comment to task_group_comments', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue([
      { id: 't-1', status: 'completed', outcome: 'completed', title: 'Done' },
    ]);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
    });

    await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    const client = dc.getClient();
    expect(client.from).toHaveBeenCalledWith('task_group_comments');
  });

  it('logs task_group_closed activity event', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue(sampleTasks);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
    });

    await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'task_group_closed',
        taskGroupId: 'group-1',
        payload: expect.objectContaining({
          groupId: 'group-1',
          groupTitle: 'Feature rollout',
          outcome: 'completed',
          stats: expect.objectContaining({ total: 4, completed: 2 }),
        }),
      })
    );
  });

  it('rejects closing an already-completed group', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
    });

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group is already completed');
    expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
  });

  it('rejects closing an already-cancelled group', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      ...activeGroup,
      status: 'cancelled',
    });

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'abandoned' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group is already cancelled');
  });

  it('returns error when group not found', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(null);

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-404', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group not found');
  });

  it('returns error when group belongs to different user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      ...activeGroup,
      user_id: 'other-user-456',
    });

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group does not belong to this user');
  });

  it('handles group with zero tasks gracefully', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(activeGroup);
    dc.repositories.tasks.findByGroupId.mockResolvedValue([]);
    dc.repositories.taskGroups.update.mockResolvedValue({
      ...activeGroup,
      status: 'completed',
    });

    const response = await handleCloseTaskGroup(
      { userId: 'user-123', groupId: 'group-1', outcome: 'completed' },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.group.conclusion).toContain('0/0 tasks completed');
    expect(data.group.stats.total).toBe(0);
  });
});

// =====================================================
// handleAddTaskGroupComment
// =====================================================

describe('handleAddTaskGroupComment', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('adds a comment to a task group', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'user-123',
      title: 'Feature X',
    });
    // Mock the Supabase insert chain for task_group_comments
    const insertChain = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'comment-1',
          task_group_id: 'group-1',
          content: 'Progress update',
          comment_type: 'comment',
          created_at: '2026-04-29T10:00:00Z',
        },
        error: null,
      }),
    };
    const fromChain = {
      insert: vi.fn().mockReturnValue(insertChain),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    dc.getClient.mockReturnValue({ from: vi.fn().mockReturnValue(fromChain) });

    const response = await handleAddTaskGroupComment(
      {
        userId: 'user-123',
        groupId: 'group-1',
        content: 'Progress update',
        commentType: 'comment',
      },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.comment.content).toBe('Progress update');
    expect(data.comment.commentType).toBe('comment');
  });

  it('returns error when group not found', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue(null);

    const response = await handleAddTaskGroupComment(
      { userId: 'user-123', groupId: 'group-404', content: 'Hello' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group not found');
  });

  it('returns error when group belongs to different user', async () => {
    dc.repositories.taskGroups.findById.mockResolvedValue({
      id: 'group-1',
      user_id: 'other-user-456',
      title: 'Not yours',
    });

    const response = await handleAddTaskGroupComment(
      { userId: 'user-123', groupId: 'group-1', content: 'Hello' },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('Task group does not belong to this user');
  });
});

// =====================================================
// handleListTaskGroupComments
// =====================================================

describe('handleListTaskGroupComments', () => {
  let dc: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    resolveUserMock.mockResolvedValue({
      user: { id: 'user-123' } as any,
      resolvedBy: 'userId',
    });
  });

  it('lists comments for a task group', async () => {
    const queryChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'c-1',
            task_group_id: 'group-1',
            content: 'Started work',
            comment_type: 'comment',
            agent_id: 'wren',
            created_at: '2026-04-29T09:00:00Z',
          },
          {
            id: 'c-2',
            task_group_id: 'group-1',
            content: 'All done',
            comment_type: 'conclusion',
            agent_id: 'wren',
            created_at: '2026-04-29T10:00:00Z',
          },
        ],
        error: null,
      }),
    };
    dc.getClient.mockReturnValue({ from: vi.fn().mockReturnValue(queryChain) });

    const response = await handleListTaskGroupComments(
      { userId: 'user-123', groupId: 'group-1', limit: 50 },
      dc as any
    );

    const data = parseResponse(response);
    expect(data.success).toBe(true);
    expect(data.count).toBe(2);
    expect(data.comments[0].content).toBe('Started work');
    expect(data.comments[1].commentType).toBe('conclusion');
  });

  it('returns error when user not found', async () => {
    resolveUserMock.mockResolvedValue(null);

    const response = await handleListTaskGroupComments(
      { userId: 'nonexistent', groupId: 'group-1', limit: 50 },
      dc as any
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data.error).toBe('User not found');
  });
});
