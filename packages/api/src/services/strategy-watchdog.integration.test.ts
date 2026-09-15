/**
 * Strategy Watchdog — Integration Test
 *
 * Tests the watchdog reminder lifecycle against the real Supabase database.
 * Verifies that reminders are created/cancelled correctly during strategy
 * start, pause, resume, and completion.
 *
 * Requires:
 *   - .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY
 *
 * Run: PCP_PORT_BASE=9998 npx vitest run packages/api/src/services/strategy-watchdog.integration.test.ts
 *
 * This test is skipped automatically if credentials are unavailable (e.g., CI).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';

// ============================================================================
// Environment setup — load .env.local directly (avoid env.ts side effects)
// ============================================================================

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

// Also set test port to avoid conflicts
if (!process.env.PCP_PORT_BASE) process.env.PCP_PORT_BASE = '9998';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

// Canonical SYNTHETIC integration user (seeded by integration-setup.ts) —
// never a developer's organic ~/.ink/config.json id. The organic id does not
// exist on CI, which silently skipped this whole suite there (Lumen, PR #439
// review), and organic user ids do not belong in test rows.
const TEST_USER_ID: string | undefined = INTEGRATION_TEST_USER_ID;

let TEST_SB_ID: string | undefined;

// INTENTIONAL (Conor, 2026-08-12): this suite is token-free — server/DB
// round-trips only, no LLM calls — so running it in CI is fine on cost
// grounds; it is CI-deferred below purely for environment-hermeticity
// reasons. LIVE suites (*.live.*, gated on INK_LIVE_TESTS=1) consume real
// LLM tokens and are DELIBERATELY excluded from CI; that is a cost
// decision, not an oversight — please don't "fix" it.
// This suite was CI-deferred on 2026-08-12 as "assumes a developer
// environment — resolvable repoRoot/worktrees". That diagnosis was wrong, and
// the skip cost ten weeks of signal. startStrategy began requiring a
// resolvable repoRoot on 2026-06-23 (02f2b58f); these fixtures never supplied
// one, so the suite failed on Actions AND locally, identically, for the same
// single reason. Skipping CI hid the breakage instead of working around it —
// "it runs locally" was never true after June. One fixture field (see
// FIXTURE_GROUP_METADATA) makes it hermetic, so it runs everywhere again.
const canRun = !!SUPABASE_URL && !!SUPABASE_KEY;

/**
 * startStrategy refuses spawn mode without a resolvable repoRoot, and resolves
 * it from group metadata → project.repo_root → request context (02f2b58f). A
 * vitest process has no request context and these fixtures have no project, so
 * metadata is the ONLY branch that can fire. Without it every test here dies in
 * beforeAll's first startStrategy call and the rest cascade.
 *
 * Pointing it at the real checkout keeps this hermetic: the path exists
 * wherever the suite runs, CI included.
 */
const FIXTURE_GROUP_METADATA = { repoRoot: projectRoot };

// Mock notifications so we don't send real inbox messages
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Test suite
// ============================================================================

