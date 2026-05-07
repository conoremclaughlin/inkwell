/**
 * Strategy Lifecycle Observability — Integration Tests
 *
 * Verifies activity stream correlation for strategy events against
 * the real Supabase database. Covers the gaps identified after PR #338:
 *
 * 1. watchdog_wakeup / watchdog_skip events written to activity_stream
 * 2. approval_gate pauseReason metadata round-tripped through real DB
 * 3. strategy_trigger events written to activity_stream by triggerOwnerAgent
 * 4. task_group_id present on all strategy-related activity entries
 *
 * Run: PCP_PORT_BASE=9998 npx vitest run packages/api/src/services/strategy-observability.integration.test.ts
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

const canRun = !!SUPABASE_URL && !!SUPABASE_KEY && !!TEST_USER_ID;

// Mock inbox handlers — we don't want real triggers during tests
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Helpers
// ============================================================================

async function getActivityEvents(
  client: SupabaseClient,
  groupId: string
): Promise<Array<{ type: string; subtype: string | null; content: string; payload: any }>> {
  const { data, error } = await client
    .from('activity_stream')
    .select('type, subtype, content, payload, task_group_id')
    .eq('task_group_id', groupId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to query activity_stream: ${error.message}`);
  return (data || []) as any;
}

// ============================================================================
// Test Suite 1: Watchdog wakeup/skip events
// ============================================================================

describe.skipIf(!canRun)('Watchdog wakeup/skip observability (integration)', () => {
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

    // Create test group + task
    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__observability_watchdog_test_${Date.now()}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    const task = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Watchdog test task',
      task_group_id: groupId,
      task_order: 0,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskIds = [task.id];
  }, 15_000);

  afterAll(async () => {
    if (!client || !groupId) return;
    await client
      .from('tasks')
      .delete()
      .in('id', taskIds || []);
    await client
      .from('scheduled_reminders')
      .delete()
      .contains('metadata' as any, { groupId } as any);
    await client.from('activity_stream').delete().eq('task_group_id', groupId);
    await client.from('task_groups').delete().eq('id', groupId);
  }, 10_000);

  it('triggerWatchdog logs watchdog_wakeup on active group', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Start the strategy so it's active
    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      ownerAgentId: 'integration-test',
    });

    // Trigger watchdog — should log watchdog_wakeup then attempt trigger
    await service.triggerWatchdog(groupId);

    const events = await getActivityEvents(client, groupId);
    const wakeups = events.filter((e) => e.subtype === 'watchdog_wakeup');

    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    expect(wakeups[0].type).toBe('state_change');
    expect(wakeups[0].payload).toMatchObject({
      groupId,
      groupStatus: 'active',
    });
  });

  it('triggerWatchdog logs watchdog_skip on paused group', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Pause the strategy
    await service.pauseStrategy(groupId, TEST_USER_ID!);

    // Trigger watchdog on paused group — should log wakeup + skip
    const result = await service.triggerWatchdog(groupId);
    expect(result).toBe(false);

    const events = await getActivityEvents(client, groupId);
    const skips = events.filter((e) => e.subtype === 'watchdog_skip');

    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0].payload).toMatchObject({
      groupId,
      reason: 'inactive_group',
    });
  });

  it('triggerWatchdog logs watchdog_skip when no pending task', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Resume and complete the only task
    await service.resumeStrategy(groupId, TEST_USER_ID!);
    await dc.repositories.tasks.completeTask(taskIds[0]);
    await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);

    // Re-activate for test (group is now completed, re-create)
    await dc.repositories.taskGroups.update(groupId, {
      status: 'active',
      current_task_index: 99,
    });

    const result = await service.triggerWatchdog(groupId);
    expect(result).toBe(false);

    const events = await getActivityEvents(client, groupId);
    const noTaskSkips = events.filter(
      (e) => e.subtype === 'watchdog_skip' && e.payload?.reason === 'no_current_task'
    );

    expect(noTaskSkips.length).toBeGreaterThanOrEqual(1);
  });

  it('all events have task_group_id set', async () => {
    const events = await getActivityEvents(client, groupId);
    for (const event of events) {
      expect((event as any).task_group_id).toBe(groupId);
    }
  });
});

// ============================================================================
// Test Suite 2: Approval gate pauseReason round-trip
// ============================================================================

describe.skipIf(!canRun)('Approval gate pauseReason metadata (integration)', () => {
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

    // Create group with approval gate at 1 task
    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__observability_approval_test_${Date.now()}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    const task1 = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Approval test task 1',
      task_group_id: groupId,
      task_order: 0,
      priority: 'low',
      created_by: 'integration-test',
    });
    const task2 = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Approval test task 2',
      task_group_id: groupId,
      task_order: 1,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskIds = [task1.id, task2.id];
  }, 15_000);

  afterAll(async () => {
    if (!client || !groupId) return;
    await client
      .from('tasks')
      .delete()
      .in('id', taskIds || []);
    await client
      .from('scheduled_reminders')
      .delete()
      .contains('metadata' as any, { groupId } as any);
    await client.from('activity_stream').delete().eq('task_group_id', groupId);
    await client.from('task_groups').delete().eq('id', groupId);
  }, 10_000);

  it('approval gate sets metadata.pauseReason in DB', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Start with maxIterationsWithoutApproval = 1
    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      ownerAgentId: 'integration-test',
      config: { maxIterationsWithoutApproval: 1 },
    });

    // Complete task 1 and advance — should hit approval gate
    await dc.repositories.tasks.completeTask(taskIds[0]);
    const result = await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);

    expect(result.action).toBe('approval_required');

    // Verify pauseReason is persisted in the real DB
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group).toBeTruthy();
    expect(group!.metadata).toMatchObject({ pauseReason: 'approval_gate' });
    expect(group!.status).toBe('paused');
  });

  it('approval_required event includes routing metadata', async () => {
    const events = await getActivityEvents(client, groupId);
    const approvalEvents = events.filter((e) => e.subtype === 'approval_required');

    expect(approvalEvents.length).toBeGreaterThanOrEqual(1);
    expect(approvalEvents[0].payload).toMatchObject({
      groupId,
      iterationsSinceApproval: 1,
    });
    // notified field should be present (false since handleSendToInbox is mocked with no approvalNotify)
    expect(approvalEvents[0].payload).toHaveProperty('notified');
  });

  it('resumeStrategy logs approval_granted and clears pauseReason', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.resumeStrategy(groupId, TEST_USER_ID!);

    // pauseReason should be cleared in DB
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group!.metadata?.pauseReason).toBeUndefined();
    expect(group!.status).toBe('active');

    // approval_granted event should be in activity stream
    const events = await getActivityEvents(client, groupId);
    const approvalGranted = events.filter((e) => e.subtype === 'approval_granted');

    expect(approvalGranted.length).toBeGreaterThanOrEqual(1);
    expect(approvalGranted[0].payload).toMatchObject({
      groupId,
      iterationsSinceApproval: 1,
    });
  });

  it('manual pause + resume logs strategy_resumed (not approval_granted)', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Manually pause (not via approval gate)
    await service.pauseStrategy(groupId, TEST_USER_ID!);

    // Verify no pauseReason set
    const pausedGroup = await dc.repositories.taskGroups.findById(groupId);
    expect(pausedGroup!.metadata?.pauseReason).toBeUndefined();

    // Resume
    await service.resumeStrategy(groupId, TEST_USER_ID!);

    // Should log strategy_resumed, not approval_granted
    const events = await getActivityEvents(client, groupId);
    const subtypes = events.map((e) => e.subtype);

    // Find the LAST resume event (after the approval_granted from previous test)
    const resumeEvents = events.filter((e) => e.subtype === 'strategy_resumed');
    expect(resumeEvents.length).toBeGreaterThanOrEqual(1);

    // The approval_granted count should NOT have increased
    const approvalGrantedCount = subtypes.filter((s) => s === 'approval_granted').length;
    expect(approvalGrantedCount).toBe(1); // Only from the previous test
  });
});

// ============================================================================
// Test Suite 3: strategy_trigger events from triggerOwnerAgent
// ============================================================================

describe.skipIf(!canRun)('strategy_trigger activity events (integration)', () => {
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

    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__observability_trigger_test_${Date.now()}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    const task = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Trigger test task',
      task_group_id: groupId,
      task_order: 0,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskIds = [task.id];
  }, 15_000);

  afterAll(async () => {
    if (!client || !groupId) return;
    await client
      .from('tasks')
      .delete()
      .in('id', taskIds || []);
    await client
      .from('scheduled_reminders')
      .delete()
      .contains('metadata' as any, { groupId } as any);
    await client.from('activity_stream').delete().eq('task_group_id', groupId);
    await client.from('task_groups').delete().eq('id', groupId);
  }, 10_000);

  it('startStrategy logs strategy_trigger with reason=strategy_kickoff', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      ownerAgentId: 'integration-test',
    });

    // Wait briefly for fire-and-forget logs
    await new Promise((r) => setTimeout(r, 500));

    const events = await getActivityEvents(client, groupId);
    const triggerEvents = events.filter((e) => e.subtype === 'strategy_trigger');

    expect(triggerEvents.length).toBeGreaterThanOrEqual(1);
    expect(triggerEvents[0].payload).toMatchObject({
      groupId,
      reason: 'strategy_kickoff',
      ownerAgentId: 'integration-test',
    });
    expect(triggerEvents[0].payload).toHaveProperty('taskId');
    expect(triggerEvents[0].payload).toHaveProperty('taskTitle');
  });

  it('triggerWatchdog logs strategy_trigger with reason=watchdog', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.triggerWatchdog(groupId);

    await new Promise((r) => setTimeout(r, 500));

    const events = await getActivityEvents(client, groupId);
    const watchdogTriggers = events.filter(
      (e) => e.subtype === 'strategy_trigger' && e.payload?.reason === 'watchdog'
    );

    expect(watchdogTriggers.length).toBeGreaterThanOrEqual(1);
    expect(watchdogTriggers[0].payload).toMatchObject({
      groupId,
      reason: 'watchdog',
      ownerAgentId: 'integration-test',
    });
  });

  it('all strategy events carry task_group_id', async () => {
    const events = await getActivityEvents(client, groupId);
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect((event as any).task_group_id).toBe(groupId);
    }
  });
});

// ============================================================================
// Test Suite 4: Runner crash → error activity entry (hybrid: real DB + mock runner)
// ============================================================================

describe.skipIf(!canRun)('Runner crash activity logging (integration)', () => {
  let client: SupabaseClient;
  let groupId: string;
  let sessionId: string;

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Create a test task group for correlation
    const { data: group } = await client
      .from('task_groups')
      .insert({
        user_id: TEST_USER_ID!,
        title: `__observability_crash_test_${Date.now()}`,
        description: 'Integration test — safe to delete',
        priority: 'low',
        tags: ['__test'],
      })
      .select('id')
      .single();
    groupId = group!.id;

    // Create a test session
    const { data: session } = await client
      .from('sessions')
      .insert({
        user_id: TEST_USER_ID!,
        agent_id: 'integration-test',
        status: 'active',
        lifecycle: 'idle',
      })
      .select('id')
      .single();
    sessionId = session!.id;
  }, 15_000);

  afterAll(async () => {
    if (!client) return;
    if (groupId) {
      await client.from('activity_stream').delete().eq('task_group_id', groupId);
      await client.from('task_groups').delete().eq('id', groupId);
    }
    if (sessionId) {
      await client.from('sessions').delete().eq('id', sessionId);
    }
  }, 10_000);

  it('should write backend_crash error to real activity_stream with taskGroupId', async () => {
    const { ActivityStreamRepository } =
      await import('../data/repositories/activity-stream.repository');
    const activityStream = new ActivityStreamRepository(client);

    // Simulate what session-service does on runner crash
    await activityStream.logActivity({
      userId: TEST_USER_ID!,
      agentId: 'integration-test',
      type: 'error',
      subtype: 'backend_crash:claude-code',
      content: 'Backend crashed (claude-code): SIGTERM: process killed',
      sessionId,
      taskGroupId: groupId,
      payload: {
        backend: 'claude-code',
        durationMs: 1234,
        studioId: null,
        taskGroupId: groupId,
        error: 'SIGTERM: process killed',
      } as any,
    });

    // Verify the entry exists in the real DB
    const events = await getActivityEvents(client, groupId);
    const crashEvents = events.filter((e) => e.subtype === 'backend_crash:claude-code');

    expect(crashEvents).toHaveLength(1);
    expect(crashEvents[0]).toMatchObject({
      type: 'error',
      subtype: 'backend_crash:claude-code',
      content: expect.stringContaining('SIGTERM'),
      payload: expect.objectContaining({
        backend: 'claude-code',
        taskGroupId: groupId,
        error: 'SIGTERM: process killed',
        durationMs: 1234,
      }),
    });
  });

  it('crash event is queryable by task_group_id alongside strategy events', async () => {
    // Log a strategy event for the same group
    const { ActivityStreamRepository } =
      await import('../data/repositories/activity-stream.repository');
    const activityStream = new ActivityStreamRepository(client);

    await activityStream.logActivity({
      userId: TEST_USER_ID!,
      agentId: 'integration-test',
      type: 'state_change',
      subtype: 'strategy_started',
      content: 'Strategy started for crash test group',
      taskGroupId: groupId,
    });

    // Query all events for this group — should include both strategy and crash
    const events = await getActivityEvents(client, groupId);
    const subtypes = events.map((e) => e.subtype);

    expect(subtypes).toContain('backend_crash:claude-code');
    expect(subtypes).toContain('strategy_started');
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Every event should carry the group ID
    for (const event of events) {
      expect((event as any).task_group_id).toBe(groupId);
    }
  });
});
