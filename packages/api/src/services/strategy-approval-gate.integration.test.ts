/**
 * Strategy Approval Gate — Integration Tests
 *
 * Exercises the final approval gate and periodic-approval-on-final-task
 * flows against the real Supabase database. Covers PR #362 features:
 *
 * 1. requireFinalApproval pauses with final_review when all tasks done
 * 2. resume from final_review calls finalizeStrategy (status → completed)
 * 3. maxIterationsWithoutApproval on the final task → completes (not approval_gate)
 * 4. Both gates together: final task on periodic boundary → final_review wins
 * 5. Activity stream has the correct event trail
 *
 * Run: PCP_PORT_BASE=9998 npx vitest run packages/api/src/services/strategy-approval-gate.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ============================================================================
// Environment setup
// ============================================================================

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

if (!process.env.PCP_PORT_BASE) process.env.PCP_PORT_BASE = '9998';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

const configPath = resolve(process.env.HOME || '', '.ink/config.json');
const inkConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
const TEST_USER_ID: string | undefined = inkConfig.userId;

let TEST_SB_ID: string | undefined;

const canRun = !!SUPABASE_URL && !!SUPABASE_KEY && !!TEST_USER_ID;

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Helpers
// ============================================================================

async function getActivitySubtypes(client: SupabaseClient, groupId: string): Promise<string[]> {
  const { data } = await client
    .from('activity_stream')
    .select('subtype')
    .eq('task_group_id', groupId)
    .order('created_at', { ascending: true });

  return (data || []).map((e: { subtype: string | null }) => e.subtype).filter(Boolean) as string[];
}

async function createTestGroup(
  dc: any,
  suffix: string,
  config: Record<string, unknown>
): Promise<{ groupId: string; taskIds: string[] }> {
  const group = await dc.repositories.taskGroups.create({
    user_id: TEST_USER_ID,
    title: `__approval_gate_test_${suffix}_${Date.now()}`,
    description: 'Integration test — safe to delete',
    priority: 'low',
    tags: ['__test'],
  });

  const taskIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const task = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: `Approval gate test task ${i + 1}`,
      task_group_id: group.id,
      task_order: i,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskIds.push(task.id);
  }

  return { groupId: group.id, taskIds };
}

async function cleanup(client: SupabaseClient, groupId: string, taskIds: string[]): Promise<void> {
  await client.from('tasks').delete().in('id', taskIds);
  await client
    .from('scheduled_reminders')
    .delete()
    .contains('metadata' as any, { groupId } as any);
  await client.from('activity_stream').delete().eq('task_group_id', groupId);
  await client.from('task_groups').delete().eq('id', groupId);
}

// ============================================================================
// Test: requireFinalApproval lifecycle
// ============================================================================

describe.skipIf(!canRun)('Strategy Final Approval Gate (integration)', () => {
  let client: SupabaseClient;
  let dc: any;
  let groupId: string;
  let taskIds: string[];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { TaskGroupsRepository } = await import('../data/repositories/task-groups.repository');
    const { ProjectTasksRepository } =
      await import('../data/repositories/project-tasks.repository');
    const { ActivityStreamRepository } =
      await import('../data/repositories/activity-stream.repository');

    dc = {
      getClient: () => client,
      repositories: {
        taskGroups: new TaskGroupsRepository(client),
        tasks: new ProjectTasksRepository(client),
        activityStream: new ActivityStreamRepository(client),
      },
    };

    const { data: identity } = await client
      .from('agent_identities')
      .select('id')
      .eq('user_id', TEST_USER_ID!)
      .limit(1)
      .single();
    TEST_SB_ID = identity?.id;

    const created = await createTestGroup(dc, 'final_review', {});
    groupId = created.groupId;
    taskIds = created.taskIds;
  }, 15_000);

  afterAll(async () => {
    if (client && groupId) await cleanup(client, groupId, taskIds);
  }, 10_000);

  it('should start strategy with requireFinalApproval', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    const result = await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      sbId: TEST_SB_ID!,
      config: {
        requireFinalApproval: true,
        approvalCriteria: ['tests pass', 'visual review'],
        watchdogIntervalMinutes: 60,
      },
    });

    expect(result.action).toBe('next_task');
    expect(result.nextTask).toBeDefined();
  });

  it('should advance through tasks without pausing (no periodic gate)', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Complete task 1
    await dc.repositories.tasks.completeTask(taskIds[0]);
    const advance1 = await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);
    expect(advance1.action).toBe('next_task');

    // Complete task 2
    await dc.repositories.tasks.completeTask(taskIds[1]);
    const advance2 = await service.advanceStrategy(groupId, taskIds[1], TEST_USER_ID!);
    expect(advance2.action).toBe('next_task');
  });

  it('should pause for final_review when last task completes', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Complete task 3 (the last one)
    await dc.repositories.tasks.completeTask(taskIds[2]);
    const advance3 = await service.advanceStrategy(groupId, taskIds[2], TEST_USER_ID!);

    expect(advance3.action).toBe('approval_required');
    expect(advance3.progressSummary).toContain('Awaiting final approval');
    expect(advance3.progressSummary).toContain('tests pass');
    expect(advance3.progressSummary).toContain('visual review');

    // Verify DB state
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('paused');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBe('final_review');
  });

  it('should finalize strategy when resuming from final_review', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    const result = await service.resumeStrategy(groupId, TEST_USER_ID!);

    expect(result.action).toBe('group_complete');
    expect(result.stats).toEqual({ total: 3, completed: 3 });

    // Verify DB state
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('completed');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBeUndefined();
  });

  it('should have correct activity stream trail', async () => {
    const subtypes = await getActivitySubtypes(client, groupId);

    expect(subtypes).toContain('strategy_started');
    expect(subtypes).toContain('task_advanced');
    expect(subtypes).toContain('final_review_requested');
    expect(subtypes).toContain('final_review_approved');
    expect(subtypes).toContain('strategy_completed');
  });
});

// ============================================================================
// Test: periodic approval gate on final task (regression, Lumen PR #362)
// ============================================================================

describe.skipIf(!canRun)(
  'Strategy Periodic Approval on Final Task (integration regression)',
  () => {
    let client: SupabaseClient;
    let dc: any;
    let groupId: string;
    let taskIds: string[];

    beforeAll(async () => {
      client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { TaskGroupsRepository } = await import('../data/repositories/task-groups.repository');
      const { ProjectTasksRepository } =
        await import('../data/repositories/project-tasks.repository');
      const { ActivityStreamRepository } =
        await import('../data/repositories/activity-stream.repository');

      dc = {
        getClient: () => client,
        repositories: {
          taskGroups: new TaskGroupsRepository(client),
          tasks: new ProjectTasksRepository(client),
          activityStream: new ActivityStreamRepository(client),
        },
      };

      if (!TEST_SB_ID) {
        const { data: identity } = await client
          .from('agent_identities')
          .select('id')
          .eq('user_id', TEST_USER_ID!)
          .limit(1)
          .single();
        TEST_SB_ID = identity?.id;
      }

      // Create group with exactly 2 tasks + maxIterationsWithoutApproval=2
      // so the periodic gate would fire on task 2 if ordering were wrong
      const group = await dc.repositories.taskGroups.create({
        user_id: TEST_USER_ID,
        title: `__periodic_boundary_regression_${Date.now()}`,
        description: 'Integration test — safe to delete',
        priority: 'low',
        tags: ['__test'],
      });
      groupId = group.id;

      taskIds = [];
      for (let i = 0; i < 2; i++) {
        const task = await dc.repositories.tasks.create({
          user_id: TEST_USER_ID,
          title: `Boundary test task ${i + 1}`,
          task_group_id: groupId,
          task_order: i,
          priority: 'low',
          created_by: 'integration-test',
        });
        taskIds.push(task.id);
      }
    }, 15_000);

    afterAll(async () => {
      if (client && groupId) await cleanup(client, groupId, taskIds);
    }, 10_000);

    it('should complete (not pause for periodic approval) when final task hits approval boundary', async () => {
      const { StrategyService } = await import('./strategy.service');
      const service = new StrategyService(dc);

      // Start with maxIterationsWithoutApproval=2 and NO requireFinalApproval
      await service.startStrategy({
        groupId,
        userId: TEST_USER_ID!,
        strategy: 'persistence',
        sbId: TEST_SB_ID!,
        config: {
          maxIterationsWithoutApproval: 2,
          watchdogIntervalMinutes: 60,
        },
      });

      // Complete both tasks
      await dc.repositories.tasks.completeTask(taskIds[0]);
      const advance1 = await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);
      expect(advance1.action).toBe('next_task');

      await dc.repositories.tasks.completeTask(taskIds[1]);
      const advance2 = await service.advanceStrategy(groupId, taskIds[1], TEST_USER_ID!);

      // Should complete, NOT pause for periodic approval
      expect(advance2.action).toBe('group_complete');
      expect(advance2.stats).toEqual({ total: 2, completed: 2 });

      const group = await dc.repositories.taskGroups.findById(groupId);
      expect(group.status).toBe('completed');
    });

    it('should have strategy_completed in activity (not approval_required)', async () => {
      const subtypes = await getActivitySubtypes(client, groupId);

      expect(subtypes).toContain('strategy_completed');
      // The periodic approval gate should NOT have fired
      expect(subtypes).not.toContain('approval_required');
    });
  }
);

// ============================================================================
// Test: both gates — final task on periodic boundary with requireFinalApproval
// ============================================================================

describe.skipIf(!canRun)('Strategy Both Gates on Final Task (integration)', () => {
  let client: SupabaseClient;
  let dc: any;
  let groupId: string;
  let taskIds: string[];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { TaskGroupsRepository } = await import('../data/repositories/task-groups.repository');
    const { ProjectTasksRepository } =
      await import('../data/repositories/project-tasks.repository');
    const { ActivityStreamRepository } =
      await import('../data/repositories/activity-stream.repository');

    dc = {
      getClient: () => client,
      repositories: {
        taskGroups: new TaskGroupsRepository(client),
        tasks: new ProjectTasksRepository(client),
        activityStream: new ActivityStreamRepository(client),
      },
    };

    if (!TEST_SB_ID) {
      const { data: identity } = await client
        .from('agent_identities')
        .select('id')
        .eq('user_id', TEST_USER_ID!)
        .limit(1)
        .single();
      TEST_SB_ID = identity?.id;
    }

    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__both_gates_test_${Date.now()}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    taskIds = [];
    for (let i = 0; i < 2; i++) {
      const task = await dc.repositories.tasks.create({
        user_id: TEST_USER_ID,
        title: `Both gates test task ${i + 1}`,
        task_group_id: groupId,
        task_order: i,
        priority: 'low',
        created_by: 'integration-test',
      });
      taskIds.push(task.id);
    }
  }, 15_000);

  afterAll(async () => {
    if (client && groupId) await cleanup(client, groupId, taskIds);
  }, 10_000);

  it('should pause for final_review (not periodic approval) when both gates coincide', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      sbId: TEST_SB_ID!,
      config: {
        maxIterationsWithoutApproval: 2,
        requireFinalApproval: true,
        approvalCriteria: ['CI green'],
        watchdogIntervalMinutes: 60,
      },
    });

    await dc.repositories.tasks.completeTask(taskIds[0]);
    const advance1 = await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);
    expect(advance1.action).toBe('next_task');

    await dc.repositories.tasks.completeTask(taskIds[1]);
    const advance2 = await service.advanceStrategy(groupId, taskIds[1], TEST_USER_ID!);

    // Should be final_review, not approval_gate
    expect(advance2.action).toBe('approval_required');
    expect(advance2.progressSummary).toContain('Awaiting final approval');
    expect(advance2.progressSummary).toContain('CI green');

    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('paused');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBe('final_review');
  });

  it('should finalize after resuming from final_review', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    const result = await service.resumeStrategy(groupId, TEST_USER_ID!);

    expect(result.action).toBe('group_complete');
    expect(result.stats).toEqual({ total: 2, completed: 2 });

    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('completed');
  });

  it('should have final_review events (not approval_required from periodic gate)', async () => {
    const subtypes = await getActivitySubtypes(client, groupId);

    expect(subtypes).toContain('final_review_requested');
    expect(subtypes).toContain('final_review_approved');
    expect(subtypes).toContain('strategy_completed');
    // The periodic approval gate should NOT have fired
    expect(subtypes).not.toContain('approval_required');
  });
});
