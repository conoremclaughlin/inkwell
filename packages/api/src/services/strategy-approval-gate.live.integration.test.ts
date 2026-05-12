/**
 * Strategy Approval Gate — Live LLM Tests
 *
 * End-to-end test with a real LLM (Haiku via Claude Code) completing tasks
 * via MCP tools on the running Inkwell server, exercising the full approval
 * gate lifecycle including supervisor review.
 *
 * Uses ClaudeRunner (the same infra as production strategy execution) — no
 * separate ANTHROPIC_API_KEY required. Claude Code's existing OAuth
 * credentials handle LLM auth.
 *
 * Suite 1: Worker completes tasks → final_review gate fires
 * Suite 2: Supervisor reviews activity + criteria → approves → finalization
 *
 * Requires:
 * - INK_LIVE_TESTS=1
 * - claude CLI installed with valid credentials
 * - Inkwell server running (default localhost:3001, override via PCP_SERVER_URL)
 * - Valid access token in ~/.ink/auth.json
 * - Supabase credentials (.env.local or env vars)
 *
 * Run:
 *   INK_LIVE_TESTS=1 PCP_SERVER_URL=http://localhost:4001 npx vitest run \
 *     --config vitest.integration.db.config.ts \
 *     --root packages/api \
 *     src/services/strategy-approval-gate.live.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir, tmpdir } from 'os';

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

const configPath = resolve(homedir(), '.ink/config.json');
const inkConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
const TEST_USER_ID: string | undefined = inkConfig.userId;

const authPath = resolve(homedir(), '.ink/auth.json');
const accessToken: string | null = existsSync(authPath)
  ? JSON.parse(readFileSync(authPath, 'utf-8')).access_token
  : null;

const INKWELL_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';

// ============================================================================
// Prerequisite checks (same pattern as sandbox live test)
// ============================================================================

function claudeAvailable(): boolean {
  const result = spawnSync('which', ['claude'], { stdio: 'ignore', timeout: 5_000 });
  return result.status === 0;
}

function claudeCredentialsAvailable(): boolean {
  const credFile = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credFile)) return true;
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function inkwellReachable(): boolean {
  try {
    execFileSync('curl', ['-sf', '-o', '/dev/null', `${INKWELL_URL}/health`], {
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

const canRun =
  process.env.INK_LIVE_TESTS === '1' &&
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  !!TEST_USER_ID &&
  !!accessToken &&
  claudeAvailable() &&
  claudeCredentialsAvailable() &&
  inkwellReachable();

// Mock for in-process advanceStrategy calls (suite 2 setup). The external
// MCP server has its own un-mocked handler — those side effects are cleaned
// up in afterAll via the cleanup() helper.
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Shared helpers
// ============================================================================

function writeMcpConfig(dir: string): string {
  const configFile = join(dir, '.mcp.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        inkwell: {
          type: 'http',
          url: `${INKWELL_URL}/mcp`,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    })
  );
  return configFile;
}

async function cleanup(client: SupabaseClient, groupId: string, taskIds: string[]): Promise<void> {
  // Core test data
  await client.from('tasks').delete().in('id', taskIds);
  await client
    .from('scheduled_reminders')
    .delete()
    .contains('metadata' as any, { groupId } as any);
  await client.from('activity_stream').delete().eq('task_group_id', groupId);

  // Memories auto-created by handleCompleteTask (topics contain task:<id>)
  for (const taskId of taskIds) {
    await client
      .from('memories')
      .delete()
      .contains('metadata' as any, { taskId } as any);
  }

  // Inbox/thread records created by notifyDispatcher (threadKey = strategy:<groupId>)
  const threadKey = `strategy:${groupId}`;
  const { data: thread } = await client
    .from('inbox_threads')
    .select('id')
    .eq('thread_key', threadKey)
    .maybeSingle();

  if (thread) {
    await client.from('inbox_thread_messages').delete().eq('thread_id', thread.id);
    await client.from('agent_inbox_read_status').delete().eq('thread_id', thread.id);
    await client.from('inbox_threads').delete().eq('id', thread.id);
  }

  // Legacy agent_inbox entries (if notifyDispatcher fell through to non-thread path)
  await client
    .from('agent_inbox')
    .delete()
    .contains('metadata' as any, { groupId } as any);

  // Task group last (FK references)
  await client.from('task_groups').delete().eq('id', groupId);
}

async function getActivityEvents(
  client: SupabaseClient,
  groupId: string
): Promise<Array<{ subtype: string; payload: Record<string, unknown> }>> {
  const { data } = await client
    .from('activity_stream')
    .select('subtype, payload')
    .eq('task_group_id', groupId)
    .order('created_at', { ascending: true });

  return (data || [])
    .filter((e: { subtype: string | null }) => e.subtype)
    .map((e: any) => ({ subtype: e.subtype, payload: e.payload || {} }));
}

// ============================================================================
// Suite 1: Worker completes tasks → final_review gate fires
// ============================================================================

describe.skipIf(!canRun)('Strategy Approval Gate — worker phase (LLM live)', () => {
  let client: SupabaseClient;
  let dc: any;
  let groupId: string;
  let taskIds: string[];
  let tmpDir: string;

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
      title: `__llm_approval_gate_live_${Date.now()}`,
      description: 'Live LLM test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    taskIds = [];
    const taskTitles = ['Write a greeting function', 'Add error handling', 'Write unit tests'];
    for (let i = 0; i < taskTitles.length; i++) {
      const task = await dc.repositories.tasks.create({
        user_id: TEST_USER_ID,
        title: taskTitles[i],
        task_group_id: groupId,
        task_order: i,
        priority: 'low',
        created_by: 'live-test',
      });
      taskIds.push(task.id);
    }

    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);
    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      ownerAgentId: 'live-test',
      config: {
        requireFinalApproval: true,
        approvalCriteria: ['all tasks completed', 'no errors during execution'],
        approvalNotify: 'lumen',
        watchdogIntervalMinutes: 60,
      },
    });

    tmpDir = join(tmpdir(), `approval-gate-live-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeMcpConfig(tmpDir);
  }, 30_000);

  afterAll(async () => {
    if (client && groupId) await cleanup(client, groupId, taskIds);
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it('LLM completes all tasks via MCP and strategy pauses for final_review', async () => {
    const { ClaudeRunner } = await import('./sessions/claude-runner');
    const runner = new ClaudeRunner();

    const result = await runner.run(
      `You have a task group with ID ${groupId}. ` +
        `Use mcp__inkwell__list_tasks with groupId="${groupId}" to see the tasks, ` +
        `then call mcp__inkwell__complete_task with each task's ID in task_order. ` +
        `Do NOT write any code — just call the MCP tools. ` +
        `Stop when all tasks are done or you receive an approval_required response.`,
      {
        config: {
          workingDirectory: tmpDir,
          mcpConfigPath: join(tmpDir, '.mcp.json'),
          model: 'claude-haiku-4-5-20251001',
        },
      }
    );

    expect(result.success).toBe(true);

    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('paused');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBe('final_review');

    for (const taskId of taskIds) {
      const task = await dc.repositories.tasks.findById(taskId);
      expect(task.status).toBe('completed');
    }
  }, 180_000);

  it('final_review_requested event has correct routing and criteria', async () => {
    const events = await getActivityEvents(client, groupId);
    const reviewEvent = events.find((e) => e.subtype === 'final_review_requested');

    expect(reviewEvent).toBeDefined();
    expect(reviewEvent!.payload.routedTo).toBe('lumen');
    expect(reviewEvent!.payload.approvalCriteria).toEqual([
      'all tasks completed',
      'no errors during execution',
    ]);
    expect(reviewEvent!.payload.completedTasks).toBe(3);
    expect(reviewEvent!.payload.totalTasks).toBe(3);
  });
});

// ============================================================================
// Suite 2: Supervisor reviews and approves via MCP
// ============================================================================

describe.skipIf(!canRun)('Strategy Approval Gate — supervisor review (LLM live)', () => {
  let client: SupabaseClient;
  let dc: any;
  let groupId: string;
  let taskIds: string[];
  let tmpDir: string;

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

    // Create group, complete all tasks, start strategy so it's already in final_review
    const group = await dc.repositories.taskGroups.create({
      user_id: TEST_USER_ID,
      title: `__llm_supervisor_review_live_${Date.now()}`,
      description: 'Live LLM supervisor test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    });
    groupId = group.id;

    taskIds = [];
    const taskTitles = ['Implement auth flow', 'Add rate limiting', 'Write integration tests'];
    for (let i = 0; i < taskTitles.length; i++) {
      const task = await dc.repositories.tasks.create({
        user_id: TEST_USER_ID,
        title: taskTitles[i],
        task_group_id: groupId,
        task_order: i,
        priority: 'low',
        created_by: 'live-test',
      });
      taskIds.push(task.id);
    }

    // Start strategy, then complete all tasks so it enters final_review
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);
    await service.startStrategy({
      groupId,
      userId: TEST_USER_ID!,
      strategy: 'persistence',
      ownerAgentId: 'live-test',
      config: {
        requireFinalApproval: true,
        approvalCriteria: ['CI passes', 'no regressions in test suite', 'code review approved'],
        approvalNotify: 'lumen',
        watchdogIntervalMinutes: 60,
      },
    });

    // Worker completes tasks (direct DB calls — the worker LLM phase is tested in suite 1)
    for (let i = 0; i < taskIds.length; i++) {
      await dc.repositories.tasks.completeTask(taskIds[i]);
      await service.advanceStrategy(groupId, taskIds[i], TEST_USER_ID!);
    }

    // Confirm we're in final_review before the supervisor test starts
    const paused = await dc.repositories.taskGroups.findById(groupId);
    if (paused.status !== 'paused' || (paused.metadata as any)?.pauseReason !== 'final_review') {
      throw new Error(`Expected final_review state, got status=${paused.status}`);
    }

    tmpDir = join(tmpdir(), `supervisor-review-live-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeMcpConfig(tmpDir);
  }, 30_000);

  afterAll(async () => {
    if (client && groupId) await cleanup(client, groupId, taskIds);
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it('supervisor LLM reviews strategy status and approves via resume_strategy', async () => {
    const { ClaudeRunner } = await import('./sessions/claude-runner');
    const runner = new ClaudeRunner();

    const result = await runner.run(
      `You are a supervisor agent reviewing a completed strategy for approval.\n\n` +
        `The task group ID is: ${groupId}\n\n` +
        `Your review process:\n` +
        `1. Call mcp__inkwell__get_strategy_status with groupId="${groupId}" to see the current state\n` +
        `2. Call mcp__inkwell__get_activity with taskGroupId="${groupId}" and limit=20 to review the execution history\n` +
        `3. Evaluate whether the approval criteria are met based on the activity stream\n` +
        `4. If satisfied, call mcp__inkwell__resume_strategy with groupId="${groupId}" to approve\n\n` +
        `The approval criteria are: CI passes, no regressions in test suite, code review approved.\n` +
        `For this test, assume all criteria are met based on the successful task completions in the activity stream.\n\n` +
        `Do NOT write any code. Just call the MCP tools in order.`,
      {
        config: {
          workingDirectory: tmpDir,
          mcpConfigPath: join(tmpDir, '.mcp.json'),
          model: 'claude-haiku-4-5-20251001',
        },
      }
    );

    expect(result.success).toBe(true);

    // Verify: strategy should be completed after supervisor approval
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('completed');
  }, 180_000);

  it('activity stream shows supervisor approval trail', async () => {
    const events = await getActivityEvents(client, groupId);
    const subtypes = events.map((e) => e.subtype);

    expect(subtypes).toContain('strategy_started');
    expect(subtypes).toContain('task_advanced');
    expect(subtypes).toContain('final_review_requested');
    expect(subtypes).toContain('final_review_approved');
    expect(subtypes).toContain('strategy_completed');

    // Verify the review event captured the right routing
    const reviewEvent = events.find((e) => e.subtype === 'final_review_requested');
    expect(reviewEvent!.payload.routedTo).toBe('lumen');
    expect(reviewEvent!.payload.approvalCriteria).toEqual([
      'CI passes',
      'no regressions in test suite',
      'code review approved',
    ]);
  });
});
