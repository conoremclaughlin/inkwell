/**
 * Strategy Approval Gate — Live LLM Tests
 *
 * End-to-end test with a real LLM (Haiku) completing tasks and hitting
 * the approval gate. Uses the Anthropic API directly with custom tools
 * (list_tasks, complete_task) wired to StrategyService.
 *
 * Requires:
 * - INK_LIVE_TESTS=1
 * - ANTHROPIC_API_KEY set
 * - Supabase credentials (.env.local or env vars)
 *
 * Run:
 *   INK_LIVE_TESTS=1 npx vitest run \
 *     --config vitest.integration.db.config.ts \
 *     --root packages/api \
 *     src/services/strategy-approval-gate.live.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const configPath = resolve(process.env.HOME || '', '.ink/config.json');
const inkConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
const TEST_USER_ID: string | undefined = inkConfig.userId;

const canRun =
  process.env.INK_LIVE_TESTS === '1' &&
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  !!ANTHROPIC_API_KEY &&
  !!TEST_USER_ID;

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Anthropic tool schemas for the LLM
// ============================================================================

const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'list_tasks',
    description:
      'List all tasks in the strategy group with their IDs and statuses. Call this first to see what needs to be done.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task as completed by its ID. This advances the strategy. Call this for each pending task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The UUID of the task to complete',
        },
      },
      required: ['taskId'],
    },
  },
];

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_ITERATIONS = 15;

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
// Test: LLM-driven approval gate
// ============================================================================

describe.skipIf(!canRun)('Strategy Approval Gate — LLM live test', () => {
  let client: SupabaseClient;
  let anthropic: Anthropic;
  let dc: any;
  let groupId: string;
  let taskIds: string[];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
  }, 30_000);

  afterAll(async () => {
    if (client && groupId) await cleanup(client, groupId, taskIds);
  }, 10_000);

  it('LLM completes all tasks and strategy pauses for final_review', async () => {
    const { StrategyService } = await import('./strategy.service');
    const service = new StrategyService(dc);

    // Tool executors — called when the LLM uses tools
    async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
      if (name === 'list_tasks') {
        const tasks = await dc.repositories.tasks.findByGroupId(groupId);
        return JSON.stringify(
          tasks.map((t: any) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            taskOrder: t.task_order,
          }))
        );
      }

      if (name === 'complete_task') {
        const taskId = input.taskId as string;
        await dc.repositories.tasks.completeTask(taskId);
        const result = await service.advanceStrategy(groupId, taskId, TEST_USER_ID!);
        return JSON.stringify({
          action: result.action,
          progressSummary: result.progressSummary || null,
          nextTask: result.nextTask
            ? { id: result.nextTask.id, title: result.nextTask.title }
            : null,
        });
      }

      return `Error: Unknown tool "${name}"`;
    }

    // Agentic loop — LLM sees the tasks and completes them
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are completing tasks in a work strategy. Use list_tasks to see the tasks, then call complete_task for each pending task in order (by taskOrder). After each completion, check the response — if the action is "approval_required", stop. Do not write any code; just call the tools.`,
          },
        ],
      },
    ];

    let lastStrategyAction: string | null = null;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages,
        tools: TOOL_SCHEMAS,
      });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      // Add assistant response
      messages.push({ role: 'assistant', content: response.content });

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });

        // Track complete_task results
        if (toolUse.name === 'complete_task') {
          try {
            const parsed = JSON.parse(result);
            lastStrategyAction = parsed.action;
          } catch {}
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Verify: strategy should have paused for final_review
    expect(lastStrategyAction).toBe('approval_required');

    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group.status).toBe('paused');
    expect((group.metadata as Record<string, unknown>).pauseReason).toBe('final_review');

    // All 3 tasks should be completed
    for (const taskId of taskIds) {
      const task = await dc.repositories.tasks.findById(taskId);
      expect(task.status).toBe('completed');
    }
  }, 120_000);

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