describe.skipIf(!canRun)('Strategy Watchdog (integration)', () => {
  let client: SupabaseClient;
  let groupId: string;
  let taskIds: string[];

  // Minimal DataComposer-like object backed by real repos
  let dc: any;

  beforeAll(async () => {
    // Create a fresh Supabase client (not the singleton)
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Import repositories dynamically (after env is loaded)
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

    // Create test task group
    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__watchdog_integration_test_${Date.now()}`,
      description: 'Integration test — safe to delete',
      priority: 'low',
      tags: ['__test'],
      metadata: FIXTURE_GROUP_METADATA,
    });
    groupId = group.id;

    // Create 2 tasks in the group
    const task1 = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Watchdog test task 1',
      task_group_id: groupId,
      task_order: 0,
      priority: 'low',
      created_by: 'integration-test',
    });
    const task2 = await dc.repositories.tasks.create({
      user_id: TEST_USER_ID,
      title: 'Watchdog test task 2',
      task_group_id: groupId,
      task_order: 1,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskIds = [task1.id, task2.id];
  }, 15_000);

  afterAll(async () => {
    if (!client || !groupId) return;

    // Clean up: tasks, task group, reminders, activity stream
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

  // ------------------------------------------------------------------
  // Helper: query watchdog reminders for this group
  // ------------------------------------------------------------------
  async function getWatchdogReminders(status?: string) {
    let query = client
      .from('scheduled_reminders')
      .select('*')
      .contains(
        'metadata' as any,
        {
          strategyWatchdog: true,
          groupId,
        } as any
      );

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to query reminders: ${error.message}`);
    return data || [];
  }

  // ------------------------------------------------------------------
  // Tests run in sequence — each builds on the previous state
  // ------------------------------------------------------------------

  it('should create a watchdog reminder when strategy starts', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      sbId: TEST_SB_ID!,
      config: { watchdogIntervalMinutes: 1 },
    });

    const reminders = await getWatchdogReminders('active');
    expect(reminders.length).toBeGreaterThanOrEqual(1);

    const watchdog = reminders[0];
    const meta = watchdog.metadata as Record<string, unknown>;
    expect(meta.strategyWatchdog).toBe(true);
    expect(meta.groupId).toBe(groupId);
    expect(meta.strategy).toBe('persistence');
    expect(meta.sbId).toBe(TEST_SB_ID);
    expect(watchdog.cron_expression).toBe('*/1 * * * *');
    expect(watchdog.status).toBe('active');

    // inkSessionId should be null (no HTTP request context in test)
    expect(meta.inkSessionId).toBeNull();
  });

  it('should cancel the watchdog when strategy is paused', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    await service.pauseStrategy(groupId, TEST_USER_ID!);

    // Active reminders should be 0
    const active = await getWatchdogReminders('active');
    expect(active).toHaveLength(0);

    // Cancelled reminders should exist
    const cancelled = await getWatchdogReminders('cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it('should create a new watchdog when strategy is resumed', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    const result = await service.resumeStrategy(groupId, TEST_USER_ID!);

    expect(result.action).toBe('next_task');
    expect(result.nextTask).toBeDefined();

    // Should have a new active watchdog
    const active = await getWatchdogReminders('active');
    expect(active.length).toBeGreaterThanOrEqual(1);

    // The cancelled one from the pause should still exist too
    const cancelled = await getWatchdogReminders('cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it('should cancel the watchdog when strategy completes', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Complete task 1 via repository, then advance
    await dc.repositories.tasks.completeTask(taskIds[0]);
    const advance1 = await service.advanceStrategy(groupId, taskIds[0], TEST_USER_ID!);
    expect(advance1.action).toBe('next_task');

    // Complete task 2 via repository, then advance (should complete the group)
    await dc.repositories.tasks.completeTask(taskIds[1]);
    const advance2 = await service.advanceStrategy(groupId, taskIds[1], TEST_USER_ID!);
    expect(advance2.action).toBe('group_complete');
    expect(advance2.stats).toEqual({ total: 2, completed: 2 });

    // All watchdog reminders should be cancelled now
    const active = await getWatchdogReminders('active');
    expect(active).toHaveLength(0);

    // At least the resume watchdog should be cancelled
    const cancelled = await getWatchdogReminders('cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
  });

  it('should have logged strategy events in activity stream', async () => {
    const { data: events } = await client
      .from('activity_stream')
      .select('subtype')
      .eq('task_group_id', groupId)
      .order('created_at', { ascending: true });

    const subtypes = (events || []).map((e: { subtype: string | null }) => e.subtype);

    // Verify the full lifecycle was logged
    expect(subtypes).toContain('strategy_started');
    expect(subtypes).toContain('strategy_paused');
    expect(subtypes).toContain('strategy_resumed');
    expect(subtypes).toContain('task_advanced');
    expect(subtypes).toContain('strategy_completed');
  });
});
