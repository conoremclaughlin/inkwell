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
import {
  configHash,
  getGraphTemplate,
  listGraphTemplates,
} from '../../services/graph-templates/templates';
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
    // A mutation is an executor event: whatever the new graph made ready
    // (e.g. a cut edge unblocking downstream) is dispatched now.
    if (result.success) {
      await dispatchAfterMutation(
        dataComposer,
        resolved.user.id,
        args.taskGroupId,
        result.evaluation
      );
    }
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
// TEMPLATES — instantiate a shape, or inject one into a running graph
// ============================================================================

export const listGraphTemplatesSchema = z.object({});

export async function handleListGraphTemplates(): Promise<McpResponse> {
  return mcpResponse({ success: true, templates: listGraphTemplates() });
}

export const instantiateGraphTemplateSchema = z.object({
  ...userIdentifierSchema.shape,
  templateId: z
    .string()
    .describe('Template to build — list_graph_templates for the registry (e.g. "pr-ship")'),
  taskGroupId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Existing graph-mode group to add to. Omit to create a new group. Required when injecting a fragment.'
    ),
  title: z
    .string()
    .optional()
    .describe('Title for the new group (ignored when taskGroupId is set)'),
  threadKey: z
    .string()
    .optional()
    .describe('Routing spine for the new group, e.g. "pr:551" (ignored when taskGroupId is set)'),
  projectId: z.string().uuid().optional().describe('Project for the new group'),
  subject: z.string().optional().describe('What is being shipped — "PR #551", "spec:foo"'),
  reviewerIdentityId: z
    .string()
    .uuid()
    .optional()
    .describe('Sibling reviewer — agent_identities.id, NEVER the agent slug'),
  visualSignoffUserId: z
    .string()
    .uuid()
    .optional()
    .describe('Human who signs off on the visuals (approval gate, never claimed)'),
  visualSignoffIdentityId: z
    .string()
    .uuid()
    .optional()
    .describe('SB that signs off on the visuals when no human is in the loop'),
  includeVisualSignoff: z
    .boolean()
    .optional()
    .describe('pr-ship only: drop the visual gate for a change with no user-visible surface'),
  after: z
    .string()
    .optional()
    .describe('Injection: node slug or task UUID the injected gate depends on'),
  before: z
    .string()
    .optional()
    .describe('Injection: node slug or task UUID that should now depend on the injected gate'),
  workTitle: z.string().optional().describe('Override the work node title'),
  workDescription: z.string().optional().describe('Override the work node description'),
  start: z
    .boolean()
    .optional()
    .default(true)
    .describe('Start execution after building (new groups only)'),
});

/**
 * Build a template's shape and write it into a graph.
 *
 * One call for the common case: with no taskGroupId it creates the group,
 * converts it to graph mode, adds the nodes and edges, and starts execution.
 * With a taskGroupId it splices the shape into a graph that already exists —
 * which is how a fragment gets injected when scope grows mid-flight.
 *
 * Node authoring is additive, so re-running the same template is a no-op
 * rather than a duplicate: nodes are matched by slug.
 */
export async function handleInstantiateGraphTemplate(
  args: z.infer<typeof instantiateGraphTemplateSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) return mcpResponse({ success: false, error: 'User not found' }, true);

    const template = getGraphTemplate(args.templateId);
    if (!template) {
      return mcpResponse(
        {
          success: false,
          error: `Unknown template "${args.templateId}"`,
          available: listGraphTemplates().map((t) => t.id),
        },
        true
      );
    }
    if (template.injectable && !args.taskGroupId) {
      return mcpResponse(
        {
          success: false,
          error: `"${template.id}" is a fragment — pass taskGroupId (and after/before) to splice it into an existing graph`,
        },
        true
      );
    }

    const shape = template.build(args);
    if (shape.nodes.length === 0) {
      return mcpResponse({ success: false, error: 'Template emitted no nodes' }, true);
    }

    const groups = dataComposer.repositories.taskGroups;
    const actorIdentityId = resolveActorIdentityId();
    const actor = actorIdentityId
      ? { actorIdentityId }
      : ({ actorUserId: resolved.user.id } as const);

    // Existing group, or a fresh one converted to graph mode.
    let group = args.taskGroupId ? await groups.findById(args.taskGroupId) : null;
    if (args.taskGroupId && (!group || group.user_id !== resolved.user.id)) {
      return mcpResponse({ success: false, error: 'Task group not found' }, true);
    }
    let created = false;
    if (!group) {
      group = await groups.create({
        user_id: resolved.user.id,
        project_id: args.projectId ?? null,
        title: args.title ?? `${template.id}: ${args.subject ?? 'untitled'}`,
        description: template.summary,
        thread_key: args.threadKey,
        ...(actorIdentityId ? { sb_id: actorIdentityId } : {}),
      });
      created = true;
      const converted = await groups.convertToGraph({
        userId: resolved.user.id,
        taskGroupId: group.id,
        expectedVersion: 0,
        ...actor,
      });
      if (converted.success === false) {
        return mcpResponse(
          {
            success: false,
            error: 'convert-to-graph failed',
            detail: converted,
            groupId: group.id,
          },
          true
        );
      }
    }

    // Re-read the version: conversion bumps it, and a concurrent mutation
    // may have moved it under an existing group.
    const current = await groups.findById(group.id);
    if (!current) return mcpResponse({ success: false, error: 'Task group vanished' }, true);

    const result = await groups.addGraphNodes({
      userId: resolved.user.id,
      taskGroupId: current.id,
      expectedVersion: current.graph_version ?? 0,
      nodes: shape.nodes,
      edges: shape.edges,
      constructorId: template.id,
      constructorVersion: template.version,
      configHash: configHash(shape),
      ...actor,
    });
    if (result.success === false) {
      return mcpResponse(
        { success: false, error: 'add_graph_nodes refused', detail: result, groupId: current.id },
        true
      );
    }

    // A new group needs execution started — unless the caller asked to
    // author it without waking anyone, in which case nothing is dispatched
    // at all. An existing group is already running, so what this call just
    // opened is dispatched now.
    let started: unknown = null;
    if (created) {
      if (args.start !== false) {
        const executor = new GraphExecutorService(dataComposer);
        started = await executor.startGroup(resolved.user.id, current.id);
      }
    } else {
      await dispatchAfterMutation(dataComposer, resolved.user.id, current.id, result.evaluation);
    }

    return mcpResponse({
      success: true,
      template: { id: template.id, version: template.version },
      groupId: current.id,
      groupCreated: created,
      threadKey: current.thread_key ?? args.threadKey ?? null,
      graphVersion: result.graphVersion,
      nodesAdded: result.nodesAdded,
      nodesExisting: result.nodesExisting,
      edgesAdded: result.edgesAdded,
      started,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'instantiate_graph_template failed',
      },
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
