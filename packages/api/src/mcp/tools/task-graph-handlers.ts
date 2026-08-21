/**
 * MCP Tool Handlers for the Workflow Graph
 * (spec: ink://specs/workflow-graph v10, steps 2-3)
 *
 * Graph construction (apply/convert), execution (start/claim/release),
 * and gates (verdict/retry). All state transitions happen in serialized
 * SECURITY DEFINER RPCs; these handlers resolve identity/session from the
 * request context, call the repository wrappers, and hand newly-ready
 * nodes to the GraphExecutorService for post-commit dispatch.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUser, type UserIdentifier } from '../../services/user-resolver';
import { GraphExecutorService, type GraphEvaluation } from '../../services/graph-executor.service';
import { getRequestContext, getSessionContext } from '../../utils/request-context';
import { logger } from '../../utils/logger';

const userIdentifierSchema = z.object({
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional(),
  platformId: z.string().optional(),
});

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

/** Session ID: explicit arg wins, then request/session context. */
function resolveSessionId(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const ctx = getRequestContext() || getSessionContext();
  return ctx?.sessionId;
}

/** Acting identity UUID (agent_identities.id) from context. */
function resolveActorIdentityId(): string | undefined {
  const ctx = getRequestContext() || getSessionContext();
  return ctx?.sbId;
}

/**
 * After any mutation that returns an evaluation, dispatch newly-ready
 * nodes post-commit. Dispatch failures never fail the mutation — the
 * sweep recovers lost dispatches.
 */
async function dispatchAfterMutation(
  dataComposer: DataComposer,
  userId: string,
  taskGroupId: string | null | undefined,
  evaluation: unknown
): Promise<void> {
  if (!taskGroupId || !evaluation) return;
  try {
    const group = await dataComposer.repositories.taskGroups.findById(taskGroupId);
    if (!group) return;
    const executor = new GraphExecutorService(dataComposer);
    await executor.dispatchEvaluation(userId, group, evaluation as GraphEvaluation, {
      dedupe: false,
    });
  } catch (err) {
    logger.warn(`Graph post-mutation dispatch failed for group ${taskGroupId}:`, err);
  }
}

// ============================================================================
// APPLY / CONVERT — graph construction
// ============================================================================

export const applyTaskGraphSchema = z.object({
  ...userIdentifierSchema.shape,
  taskGroupId: z.string().uuid().describe('Graph-mode task group to mutate'),
  expectedVersion: z
    .number()
    .int()
    .min(0)
    .describe('Expected graph_version (CAS) — read it from get_task_graph first'),
  edges: z
    .array(z.object({ from: z.string().uuid(), to: z.string().uuid() }))
    .describe(
      'The COMPLETE desired edge set (from → to means "from must satisfy before to can start"). Edges not listed are removed.'
    ),
});

export async function handleApplyTaskGraph(
  args: z.infer<typeof applyTaskGraphSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const actorIdentityId = resolveActorIdentityId();
    const result = await dataComposer.repositories.taskGroups.applyTaskGraph({
      userId: resolved.user.id,
      taskGroupId: args.taskGroupId,
      expectedVersion: args.expectedVersion,
      edges: args.edges,
      actorIdentityId,
      actorUserId: actorIdentityId ? undefined : resolved.user.id,
    });
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'apply_task_graph failed' },
      true
    );
  }
}

export const convertTaskGroupToGraphSchema = z.object({
  ...userIdentifierSchema.shape,
  taskGroupId: z.string().uuid().describe('Linear task group to convert to graph execution'),
  expectedVersion: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Expected graph_version (0 for a never-converted group)'),
});

export async function handleConvertTaskGroupToGraph(
  args: z.infer<typeof convertTaskGroupToGraphSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const actorIdentityId = resolveActorIdentityId();
    const result = await dataComposer.repositories.taskGroups.convertToGraph({
      userId: resolved.user.id,
      taskGroupId: args.taskGroupId,
      expectedVersion: args.expectedVersion,
      ...(actorIdentityId ? { actorIdentityId } : { actorUserId: resolved.user.id }),
    });
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'convert failed' },
      true
    );
  }
}

// ============================================================================
// GET TASK GRAPH — read model for agents and the map
// ============================================================================

export const getTaskGraphSchema = z.object({
  ...userIdentifierSchema.shape,
  taskGroupId: z.string().uuid().describe('Task group to read'),
});

export async function handleGetTaskGraph(
  args: z.infer<typeof getTaskGraphSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const groups = dataComposer.repositories.taskGroups;
    const group = await groups.findById(args.taskGroupId);
    if (!group || group.user_id !== resolved.user.id) {
      return mcpResponse({ success: false, error: 'Task group not found' }, true);
    }

    const client = dataComposer.getClient();
    const { data: tasks, error } = await client
      .from('tasks')
      .select(
        'id, title, status, outcome, task_type, node_slug, gate_state, gate_attempt, gate_version, gate_opened_at, dwell_started_at, eligible_at, claimed_by_session_id, claimed_at, assignee_identity_id, assignee_user_id, verification'
      )
      .eq('task_group_id', args.taskGroupId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`Failed to read group tasks: ${error.message}`);
    const edges = await groups.getEdges(args.taskGroupId);

    return mcpResponse({
      success: true,
      group: {
        id: group.id,
        title: group.title,
        status: group.status,
        executionModel: group.execution_model,
        executionPhase: group.execution_phase,
        graphVersion: group.graph_version,
        threadKey: group.thread_key,
      },
      nodes: (tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        outcome: t.outcome,
        taskType: t.task_type,
        nodeSlug: t.node_slug,
        gateState: t.gate_state,
        gateAttempt: t.gate_attempt,
        gateVersion: t.gate_version,
        gateOpenedAt: t.gate_opened_at,
        dwellStartedAt: t.dwell_started_at,
        eligibleAt: t.eligible_at,
        claimedBySessionId: t.claimed_by_session_id,
        claimedAt: t.claimed_at,
        assigneeIdentityId: t.assignee_identity_id,
        assigneeUserId: t.assignee_user_id,
        verification: t.verification,
      })),
      edges: edges.map((e) => ({ from: e.from_task, to: e.to_task })),
    });
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'get_task_graph failed' },
      true
    );
  }
}

