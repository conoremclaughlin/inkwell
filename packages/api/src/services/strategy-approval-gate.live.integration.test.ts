/**
 * Strategy Approval Gate — Live LLM Tests
 *
 * End-to-end test with a real LLM (Haiku via Claude Code) completing tasks
 * via MCP tools on the running Inkwell server, exercising the full approval
 * gate lifecycle.
 *
 * Uses ClaudeRunner (the same infra as production strategy execution) — no
 * separate ANTHROPIC_API_KEY required. Claude Code's existing OAuth
 * credentials handle LLM auth.
 *
 * Requires:
 * - INK_LIVE_TESTS=1
 * - claude CLI installed with valid credentials
 * - Inkwell server running on localhost:3001
 * - Valid access token in ~/.ink/auth.json
 * - Supabase credentials (.env.local or env vars)
 *
 * Run:
 *   INK_LIVE_TESTS=1 npx vitest run \
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
    execFileSync('curl', ['-sf', '-o', '/dev/null', 'http://localhost:3001/health'], {
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

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Helpers
// ============================================================================

async function cleanup(client: SupabaseClient, groupId: string, taskIds: string[]): Promise<void> {
  await client.from('tasks').delete().in('id', taskIds);
  await client
    .from('scheduled_reminders')
    .delete()
    .contains('metadata' as any, { groupId } as any);
  await client.from('activity_stream').delete().eq('task_group_id', groupId);
  await client.from('task_groups').delete().eq('id', groupId);
}

async function getActivitySubtypes(client: SupabaseClient, groupId: string): Promise<string[]> {
  const { data } = await client
    .from('activity_stream')
    .select('subtype')
    .eq('task_group_id', groupId)
    .order('created_at', { ascending: true });

  return (data || []).map((e: { subtype: string | null }) => e.subtype).filter(Boolean) as string[];
}

// ============================================================================
// Test: LLM-driven approval gate via ClaudeRunner + MCP
// ============================================================================

describe.skipIf(!canRun)('Strategy Approval Gate — LLM live test', () => {
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

    // Create group with 3 tasks
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

    // Start strategy with requireFinalApproval
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
        watchdogIntervalMinutes: 60,
      },
    });

    // Write temp MCP config with inkwell server + auth
    tmpDir = join(tmpdir(), `approval-gate-live-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        },
      })
    );
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

    // Verify: strategy should have paused for final_review
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('paused');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBe('final_review');

    // All 3 tasks should be completed
    for (const taskId of taskIds) {
      const task = await dc.repositories.tasks.findById(taskId);
      expect(task.status).toBe('completed');
    }
  }, 180_000);

  it('resume from final_review finalizes the strategy', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    const result = await service.resumeStrategy(groupId, TEST_USER_ID!);

    expect(result.action).toBe('group_complete');
    expect(result.stats).toEqual({ total: 3, completed: 3 });

    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('completed');
  });

  it('activity stream shows the full lifecycle', async () => {
    const subtypes = await getActivitySubtypes(client, groupId);

    expect(subtypes).toContain('strategy_started');
    expect(subtypes).toContain('task_advanced');
    expect(subtypes).toContain('final_review_requested');
    expect(subtypes).toContain('final_review_approved');
    expect(subtypes).toContain('strategy_completed');
  });
});
