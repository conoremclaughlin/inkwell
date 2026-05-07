/**
 * Strategy Service Tests
 *
 * Tests for the work strategy lifecycle: start, advance, pause, resume,
 * event logging, and prompt generation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyService } from './strategy.service';
import type { TaskGroup, StrategyConfig } from '../data/repositories/task-groups.repository';
import type { ProjectTask } from '../data/repositories/project-tasks.repository';

// Mock dependencies
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/request-context', () => ({
  getRequestContext: vi.fn().mockReturnValue({ sessionId: 'session-abc' }),
}));

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: 'group-1',
    user_id: 'user-123',
    identity_id: null,
    project_id: null,
    title: 'Test Strategy Group',
    description: null,
    status: 'active',
    priority: 'high',
    tags: [],
    metadata: {},
    autonomous: true,
    max_sessions: null,
    sessions_used: 0,
    context_summary: null,
    next_run_after: null,
    output_target: null,
    output_status: null,
    thread_key: 'thread:test',
    strategy: 'persistence',
    strategy_config: {} as StrategyConfig,
    verification_mode: 'self',
    plan_uri: null,
    current_task_index: 0,
    iterations_since_approval: 0,
    strategy_started_at: null,
    strategy_paused_at: null,
    owner_agent_id: 'wren',
    created_at: '2026-04-10T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
    ...overrides,
  } as TaskGroup;
}

function createMockTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 'task-1',
    project_id: null,
    user_id: 'user-123',
    title: 'First task',
    description: 'Do the thing',
    status: 'pending',
    priority: 'high' as const,
    tags: [],
    blocked_by: null,
    created_by: 'wren',
    completed_at: null,
    task_group_id: 'group-1',
    task_order: 0,
    due_date: null,
    metadata: {},
    created_at: '2026-04-10T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
    ...overrides,
  };
}

function createMockDataComposer() {
  const mockClient = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            order: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnValue({
        contains: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  };

  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    repositories: {
      taskGroups: {
        findById: vi.fn(),
        update: vi.fn(),
      },
      tasks: {
        startTask: vi.fn().mockResolvedValue({}),
        findById: vi.fn(),
      },
      activityStream: {
        logActivity: vi.fn().mockResolvedValue({ id: 'activity-1' }),
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('StrategyService', () => {
  let dc: ReturnType<typeof createMockDataComposer>;
  let service: StrategyService;

  beforeEach(() => {
    vi.clearAllMocks();
    dc = createMockDataComposer();
    service = new StrategyService(dc as any);
  });

  describe('startStrategy', () => {
    it('should activate a strategy and return the first task with prompt', async () => {
      const group = createMockGroup({ strategy: null, status: 'active' });
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        strategy: 'persistence',
        status: 'active',
      });

      // Mock getTaskByOrder — first task found via exact order match
      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      const result = await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
      });

      expect(result.action).toBe('next_task');
      expect(result.nextTask).toBeDefined();
      expect(result.prompt).toContain('persistence strategy');
      expect(result.prompt).toContain('CONTRIBUTING.md');
      expect(result.prompt).toContain('complete_task');
      expect(result.prompt).toContain('task_request');

      // Verify task was started with assignment metadata
      expect(dc.repositories.tasks.startTask).toHaveBeenCalledWith('task-1', {
        agentId: 'wren',
        studioId: undefined,
      });

      // Verify strategy event was logged
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          subtype: 'strategy_started',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should reject if strategy already active', async () => {
      const group = createMockGroup({ strategy: 'persistence', status: 'active' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(
        service.startStrategy({
          groupId: 'group-1',
          userId: 'user-123',
          strategy: 'persistence',
          ownerAgentId: 'wren',
        })
      ).rejects.toThrow('already active');
    });

    it('should reject if group does not belong to user', async () => {
      const group = createMockGroup({ user_id: 'other-user' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(
        service.startStrategy({
          groupId: 'group-1',
          userId: 'user-123',
          strategy: 'persistence',
          ownerAgentId: 'wren',
        })
      ).rejects.toThrow('does not belong');
    });

    it('should handle empty group with planUri', async () => {
      const group = createMockGroup({ strategy: null, status: 'active' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        strategy: 'persistence',
        plan_uri: 'ink://specs/test',
      });

      // Mock getTaskByOrder: no tasks found via either code path
      // Path 1 (exact): from.select.eq(group).eq(order).in(status).limit.single → null
      // Path 2 (fallback): from.select.eq(group).in(status).order.order.limit → []
      const mockClient = dc.getClient();
      const inChain = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
        }),
        order: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      });
      const afterFirstEq = {
        eq: vi.fn().mockReturnValue({ in: inChain }),
        in: inChain,
      };
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue(afterFirstEq),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      const result = await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
        planUri: 'ink://specs/test',
      });

      expect(result.action).toBe('next_task');
      expect(result.prompt).toContain('no tasks yet');
      expect(result.prompt).toContain('ink://specs/test');
    });
  });

  describe('pauseStrategy', () => {
    it('should pause an active strategy and log event', async () => {
      const group = createMockGroup({ status: 'active' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({ ...group, status: 'paused' });

      const result = await service.pauseStrategy('group-1', 'user-123');

      expect(result.status).toBe('paused');
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'strategy_paused',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should reject if strategy is not active', async () => {
      const group = createMockGroup({ status: 'paused' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(service.pauseStrategy('group-1', 'user-123')).rejects.toThrow('not active');
    });
  });

  describe('cancelStrategy', () => {
    it('should cancel an active strategy, log reason, and set status=cancelled', async () => {
      const group = createMockGroup({ status: 'active' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({ ...group, status: 'cancelled' });

      const result = await service.cancelStrategy('group-1', 'user-123', 'blocked by upstream');

      expect(result.status).toBe('cancelled');
      expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith('group-1', {
        status: 'cancelled',
        strategy_paused_at: null,
      });
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'strategy_cancelled',
          taskGroupId: 'group-1',
          content: expect.stringContaining('blocked by upstream'),
          payload: expect.objectContaining({
            reason: 'blocked by upstream',
            previousStatus: 'active',
          }),
        })
      );
    });

    it('should cancel a paused strategy without a reason', async () => {
      const group = createMockGroup({ status: 'paused' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({ ...group, status: 'cancelled' });

      const result = await service.cancelStrategy('group-1', 'user-123');

      expect(result.status).toBe('cancelled');
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'strategy_cancelled',
          payload: expect.objectContaining({
            reason: null,
            previousStatus: 'paused',
          }),
        })
      );
    });

    it('should reject if already completed', async () => {
      const group = createMockGroup({ status: 'completed' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(service.cancelStrategy('group-1', 'user-123')).rejects.toThrow(
        'already completed'
      );
      expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
    });

    it('should reject if already cancelled', async () => {
      const group = createMockGroup({ status: 'cancelled' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(service.cancelStrategy('group-1', 'user-123')).rejects.toThrow(
        'already cancelled'
      );
      expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
    });

    it('should reject if group not found', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(null);

      await expect(service.cancelStrategy('group-1', 'user-123')).rejects.toThrow('not found');
    });

    it('should reject if user does not own the group', async () => {
      const group = createMockGroup({ status: 'active', user_id: 'someone-else' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      await expect(service.cancelStrategy('group-1', 'user-123')).rejects.toThrow(
        'does not belong'
      );
    });
  });

  describe('getStrategyStatus', () => {
    it('should return comprehensive status with human-friendly summary', async () => {
      const group = createMockGroup({
        strategy_config: { checkInInterval: 3 } as StrategyConfig,
        current_task_index: 2,
        strategy_started_at: '2026-04-10T00:00:00Z',
      });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      // Mock getGroupTasks
      const tasks = [
        createMockTask({ id: 't1', title: 'Task 1', status: 'completed', task_order: 0 }),
        createMockTask({ id: 't2', title: 'Task 2', status: 'completed', task_order: 1 }),
        createMockTask({ id: 't3', title: 'Task 3', status: 'in_progress', task_order: 2 }),
        createMockTask({ id: 't4', title: 'Task 4', status: 'pending', task_order: 3 }),
      ];

      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: tasks, error: null }),
            }),
          }),
        }),
      });

      const status = await service.getStrategyStatus('group-1', 'user-123');

      expect(status.strategy).toBe('persistence');
      expect(status.progress.total).toBe(4);
      expect(status.progress.completed).toBe(2);
      expect(status.progress.completionRate).toBe(50);
      expect(status.currentTask).toBeDefined();
      expect(status.currentTask!.title).toBe('Task 3');
      expect(status.summary).toContain('2/4 tasks done');
      expect(status.summary).toContain('Task 3');
    });
  });

  describe('persistence prompt', () => {
    it('should include CONTRIBUTING.md compliance instruction', async () => {
      const group = createMockGroup({ strategy: null });
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(group);

      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      const result = await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
      });

      expect(result.prompt).toContain('CONTRIBUTING.md');
      expect(result.prompt).toContain('AGENTS.md');
      expect(result.prompt).toContain('Do NOT skip tasks');
      expect(result.prompt).toContain('task_request');
    });

    it('should include verification gates when configured', async () => {
      const group = createMockGroup({
        strategy: null,
        strategy_config: { verificationGates: ['tests', 'type-check'] } as StrategyConfig,
      });
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(group);

      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      const result = await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
        config: { verificationGates: ['tests', 'type-check'] },
      });

      expect(result.prompt).toContain('tests, type-check');
    });

    it('should include planUri when set', async () => {
      const group = createMockGroup({ strategy: null });
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        plan_uri: 'ink://specs/my-plan',
      });

      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      const result = await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
        planUri: 'ink://specs/my-plan',
      });

      expect(result.prompt).toContain('ink://specs/my-plan');
    });
  });

  // ============================================================================
  // advanceStrategy
  // ============================================================================

  describe('advanceStrategy', () => {
    // Helper: mock from() chain for getTaskByOrder when task IS found
    function chainTaskFound(task: ProjectTask) {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    // Helper: mock from() chain for getTaskByOrder when task NOT found
    // Handles both exact-match (PGRST116) and fallback (empty array)
    function chainTaskNotFound() {
      const inChain = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
        }),
        order: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      });
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ in: inChain }),
            in: inChain,
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    // Helper: mock from() chain for getGroupTasks
    function chainGroupTasks(tasks: ProjectTask[]) {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: tasks, error: null }),
            }),
          }),
        }),
      };
    }

    // Helper: mock from() chain for resolveAgentSlug
    function chainResolveSlug(slug: string | null) {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: slug ? { agent_id: slug } : null,
              error: slug ? null : { code: 'PGRST116' },
            }),
          }),
        }),
      };
    }

    // Helper: generic noop chain for non-critical from() calls (watchdog, sessions)
    function chainNoop() {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    // Sets up sequential from() returns on the mock client
    function setupChains(mockDc: ReturnType<typeof createMockDataComposer>, chains: object[]) {
      let idx = 0;
      const client = mockDc.getClient();
      client.from.mockImplementation(() => chains[idx++] || chainNoop());
    }

    it('should advance to the next task', async () => {
      const group = createMockGroup({
        current_task_index: 0,
        iterations_since_approval: 0,
      });
      const nextTask = createMockTask({
        id: 'task-2',
        title: 'Second task',
        task_order: 1,
      });

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        current_task_index: 1,
        iterations_since_approval: 1,
      });

      // from() calls: getTaskByOrder (1 call — exact match found)
      setupChains(dc, [chainTaskFound(nextTask)]);

      const result = await service.advanceStrategy('group-1', 'task-1', 'user-123');

      expect(result.action).toBe('next_task');
      expect(result.nextTask).toBeDefined();
      expect(result.nextTask!.id).toBe('task-2');
      expect(result.prompt).toContain('persistence strategy');
      expect(result.prompt).toContain('Second task');

      // Verify counters were incremented
      expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
        'group-1',
        expect.objectContaining({
          current_task_index: 1,
          iterations_since_approval: 1,
        })
      );

      // Verify task was started with assignment metadata
      expect(dc.repositories.tasks.startTask).toHaveBeenCalledWith('task-2', {
        agentId: 'wren',
        studioId: undefined,
      });

      // Verify task_advanced event was logged
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'task_advanced',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should trigger check-in at interval boundary', async () => {
      const group = createMockGroup({
        current_task_index: 2,
        iterations_since_approval: 2,
        strategy_config: { checkInInterval: 3, checkInNotify: 'myra' } as StrategyConfig,
      });
      const nextTask = createMockTask({
        id: 'task-4',
        title: 'Fourth task',
        task_order: 3,
      });
      const groupTasks = [
        createMockTask({ id: 't1', status: 'completed', task_order: 0 }),
        createMockTask({ id: 't2', status: 'completed', task_order: 1 }),
        createMockTask({ id: 't3', status: 'completed', task_order: 2 }),
        createMockTask({ id: 't4', title: 'Fourth task', status: 'pending', task_order: 3 }),
        createMockTask({ id: 't5', title: 'Fifth task', status: 'pending', task_order: 4 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        current_task_index: 3,
      });

      // from() calls: getTaskByOrder (found), getGroupTasks (for summary)
      setupChains(dc, [chainTaskFound(nextTask), chainGroupTasks(groupTasks)]);

      const result = await service.advanceStrategy('group-1', 'task-3', 'user-123');

      expect(result.action).toBe('check_in');
      expect(result.nextTask).toBeDefined();
      expect(result.nextTask!.id).toBe('task-4');
      expect(result.progressSummary).toContain('3/5 tasks completed');
      expect(result.prompt).toContain('Fourth task');
    });

    it('should notify supervisor at check-in when configured', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        current_task_index: 2,
        iterations_since_approval: 2,
        strategy_config: {
          checkInInterval: 3,
          checkInNotify: 'myra',
          supervisorId: 'supervisor-uuid-123',
        } as StrategyConfig,
      });
      const nextTask = createMockTask({ id: 'task-4', title: 'Fourth task', task_order: 3 });
      const groupTasks = [
        createMockTask({ status: 'completed', task_order: 0 }),
        createMockTask({ status: 'completed', task_order: 1 }),
        createMockTask({ status: 'completed', task_order: 2 }),
        createMockTask({ id: 'task-4', status: 'pending', task_order: 3 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(group);

      // from() calls: getTaskByOrder, getGroupTasks, resolveAgentSlug
      setupChains(dc, [
        chainTaskFound(nextTask),
        chainGroupTasks(groupTasks),
        chainResolveSlug('lumen'),
      ]);

      const result = await service.advanceStrategy('group-1', 'task-3', 'user-123');

      expect(result.action).toBe('check_in');
      expect(result.notified).toBe(true);

      // handleSendToInbox called twice: once for checkInNotify, once for supervisor
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipientAgentId: 'myra' }),
        expect.anything()
      );
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipientAgentId: 'lumen' }),
        expect.anything()
      );
    });

    it('should pause for approval when max iterations reached', async () => {
      const group = createMockGroup({
        current_task_index: 4,
        iterations_since_approval: 4,
        strategy_config: {
          maxIterationsWithoutApproval: 5,
          approvalNotify: 'myra',
        } as StrategyConfig,
      });
      const groupTasks = [
        createMockTask({ status: 'completed', task_order: 0 }),
        createMockTask({ status: 'completed', task_order: 1 }),
        createMockTask({ status: 'completed', task_order: 2 }),
        createMockTask({ status: 'completed', task_order: 3 }),
        createMockTask({ status: 'completed', task_order: 4 }),
        createMockTask({ status: 'pending', task_order: 5 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'paused',
      });

      // from() calls: getGroupTasks (for buildProgressSummary in approval gate)
      setupChains(dc, [chainGroupTasks(groupTasks)]);

      const result = await service.advanceStrategy('group-1', 'task-5', 'user-123');

      expect(result.action).toBe('approval_required');
      expect(result.progressSummary).toContain('5/6 tasks completed');

      // Verify group was paused
      expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
        'group-1',
        expect.objectContaining({
          status: 'paused',
          strategy_paused_at: expect.any(String),
          context_summary: expect.any(String),
        })
      );

      // Verify approval_required event was logged
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'approval_required',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should complete strategy when no more tasks', async () => {
      const group = createMockGroup({
        current_task_index: 2,
        iterations_since_approval: 2,
      });
      const groupTasks = [
        createMockTask({ status: 'completed', task_order: 0 }),
        createMockTask({ status: 'completed', task_order: 1 }),
        createMockTask({ status: 'completed', task_order: 2 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'completed',
      });

      // from() calls: getTaskByOrder not found (uses same chain for both paths),
      // getGroupTasks, cancelWatchdog
      const notFoundChain = chainTaskNotFound();
      setupChains(dc, [notFoundChain, notFoundChain, chainGroupTasks(groupTasks), chainNoop()]);

      const result = await service.advanceStrategy('group-1', 'task-3', 'user-123');

      expect(result.action).toBe('group_complete');
      expect(result.stats).toEqual({ total: 3, completed: 3 });

      // Verify group was marked completed
      expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
        'group-1',
        expect.objectContaining({ status: 'completed' })
      );

      // Verify strategy_completed event was logged
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'strategy_completed',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should log process violation when tasks remain incomplete', async () => {
      const group = createMockGroup({
        current_task_index: 1,
        iterations_since_approval: 1,
      });
      const groupTasks = [
        createMockTask({ status: 'completed', task_order: 0 }),
        createMockTask({ status: 'completed', task_order: 1 }),
        createMockTask({ id: 'blocked-1', title: 'Stuck task', status: 'blocked', task_order: 2 }),
        createMockTask({
          id: 'pending-1',
          title: 'Skipped task',
          status: 'pending',
          task_order: 3,
        }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'completed',
      });

      const notFoundChain = chainTaskNotFound();
      setupChains(dc, [notFoundChain, notFoundChain, chainGroupTasks(groupTasks), chainNoop()]);

      const result = await service.advanceStrategy('group-1', 'task-2', 'user-123');

      expect(result.action).toBe('group_complete');
      expect(result.stats).toEqual({ total: 4, completed: 2 });

      // Verify process_violation was logged
      const violationCall = (
        dc.repositories.activityStream.logActivity as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => (call[0] as { subtype: string }).subtype === 'process_violation'
      );
      expect(violationCall).toBeDefined();
      expect(violationCall![0]).toMatchObject({
        subtype: 'process_violation',
        taskGroupId: 'group-1',
      });

      // Verify context summary mentions the issue
      const completionUpdate = (
        dc.repositories.taskGroups.update as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: string }).status === 'completed'
      );
      expect(completionUpdate).toBeDefined();
      expect((completionUpdate![1] as { context_summary: string }).context_summary).toContain(
        'issues'
      );
    });

    it('should notify supervisor with audit on completion', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        current_task_index: 1,
        iterations_since_approval: 1,
        strategy_config: {
          checkInNotify: 'myra',
          supervisorId: 'supervisor-uuid-456',
        } as StrategyConfig,
      });
      const groupTasks = [
        createMockTask({ status: 'completed', task_order: 0 }),
        createMockTask({ status: 'completed', task_order: 1 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'completed',
      });

      const notFoundChain = chainTaskNotFound();
      setupChains(dc, [
        notFoundChain,
        notFoundChain,
        chainGroupTasks(groupTasks),
        chainNoop(), // cancelWatchdog
        chainResolveSlug('lumen'), // resolve supervisor UUID → slug
      ]);

      await service.advanceStrategy('group-1', 'task-2', 'user-123');

      // Should notify both dispatcher (myra) and supervisor (lumen)
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipientAgentId: 'myra' }),
        expect.anything()
      );
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAgentId: 'lumen',
          content: expect.stringContaining('Supervisor audit'),
        }),
        expect.anything()
      );
    });

    it('should short-circuit when group has no active strategy', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(
        createMockGroup({ strategy: null, status: 'active' })
      );

      const result = await service.advanceStrategy('group-1', 'task-1', 'user-123');

      expect(result.action).toBe('group_complete');
      // Should NOT update the group or log events
      expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
      expect(dc.repositories.activityStream.logActivity).not.toHaveBeenCalled();
    });

    it('should short-circuit when group is not active', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(
        createMockGroup({ strategy: 'persistence', status: 'paused' })
      );

      const result = await service.advanceStrategy('group-1', 'task-1', 'user-123');

      expect(result.action).toBe('group_complete');
      expect(dc.repositories.taskGroups.update).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // resumeStrategy
  // ============================================================================

  describe('resumeStrategy', () => {
    it('should resume a paused strategy and return next task with prompt', async () => {
      const group = createMockGroup({
        status: 'paused',
        strategy: 'persistence',
        current_task_index: 2,
        iterations_since_approval: 3,
        strategy_paused_at: '2026-04-10T12:00:00Z',
      });
      const currentTask = createMockTask({
        id: 'task-3',
        title: 'Third task',
        task_order: 2,
        status: 'pending',
      });

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'active',
        strategy_paused_at: null,
        iterations_since_approval: 0,
      });

      // from() calls: createWatchdogReminder (session, identity, insert), getTaskByOrder
      const mockClient = dc.getClient();
      const taskChain = {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: currentTask, error: null }),
                }),
              }),
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
      // All from() calls can use the same flexible chain — watchdog failures are non-fatal
      mockClient.from.mockReturnValue(taskChain);

      const result = await service.resumeStrategy('group-1', 'user-123');

      expect(result.action).toBe('next_task');
      expect(result.nextTask).toBeDefined();
      expect(result.nextTask!.id).toBe('task-3');
      expect(result.prompt).toContain('persistence strategy');
      expect(result.prompt).toContain('Third task');

      // Verify iterations were reset and status set to active
      expect(dc.repositories.taskGroups.update).toHaveBeenCalledWith(
        'group-1',
        expect.objectContaining({
          status: 'active',
          strategy_paused_at: null,
          iterations_since_approval: 0,
        })
      );

      // Verify task was started with assignment metadata
      expect(dc.repositories.tasks.startTask).toHaveBeenCalledWith('task-3', {
        agentId: 'wren',
        studioId: undefined,
      });

      // Verify strategy_resumed event was logged (no pauseReason in metadata = manual resume)
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'strategy_resumed',
          taskGroupId: 'group-1',
        })
      );

      // Verify owner agent was auto-triggered
      expect(result.notified).toBe(true);
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientAgentId: 'wren',
          trigger: true,
          metadata: expect.objectContaining({
            reason: 'manual_resume',
            groupId: 'group-1',
          }),
        }),
        expect.anything()
      );
    });

    it('should log approval_granted when resuming from approval gate pause', async () => {
      const group = createMockGroup({
        status: 'paused',
        strategy: 'persistence',
        current_task_index: 2,
        iterations_since_approval: 5,
        metadata: { pauseReason: 'approval_gate' },
        strategy_paused_at: '2026-04-10T12:00:00Z',
      });
      const currentTask = createMockTask({
        id: 'task-3',
        title: 'Third task',
        task_order: 2,
        status: 'pending',
      });

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({
        ...group,
        status: 'active',
        strategy_paused_at: null,
        iterations_since_approval: 0,
        metadata: {},
      });

      const mockClient = dc.getClient();
      const taskChain = {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: currentTask, error: null }),
                }),
              }),
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
      mockClient.from.mockReturnValue(taskChain);

      await service.resumeStrategy('group-1', 'user-123');

      // Verify approval_granted event was logged (pauseReason = approval_gate)
      expect(dc.repositories.activityStream.logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'approval_granted',
          taskGroupId: 'group-1',
        })
      );
    });

    it('should not re-start task that is already in_progress', async () => {
      const group = createMockGroup({
        status: 'paused',
        strategy: 'persistence',
        current_task_index: 1,
      });
      const currentTask = createMockTask({
        id: 'task-2',
        title: 'Already started',
        task_order: 1,
        status: 'in_progress',
      });

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue({ ...group, status: 'active' });

      const mockClient = dc.getClient();
      mockClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: currentTask, error: null }),
                }),
              }),
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      });

      await service.resumeStrategy('group-1', 'user-123');

      // startTask should NOT be called since task is already in_progress
      expect(dc.repositories.tasks.startTask).not.toHaveBeenCalled();
    });

    it('should reject if strategy is not paused', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(createMockGroup({ status: 'active' }));

      await expect(service.resumeStrategy('group-1', 'user-123')).rejects.toThrow('not paused');
    });

    it('should reject if no strategy is set', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(
        createMockGroup({ status: 'paused', strategy: null })
      );

      await expect(service.resumeStrategy('group-1', 'user-123')).rejects.toThrow(
        'No strategy set'
      );
    });

    it('should reject if group does not belong to user', async () => {
      dc.repositories.taskGroups.findById.mockResolvedValue(
        createMockGroup({ status: 'paused', user_id: 'other-user' })
      );

      await expect(service.resumeStrategy('group-1', 'user-123')).rejects.toThrow(
        'does not belong'
      );
    });
  });

  // ============================================================================
  // triggerOwnerAgent (via startStrategy) and triggerWatchdog
  // ============================================================================

  describe('owner agent trigger routing', () => {
    // Reuse getTaskByOrder-found chain pattern
    function chainTaskFound(task: ProjectTask) {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: task, error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    function chainGroupTasks(tasks: ProjectTask[]) {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: tasks, error: null }),
            }),
          }),
        }),
      };
    }

    function chainNoop() {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          contains: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    function setupChains(mockDc: ReturnType<typeof createMockDataComposer>, chains: object[]) {
      let idx = 0;
      const client = mockDc.getClient();
      client.from.mockImplementation(() => chains[idx++] || chainNoop());
    }

    it('startStrategy fires a session_resume trigger to the owner agent with studioId', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        strategy: null,
        owner_agent_id: 'wren',
        thread_key: 'strategy:group-1',
        metadata: { studioId: 'studio-uuid-omega', studioSlug: 'wren-omega' },
      });
      const updatedGroup = {
        ...group,
        strategy: 'persistence',
        status: 'active',
      };
      const task = createMockTask({ id: 'task-1', title: 'Ship the migration' });

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(updatedGroup);
      setupChains(dc, [chainTaskFound(task)]);

      await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = (sendMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const payload = call[0] as Record<string, unknown>;
      expect(payload.recipientAgentId).toBe('wren');
      expect(payload.senderAgentId).toBe('system');
      expect(payload.messageType).toBe('session_resume');
      expect(payload.trigger).toBe(true);
      expect(payload.recipientStudioId).toBe('studio-uuid-omega');
      expect(payload.recipientStudioSlug).toBeUndefined();
      expect(payload.threadKey).toBe('strategy:group-1');
      expect(payload.content).toContain('persistence strategy');
      expect(payload.content).toContain('Ship the migration');
      expect((payload.metadata as Record<string, unknown>).strategyTrigger).toBe(true);
      expect((payload.metadata as Record<string, unknown>).reason).toBe('strategy_kickoff');
    });

    it('startStrategy falls back to studioSlug when no studioId is set', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        strategy: null,
        owner_agent_id: 'wren',
        metadata: { studioSlug: 'wren-omega' },
      });
      const updatedGroup = { ...group, strategy: 'persistence', status: 'active' };
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(updatedGroup);
      setupChains(dc, [chainTaskFound(task)]);

      await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
      });

      const call = (sendMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const payload = call[0] as Record<string, unknown>;
      expect(payload.recipientStudioId).toBeUndefined();
      expect(payload.recipientStudioSlug).toBe('wren-omega');
    });

    it('startStrategy skips trigger when group has no owner_agent_id', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({ strategy: null, owner_agent_id: null });
      const updatedGroup = {
        ...group,
        strategy: 'persistence',
        // owner_agent_id stays null because startStrategy passes ownerAgentId but
        // for this test we're validating the triggerOwnerAgent no-op path; the
        // service writes owner_agent_id=input.ownerAgentId. Force it back to null
        // on the updated group to exercise the early-return.
        owner_agent_id: null,
        status: 'active',
      };
      const task = createMockTask();

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      dc.repositories.taskGroups.update.mockResolvedValue(updatedGroup);
      setupChains(dc, [chainTaskFound(task)]);

      await service.startStrategy({
        groupId: 'group-1',
        userId: 'user-123',
        strategy: 'persistence',
        ownerAgentId: 'wren',
      });

      expect(sendMock).not.toHaveBeenCalled();
    });

    it('triggerWatchdog fires a trigger for an active strategy with an in-progress task', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        strategy: 'persistence',
        status: 'active',
        owner_agent_id: 'wren',
        metadata: { studioId: 'studio-uuid-omega' },
      });
      const tasks = [
        createMockTask({ id: 't1', status: 'completed', task_order: 0 }),
        createMockTask({
          id: 't2',
          title: 'Current work',
          status: 'in_progress',
          task_order: 1,
        }),
        createMockTask({ id: 't3', status: 'pending', task_order: 2 }),
      ];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      setupChains(dc, [chainGroupTasks(tasks)]);

      const fired = await service.triggerWatchdog('group-1');

      expect(fired).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = (sendMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const payload = call[0] as Record<string, unknown>;
      expect(payload.recipientAgentId).toBe('wren');
      expect(payload.messageType).toBe('session_resume');
      expect(payload.content).toContain('Current work');
      expect((payload.metadata as Record<string, unknown>).reason).toBe('watchdog');
    });

    it('triggerWatchdog returns false when group is not active', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({ strategy: 'persistence', status: 'paused' });
      dc.repositories.taskGroups.findById.mockResolvedValue(group);

      const fired = await service.triggerWatchdog('group-1');

      expect(fired).toBe(false);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('triggerWatchdog returns false when group is not found', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      dc.repositories.taskGroups.findById.mockResolvedValue(null);

      const fired = await service.triggerWatchdog('group-missing');

      expect(fired).toBe(false);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('triggerWatchdog falls back to current_task_index when no in-progress task', async () => {
      const { handleSendToInbox: sendMock } = await import('../mcp/tools/inbox-handlers');

      const group = createMockGroup({
        strategy: 'persistence',
        status: 'active',
        owner_agent_id: 'wren',
        current_task_index: 1,
      });
      const tasks = [
        createMockTask({ id: 't1', status: 'completed', task_order: 0 }),
        createMockTask({ id: 't2', status: 'pending', task_order: 1 }),
      ];
      const pendingTask = tasks[1];

      dc.repositories.taskGroups.findById.mockResolvedValue(group);
      // triggerWatchdog calls getGroupTasks first (no in_progress), then
      // getTaskByOrder fallback which returns the pending task.
      setupChains(dc, [chainGroupTasks(tasks), chainTaskFound(pendingTask)]);

      const fired = await service.triggerWatchdog('group-1');

      expect(fired).toBe(true);
      const call = (sendMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const payload = call[0] as Record<string, unknown>;
      expect(payload.content).toContain(pendingTask.title);
    });
  });
});