// ============================================================================
// START GRAPH EXECUTION
// ============================================================================

export const startGraphExecutionSchema = z.object({
  ...userIdentifierSchema.shape,
  taskGroupId: z.string().uuid().describe('Graph-mode task group to start executing'),
});

export async function handleStartGraphExecution(
  args: z.infer<typeof startGraphExecutionSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const executor = new GraphExecutorService(dataComposer);
    const result = await executor.startGroup(resolved.user.id, args.taskGroupId);
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'start failed' },
      true
    );
  }
}

// ============================================================================
// CLAIM / RELEASE
// ============================================================================

export const claimTaskSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Ready graph node (work or open executable gate) to claim'),
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Claiming session — usually unnecessary, resolved from session context'),
});

export async function handleClaimTask(
  args: z.infer<typeof claimTaskSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const sessionId = resolveSessionId(args.sessionId);
    if (!sessionId) {
      return mcpResponse(
        {
          success: false,
          error:
            'No session in context — claims are session-owned. Pass sessionId explicitly or call from a bootstrapped session.',
        },
        true
      );
    }

    const result = await dataComposer.repositories.taskGroups.claimGraphTask({
      userId: resolved.user.id,
      taskId: args.taskId,
      sessionId,
    });
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'claim failed' },
      true
    );
  }
}

export const releaseClaimSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Claimed task to release'),
  claimToken: z.string().uuid().describe('The claim token returned by claim_task'),
  sessionId: z.string().uuid().optional().describe('Holding session — resolved from context'),
  reason: z.string().max(500).optional().describe('Why the claim is being released'),
});

export async function handleReleaseClaim(
  args: z.infer<typeof releaseClaimSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const sessionId = resolveSessionId(args.sessionId);
    if (!sessionId) {
      return mcpResponse({ success: false, error: 'No session in context' }, true);
    }
    const result = await dataComposer.repositories.taskGroups.releaseGraphClaim({
      userId: resolved.user.id,
      taskId: args.taskId,
      claimToken: args.claimToken,
      sessionId,
      reason: args.reason,
    });
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'release failed' },
      true
    );
  }
}

// ============================================================================
// GATE VERDICT / RETRY (step 3 — kept simple)
// ============================================================================

export const recordGateVerdictSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Verification gate to decide'),
  verdict: z.enum(['passed', 'failed']),
  expectedAttempt: z
    .number()
    .int()
    .min(1)
    .describe('Current gate_attempt (CAS — read via get_task_graph)'),
  expectedGateVersion: z
    .number()
    .int()
    .min(0)
    .describe('Current gate_version (CAS — read via get_task_graph)'),
  evidence: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Required to pass: what proves the verdict, e.g. {"kind":"review","ref":"pr:531"}'),
  reason: z.string().max(2000).optional().describe('Required to fail: what is wrong'),
  claimToken: z
    .string()
    .uuid()
    .optional()
    .describe('Required when you claimed the gate (executable checks)'),
  sessionId: z.string().uuid().optional().describe('Resolved from context when omitted'),
});

export async function handleRecordGateVerdict(
  args: z.infer<typeof recordGateVerdictSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const actorIdentityId = resolveActorIdentityId();
    const result = await dataComposer.repositories.taskGroups.recordGateVerdict({
      userId: resolved.user.id,
      taskId: args.taskId,
      verdict: args.verdict,
      expectedAttempt: args.expectedAttempt,
      expectedGateVersion: args.expectedGateVersion,
      ...(actorIdentityId ? { actorIdentityId } : { actorUserId: resolved.user.id }),
      sessionId: resolveSessionId(args.sessionId),
      claimToken: args.claimToken,
      evidence: args.evidence as Record<string, unknown> | undefined,
      reason: args.reason,
    });

    if (result.success) {
      const task = await dataComposer.repositories.tasks.findById(args.taskId);
      await dispatchAfterMutation(
        dataComposer,
        resolved.user.id,
        task?.task_group_id,
        result.evaluation
      );
    }
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'verdict failed' },
      true
    );
  }
}

export const retryGateSchema = z.object({
  ...userIdentifierSchema.shape,
  taskId: z.string().uuid().describe('Failed verification gate to retry'),
  expectedAttempt: z.number().int().min(1).describe('The FAILED attempt number (CAS)'),
  reason: z.string().max(2000).optional().describe('What was remediated'),
});

export async function handleRetryGate(
  args: z.infer<typeof retryGateSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const actorIdentityId = resolveActorIdentityId();
    const result = await dataComposer.repositories.taskGroups.retryGate({
      userId: resolved.user.id,
      taskId: args.taskId,
      expectedAttempt: args.expectedAttempt,
      ...(actorIdentityId ? { actorIdentityId } : { actorUserId: resolved.user.id }),
      reason: args.reason,
    });

    if (result.success) {
      const task = await dataComposer.repositories.tasks.findById(args.taskId);
      await dispatchAfterMutation(
        dataComposer,
        resolved.user.id,
        task?.task_group_id,
        result.evaluation
      );
    }
    return mcpResponse(result, result.success === false);
  } catch (error) {
    return mcpResponse(
      { success: false, error: error instanceof Error ? error.message : 'retry failed' },
      true
    );
  }
}
