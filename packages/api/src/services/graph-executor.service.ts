/**
 * Graph Executor Service (spec: ink://specs/workflow-graph v10, steps 2-3)
 *
 * The application half of the ready-node scheduler. The DB RPCs own every
 * state transition (readiness evaluation, gate opening, claims, verdicts —
 * all inside the mutating transaction); this service owns what the spec
 * calls "external wakeups, post-commit, idempotent":
 *
 *   - dispatching newly-ready nodes to their assignees (inbox triggers)
 *   - the reconciliation sweep loop over active graph groups
 *   - reclaiming claims whose holder session has ENDED (fail-closed: a
 *     session that is merely quiet keeps its claim — only a terminal
 *     session is provably not mid-turn)
 *   - finalizing groups the evaluator reports complete
 *
 * Dispatch is idempotent-by-claim: a duplicate trigger is noise, never
 * double execution, because claim_graph_task admits exactly one session.
 * A metadata stamp (graphDispatchedAt) keeps the sweep from re-triggering
 * every tick; the stamp is best-effort — losing the race means a repeat
 * message, not repeat work.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../data/composer';
import type { TaskGroup } from '../data/repositories/task-groups.repository';
import type { Database, Json } from '../data/supabase/types';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { resolveAgentSlug } from '../auth/resolve-identity';
import { StudioLeaseService } from './studio-lease.service';
import { logger } from '../utils/logger';

export interface GraphNodeRef {
  id: string;
  title: string;
  assigneeIdentityId?: string | null;
  assigneeUserId?: string | null;
  attempt?: number;
  gateVersion?: number;
  openedAt?: string;
  eligibleAt?: string;
}

export interface GraphDependencyFailure {
  id: string;
  title: string;
  sources: Array<{ id: string; title: string; state: string; attempt?: number | null }>;
}

export interface GraphEvaluation {
  readyWork: GraphNodeRef[];
  openedGates: GraphNodeRef[];
  openGates: GraphNodeRef[];
  scheduledGates: GraphNodeRef[];
  dependencyFailures: GraphDependencyFailure[];
  groupComplete: boolean;
  counts: { total: number; completed: number; failed: number; skipped: number };
}

export interface GraphClaimRef {
  taskId: string;
  title: string;
  taskType: string;
  sessionId: string;
  claimToken: string;
  claimedAt: string;
}

/** Don't re-trigger a still-undispatched node more often than this. */
const REDISPATCH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Claims are TURN-scoped (spec principle 9; Lumen round 2 P1): the real
 * release points are the session's actual turn boundaries — the CLI stop
 * hook and server-run completion — not a sweep timeout. This is the
 * release-by-session both boundaries call: every claim the session holds
 * is released by token CAS, returning the nodes to the pool for the next
 * dispatch (usually re-claimed by the same session's next turn). The
 * sweep's idle-window reclaim remains the CRASH backstop only.
 *
 * Fire-and-forget-safe: refusals and lookup errors are logged, never
 * thrown — a boundary must never fail because a claim record was stale.
 */
export async function releaseGraphClaimsForSession(
  client: SupabaseClient<Database>,
  sessionId: string,
  reason: string,
  boundaryAt?: string
): Promise<number> {
  // Turn-generation guard (Lumen round 3 P1): a delayed release from an OLD
  // boundary must never touch a claim the session's NEXT turn acquired.
  // Callers capture the boundary instant synchronously at the stop event;
  // only claims from before that instant are this boundary's to release.
  const cutoff = boundaryAt ?? new Date().toISOString();
  let released = 0;
  try {
    const { data: held, error } = await client
      .from('tasks')
      .select('id, user_id, claim_token')
      .eq('claimed_by_session_id', sessionId)
      .lte('claimed_at', cutoff);
    if (error) {
      logger.warn(`Graph boundary release: claim lookup failed for session ${sessionId}:`, error);
      return 0;
    }
    for (const row of held ?? []) {
      if (!row.claim_token) continue;
      const { data, error: rpcError } = await client.rpc('release_graph_claim', {
        p_user_id: row.user_id,
        p_task_id: row.id,
        p_claim_token: row.claim_token,
        p_session_id: sessionId,
        p_reclaim: false,
        p_reason: reason,
      });
      if (rpcError) {
        logger.warn(`Graph boundary release failed for task ${row.id}:`, rpcError);
        continue;
      }
      if ((data as Record<string, unknown> | null)?.success) released += 1;
    }
    if (released > 0) {
      logger.info(
        `Graph boundary release: session ${sessionId} released ${released} claim(s) (${reason})`
      );
    }
  } catch (err) {
    logger.warn(`Graph boundary release errored for session ${sessionId}:`, err);
  }
  return released;
}

/**
 * A claim held by a live, non-terminal session is reclaimed only after this
 * idle window AND a fail-closed not-mid-turn proof (#506 boundary). The
 * window keeps a session that is iterating across turns (claimed, waiting
 * on CI, next turn pending) from losing work between turns.
 */
const CLAIM_IDLE_RECLAIM_MS = Number(process.env.GRAPH_CLAIM_IDLE_RECLAIM_MS || 30 * 60 * 1000);

export class GraphExecutorService {
  private leaseService?: StudioLeaseService;

  constructor(
    private dataComposer: DataComposer,
    leaseService?: StudioLeaseService
  ) {
    this.leaseService = leaseService;
  }

  private getLeaseService(): StudioLeaseService {
    if (!this.leaseService) {
      this.leaseService = new StudioLeaseService(this.dataComposer.getClient());
    }
    return this.leaseService;
  }

  /**
   * Start (or resume) executing a graph-mode group: activate it, evaluate,
   * and dispatch the initial ready set.
   */
  async startGroup(userId: string, groupId: string): Promise<Record<string, unknown>> {
    const groups = this.dataComposer.repositories.taskGroups;
    const group = await groups.findById(groupId);
    if (!group) throw new Error('Task group not found');
    if (group.user_id !== userId) throw new Error('Task group does not belong to this user');
    if (group.execution_model !== 'graph') {
      return {
        success: false,
        reason: 'not-graph-mode',
        hint: 'convert the group first (convert_task_group_to_graph), then start',
      };
    }
    // Terminal is terminal (the DB status fence enforces this too): start
    // must never resurrect a completed/cancelled group (Lumen round 3 P1).
    if (group.status === 'completed' || group.status === 'cancelled') {
      return {
        success: false,
        reason: 'group-terminal',
        groupStatus: group.status,
      };
    }

    if (group.status !== 'active' || group.execution_phase !== 'worker_active') {
      await groups.update(groupId, {
        status: 'active',
        execution_phase: 'worker_active',
        strategy_paused_at: null,
      });
    }

    const sweep = await groups.sweepTaskGraph({ userId, taskGroupId: groupId });
    if (!sweep.success) return sweep;
    const evaluation = sweep.evaluation as unknown as GraphEvaluation;

    await this.logActivity(userId, group, 'graph_execution_started', {
      readyCount: evaluation.readyWork.length,
      openGates: evaluation.openGates.length,
    });
    const dispatched = await this.dispatchEvaluation(
      userId,
      { ...group, status: 'active' },
      evaluation,
      {
        dedupe: false,
      }
    );

    return { success: true, evaluation, dispatched };
  }

  /**
   * Post-commit dispatch for an evaluation returned by any mutation RPC or
   * the sweep. Sends one inbox trigger per actionable node to its assignee
   * (falling back to the group owner), finalizes complete groups, and
   * surfaces dependency failures — each exactly the conditions the spec
   * says must never stay silent.
   */
  async dispatchEvaluation(
    userId: string,
    group: TaskGroup,
    evaluation: GraphEvaluation,
    opts: { dedupe: boolean }
  ): Promise<{ triggered: string[]; skipped: string[] }> {
    const triggered: string[] = [];
    const skipped: string[] = [];

    if (evaluation.groupComplete) {
      await this.finalizeGroup(userId, group, evaluation);
      return { triggered, skipped };
    }

    const workTargets = evaluation.readyWork.map((n) => ({ node: n, kind: 'work' as const }));
    // openedGates are fresh transitions (dispatch always); openGates is the
    // standing set — the sweep's recovery path for a lost dispatch.
    const gateTargets = [
      ...evaluation.openedGates.map((n) => ({ node: n, kind: 'gate' as const, fresh: true })),
      ...evaluation.openGates
        .filter((n) => !evaluation.openedGates.some((o) => o.id === n.id))
        .map((n) => ({ node: n, kind: 'gate' as const, fresh: false })),
    ];

    const allTargets = [...workTargets, ...gateTargets];
    if (allTargets.length === 0) {
      await this.surfaceDependencyFailures(userId, group, evaluation.dependencyFailures);
      return { triggered, skipped };
    }

    const dispatchStamps = opts.dedupe
      ? await this.readDispatchStamps(allTargets.map((t) => t.node.id))
      : new Map<string, number>();

    for (const target of allTargets) {
      const { node } = target;
      const fresh = 'fresh' in target ? target.fresh : !opts.dedupe;
      if (!fresh && opts.dedupe) {
        const last = dispatchStamps.get(node.id);
        if (last && Date.now() - last < REDISPATCH_INTERVAL_MS) {
          skipped.push(node.id);
          continue;
        }
      }

      const ok = await this.triggerNode(userId, group, node, target.kind);
      if (ok) {
        triggered.push(node.id);
        await this.stampDispatch(node.id);
      } else {
        skipped.push(node.id);
      }
    }

    await this.surfaceDependencyFailures(userId, group, evaluation.dependencyFailures);
    return { triggered, skipped };
  }

  /**
   * Reconciliation sweep over every active graph group: same evaluator as
   * the push path (recovering lost dispatches, opening dwelling gates),
   * plus terminal-session claim reclaim.
   */
  async sweepAll(): Promise<{ groups: number; triggered: number; reclaimed: number }> {
    const groups = this.dataComposer.repositories.taskGroups;
    let active: Array<{ id: string; user_id: string; title: string }>;
    try {
      active = await groups.listActiveGraphGroups();
    } catch (err) {
      logger.warn('Graph sweep: could not list active graph groups:', err);
      return { groups: 0, triggered: 0, reclaimed: 0 };
    }

    let triggered = 0;
    let reclaimed = 0;
    for (const g of active) {
      try {
        const sweep = await groups.sweepTaskGraph({ userId: g.user_id, taskGroupId: g.id });
        if (!sweep.success) continue;
        const group = await groups.findById(g.id);
        if (!group) continue;
        const evaluation = sweep.evaluation as unknown as GraphEvaluation;
        const result = await this.dispatchEvaluation(g.user_id, group, evaluation, {
          dedupe: true,
        });
        triggered += result.triggered.length;
        reclaimed += await this.reclaimAbandonedClaims(
          g.user_id,
          group,
          (sweep.claims as unknown as GraphClaimRef[]) ?? []
        );
      } catch (err) {
        logger.warn(`Graph sweep failed for group ${g.id}:`, err);
      }
    }
    return { groups: active.length, triggered, reclaimed };
  }

  /**
   * Reclaim abandoned claims — the #506 boundary, wired (Lumen round 1 P1).
   * Two paths, both fail-closed:
   *
   *   TERMINAL: the holder session ended, completed, or crashed
   *     (`ended_at`, status 'completed', lifecycle 'failed'/'completed') —
   *     reclaimed immediately; a dead session holds nothing.
   *   IDLE PAST THE WINDOW: the claim is older than CLAIM_IDLE_RECLAIM_MS
   *     AND the lease service proves the holder is NOT mid-turn
   *     (isSessionMidTurn fails closed: active run, open turn signal, or an
   *     unreadable row all report mid-turn and the claim is kept).
   *
   * A session we cannot verify keeps its claim in every branch.
   */
  private async reclaimAbandonedClaims(
    userId: string,
    group: TaskGroup,
    claims: GraphClaimRef[]
  ): Promise<number> {
    if (claims.length === 0) return 0;
    const client = this.dataComposer.getClient();
    let reclaimed = 0;
    for (const claim of claims) {
      try {
        const { data: session, error } = await client
          .from('sessions')
          .select('id, status, ended_at, lifecycle')
          .eq('id', claim.sessionId)
          .maybeSingle();
        if (error) continue; // cannot verify → keep the claim
        if (!session) continue; // absence is not proof of death

        const terminal =
          Boolean(session.ended_at) ||
          session.status === 'completed' ||
          session.lifecycle === 'failed' ||
          session.lifecycle === 'completed';

        let reason: string | null = null;
        if (terminal) {
          reason = `holder session ${claim.sessionId} ended (${session.lifecycle ?? session.status})`;
        } else {
          const age = Date.now() - Date.parse(claim.claimedAt);
          if (Number.isNaN(age) || age < CLAIM_IDLE_RECLAIM_MS) continue;
          const midTurn = await this.getLeaseService().isSessionMidTurn(claim.sessionId, userId);
          if (midTurn) continue; // fail-closed: never steal from a live turn
          reason = `holder session ${claim.sessionId} idle past reclaim window, not mid-turn`;
        }

        const result = await this.dataComposer.repositories.taskGroups.releaseGraphClaim({
          userId,
          taskId: claim.taskId,
          claimToken: claim.claimToken,
          reclaim: true,
          reason,
        });
        if (result.success) {
          reclaimed += 1;
          await this.logActivity(userId, group, 'graph_claim_reclaimed', {
            taskId: claim.taskId,
            taskTitle: claim.title,
            sessionId: claim.sessionId,
            reason,
          });
        }
      } catch (err) {
        logger.warn(`Graph sweep: reclaim check failed for task ${claim.taskId}:`, err);
      }
    }
    return reclaimed;
  }

  private async finalizeGroup(
    userId: string,
    group: TaskGroup,
    evaluation: GraphEvaluation
  ): Promise<void> {
    if (group.status === 'completed') return;
    const { counts } = evaluation;
    await this.dataComposer.repositories.taskGroups.update(group.id, {
      status: 'completed',
      execution_phase: 'completed',
    });
    const summary =
      `Graph execution complete on "${group.title}": ${counts.completed}/${counts.total} completed` +
      (counts.failed ? `, ${counts.failed} FAILED` : '') +
      (counts.skipped ? `, ${counts.skipped} skipped` : '');
    await this.logActivity(userId, group, 'graph_group_complete', { ...counts, summary });

    const ownerSlug = group.sb_id
      ? await resolveAgentSlug(this.dataComposer.getClient(), group.sb_id).catch(() => null)
      : null;
    if (ownerSlug) {
      await this.sendTrigger(userId, group, ownerSlug, summary, 'graph_group_complete');
    }
  }

  /**
   * Dependency failures block downstream forever unless someone acts (retry
   * the gate, or cut the edge via apply_task_graph). Surfaced once per
   * failed-source set via a group-metadata stamp, to the owner.
   */
  private async surfaceDependencyFailures(
    userId: string,
    group: TaskGroup,
    failures: GraphDependencyFailure[]
  ): Promise<void> {
    const meta = (group.metadata || {}) as Record<string, unknown>;
    if (!failures || failures.length === 0) {
      // Recovery observed (retry, edge cut): clear the stamp so the SAME
      // failure re-surfaces if it happens again — without this, attempt 2
      // refailing identically stays suppressed forever (Lumen round 2 P2).
      if (meta.graphDepFailuresNotified) {
        const { graphDepFailuresNotified: _cleared, ...rest } = meta;
        await this.dataComposer.repositories.taskGroups.update(group.id, { metadata: rest });
      }
      return;
    }
    // Key on (destination, source, state, attempt) — a SECOND source
    // failing on a notified destination, or the same gate refailing on a
    // NEW attempt, is fresh information and must re-surface (rounds 1-2).
    const key = failures
      .map(
        (f) =>
          `${f.id}:${f.sources
            .map((s) => `${s.id}=${s.state}${s.attempt != null ? `@${s.attempt}` : ''}`)
            .join(',')}`
      )
      .sort()
      .join(';');
    if (meta.graphDepFailuresNotified === key) return;

    const lines = failures.map(
      (f) =>
        `- "${f.title}" blocked by ${f.sources.map((s) => `"${s.title}" (${s.state})`).join(', ')}`
    );
    const summary = `Dependency failure in "${group.title}" — downstream can never become ready:\n${lines.join('\n')}\nRetry the failed gate, or cut the edge via apply_task_graph.`;
    await this.logActivity(userId, group, 'graph_dependency_failure', { failures, summary });

    const ownerSlug = group.sb_id
      ? await resolveAgentSlug(this.dataComposer.getClient(), group.sb_id).catch(() => null)
      : null;
    if (ownerSlug) {
      await this.sendTrigger(userId, group, ownerSlug, summary, 'graph_dependency_failure');
    }
    await this.dataComposer.repositories.taskGroups.update(group.id, {
      metadata: { ...meta, graphDepFailuresNotified: key },
    });
  }

  private async triggerNode(
    userId: string,
    group: TaskGroup,
    node: GraphNodeRef,
    kind: 'work' | 'gate'
  ): Promise<boolean> {
    const client = this.dataComposer.getClient();
    let slug: string | null = null;
    if (node.assigneeIdentityId) {
      slug = await resolveAgentSlug(client, node.assigneeIdentityId).catch(() => null);
    }
    if (!slug && node.assigneeUserId) {
      // Human assignee: no session to trigger. The activity stream and the
      // task map carry the open gate; richer human notification is step 5.
      await this.logActivity(userId, group, 'graph_awaiting_human', {
        taskId: node.id,
        taskTitle: node.title,
        assigneeUserId: node.assigneeUserId,
      });
      return false;
    }
    if (!slug && group.sb_id) {
      slug = await resolveAgentSlug(client, group.sb_id).catch(() => null);
    }
    if (!slug) {
      logger.warn(`Graph dispatch: no resolvable assignee for task ${node.id} (${node.title})`);
      return false;
    }

    const content =
      kind === 'work'
        ? `Graph node ready in "${group.title}" (task group ${group.id}).\n` +
          `Node: "${node.title}" (${node.id}).\n` +
          `Claim it with claim_task(taskId: "${node.id}"), do the work, then complete via ` +
          `complete_task(taskId, claimToken) using the claim token — graph-mode completion refuses without it. ` +
          `If you cannot proceed, release the claim (release_claim) so another session can take it.`
        : `Verification gate OPEN in "${group.title}" (task group ${group.id}).\n` +
          `Gate: "${node.title}" (${node.id}), attempt ${node.attempt ?? 1}.\n` +
          `You are the assignee: review the upstream work and record a verdict with ` +
          `record_gate_verdict(taskId, verdict: 'passed'|'failed', expectedAttempt, expectedGateVersion, ` +
          `evidence for pass / reason for fail). Read the task first (get_task) for the current attempt/version. ` +
          `For an automated check (CI, GH), claim the gate first with claim_task and pass the claim token.`;

    return this.sendTrigger(userId, group, slug, content, `graph_${kind}_ready`, node.id);
  }

  private async sendTrigger(
    userId: string,
    group: TaskGroup,
    recipientSlug: string,
    content: string,
    reason: string,
    taskId?: string
  ): Promise<boolean> {
    try {
      const metadata = (group.metadata || {}) as Record<string, unknown>;
      const studioId = typeof metadata.studioId === 'string' ? metadata.studioId : undefined;
      const studioSlug = typeof metadata.studioSlug === 'string' ? metadata.studioSlug : undefined;
      const repoRoot = typeof metadata.repoRoot === 'string' ? metadata.repoRoot : undefined;
      await handleSendToInbox(
        {
          userId,
          recipientAgentId: recipientSlug,
          senderAgentId: recipientSlug,
          recipientStudioId: studioId,
          recipientStudioSlug: studioId ? undefined : studioSlug,
          content,
          messageType: 'session_resume',
          priority: 'high',
          threadKey: group.thread_key || `strategy:${group.id}`,
          trigger: true,
          triggerType: 'message',
          triggerSummary: `Graph: ${reason} — ${group.title}`,
          metadata: {
            source: 'graph_executor',
            reason,
            groupId: group.id,
            ...(taskId ? { taskId } : {}),
            ...(repoRoot ? { repoRoot } : {}),
          },
        },
        this.dataComposer
      );
      return true;
    } catch (err) {
      logger.warn(`Graph dispatch to ${recipientSlug} failed (${reason}):`, err);
      return false;
    }
  }

  private async readDispatchStamps(taskIds: string[]): Promise<Map<string, number>> {
    const stamps = new Map<string, number>();
    if (taskIds.length === 0) return stamps;
    const { data, error } = await this.dataComposer
      .getClient()
      .from('tasks')
      .select('id, metadata')
      .in('id', taskIds);
    if (error) return stamps; // dedup is best-effort; dispatch stays safe by claim
    for (const row of data ?? []) {
      const meta = (row.metadata || {}) as Record<string, unknown>;
      const at =
        typeof meta.graphDispatchedAt === 'string' ? Date.parse(meta.graphDispatchedAt) : NaN;
      if (!Number.isNaN(at)) stamps.set(row.id, at);
    }
    return stamps;
  }

  private async stampDispatch(taskId: string): Promise<void> {
    try {
      const client = this.dataComposer.getClient();
      const { data } = await client.from('tasks').select('metadata').eq('id', taskId).maybeSingle();
      const meta = (data?.metadata || {}) as Record<string, unknown>;
      await client
        .from('tasks')
        .update({ metadata: { ...meta, graphDispatchedAt: new Date().toISOString() } } as never)
        .eq('id', taskId);
    } catch (err) {
      logger.debug(`Graph dispatch stamp failed for ${taskId} (non-fatal):`, err);
    }
  }

  private async logActivity(
    userId: string,
    group: TaskGroup,
    subtype: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.dataComposer.repositories.activityStream.logActivity({
        userId,
        agentId: 'system',
        type: 'state_change',
        subtype,
        content:
          typeof payload.summary === 'string' ? payload.summary : `${subtype}: ${group.title}`,
        taskGroupId: group.id,
        payload: payload as Json,
      });
    } catch (err) {
      logger.warn(`Graph executor: activity log failed (${subtype}):`, err);
    }
  }
}
