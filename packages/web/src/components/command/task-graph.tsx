'use client';

import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCommandStore } from './store';
import { getSkin } from './skins';

// ─── Custom Task Node ───

/**
 * One execution-state line per node (spec v10): gates narrate their own
 * lifecycle (dwelling → open → verifying → passed/failed), work nodes say
 * when they are READY (every inbound source satisfied) — the "what's about
 * to occur" read this map exists for.
 */
export function executionLabel(
  data: Record<string, unknown>
): { text: string; emphasis: boolean } | null {
  if (data.taskType === 'verification') {
    const gateState = data.gateState as string | null;
    const attempt = (data.gateAttempt as number | null) ?? 1;
    const attemptSuffix = attempt > 1 ? ` · attempt ${attempt}` : '';
    if (gateState === 'failed') return { text: `✖ gate FAILED${attemptSuffix}`, emphasis: true };
    if (gateState === 'passed') return { text: `✓ gate passed${attemptSuffix}`, emphasis: false };
    if (gateState === 'in_progress')
      return { text: `⚙ verifying${attemptSuffix}`, emphasis: false };
    if (gateState === 'open')
      return { text: `🔔 gate OPEN — awaiting verdict${attemptSuffix}`, emphasis: true };
    const eligibleAt = data.eligibleAt ? Date.parse(data.eligibleAt as string) : NaN;
    if (!Number.isNaN(eligibleAt) && eligibleAt > Date.now()) {
      const mins = Math.round((eligibleAt - Date.now()) / 60_000);
      const when = mins >= 90 ? `${Math.round(mins / 60)}h` : `${mins}m`;
      return { text: `⏱ scheduled — opens in ${when}`, emphasis: false };
    }
    return { text: 'gate waiting on deps', emphasis: false };
  }
  if (data.depFailed) return { text: '⛔ upstream failed', emphasis: true };
  if (data.claimed) return { text: '⚙ claimed', emphasis: false };
  if (data.ready) return { text: '▶ ready', emphasis: true };
  return null;
}

function TaskNodeComponent({ data }: { data: Record<string, unknown> }) {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const status = data.status as string;
  const title = data.label as string;
  const priority = data.priority as string;
  const isGate = data.taskType === 'verification';
  const gateState = data.gateState as string | null;

  // Gates color by their own state machine; work by task status.
  const statusColor = isGate
    ? gateState === 'passed'
      ? skin.colors.taskCompleted
      : gateState === 'failed'
        ? skin.colors.taskBlocked
        : gateState === 'open' || gateState === 'in_progress'
          ? skin.colors.accent
          : skin.colors.taskPending
    : status === 'completed'
      ? skin.colors.taskCompleted
      : status === 'archived'
        ? skin.colors.border
        : status === 'in_progress'
          ? skin.colors.taskInProgress
          : status === 'blocked'
            ? skin.colors.taskBlocked
            : data.ready
              ? skin.colors.accent
              : skin.colors.taskPending;

  const priorityBadge =
    priority === 'critical' ? '🔴' : priority === 'high' ? '🟠' : priority === 'medium' ? '🟡' : '';

  const execution = executionLabel(data);

  return (
    <div
      className="px-3 py-2 rounded shadow-lg border-2 min-w-[140px] max-w-[200px]"
      style={{
        backgroundColor: skin.colors.surface,
        borderColor: statusColor,
        // A gate is a checkpoint, not work — the dashed border is the visual
        // grammar for "something must be verified here".
        borderStyle: isGate ? 'dashed' : 'solid',
        fontFamily: skin.fonts.body,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-400" />
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
        <span className="text-xs font-medium truncate" style={{ color: skin.colors.text }}>
          {isGate ? '🛡 ' : ''}
          {priorityBadge} {title}
        </span>
      </div>
      <div className="text-[10px] mt-1" style={{ color: skin.colors.textMuted }}>
        {isGate ? 'verification' : status}
        {data.agentId ? ` · ${data.agentId}` : ''}
        {!isGate && data.blocked ? ' · gated' : ''}
      </div>
      {execution ? (
        <div
          className={`text-[10px] mt-0.5${execution.emphasis ? ' font-bold' : ''}`}
          style={{ color: execution.emphasis ? statusColor : skin.colors.textMuted }}
        >
          {execution.text}
        </div>
      ) : null}
      {/* A dependency cycle means this task can never become unblocked. Say so
          on the node — it is a data defect, and it is invisible in a list. */}
      {data.cyclic ? (
        <div className="text-[10px] mt-0.5 font-bold" style={{ color: skin.colors.taskBlocked }}>
          ⚠ dependency cycle
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
}

function GroupHeaderNode({ data }: { data: Record<string, unknown> }) {
  const skin = getSkin(useCommandStore((s) => s.skin));

  return (
    <div
      className="px-4 py-2 rounded-lg border"
      style={{
        backgroundColor: skin.colors.accent + '15',
        borderColor: skin.colors.accent + '40',
        fontFamily: skin.fonts.heading,
      }}
    >
      <span className="text-xs font-bold" style={{ color: skin.colors.accent }}>
        📋 {data.label as string}
      </span>
      {data.model === 'graph' ? (
        <span
          className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide"
          style={{
            backgroundColor: skin.colors.accent + '30',
            color: skin.colors.accent,
          }}
        >
          graph
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  taskNode: TaskNodeComponent,
  groupHeader: GroupHeaderNode,
};

// ─── Dependency layering ───

/**
 * Longest-path depth for every task, following `blockedBy` edges.
 *
 * Depth is the layout column: a task sits one column right of its latest
 * blocker, so in an acyclic graph an edge never points backwards and the
 * reading order matches the execution order.
 *
 * `blocked_by` is a bare `uuid[]` with nothing in the schema forbidding a
 * cycle, and a cycle here would recurse forever. The walk below detects one
 * and drops the back-edge *for layout only* — a task group that can never
 * start is worth surfacing, not silently laying out.
 *
 * Two deliberate choices about how a cycle is reported:
 *
 *  - **Every member is marked, not just the task the back-edge landed on.**
 *    Which task that is depends on iteration order, so marking one would
 *    label a different node run to run and tell the reader nothing about the
 *    cycle's extent. `backEdges` records the specific edges that close a
 *    cycle so the renderer can distinguish them.
 *  - **The back-edge is still drawn.** It is a real dependency, and hiding it
 *    would hide the cycle. It is the one edge that points backwards, so the
 *    renderer marks it rather than pretending the layout is a clean DAG.
 */
export function computeDepths(
  ids: string[],
  dependenciesOf: (id: string) => string[]
): { depth: Map<string, number>; cyclic: Set<string>; backEdges: Set<string> } {
  const depth = new Map<string, number>();
  const cyclic = new Set<string>();
  const backEdges = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (id: string): number => {
    const seen = state.get(id);
    if (seen === 'done') return depth.get(id) ?? 0;
    if (seen === 'visiting') {
      // Back-edge closes a cycle. Everything from `id` up the current DFS
      // stack is on that cycle — mark the whole set, not just this node.
      const from = stack.lastIndexOf(id);
      if (from !== -1) for (const member of stack.slice(from)) cyclic.add(member);
      else cyclic.add(id);
      return 0;
    }

    state.set(id, 'visiting');
    stack.push(id);
    let d = 0;
    for (const dep of dependenciesOf(id)) {
      if (state.get(dep) === 'visiting') backEdges.add(`${dep}->${id}`);
      d = Math.max(d, walk(dep) + 1);
    }
    stack.pop();
    state.set(id, 'done');
    depth.set(id, d);
    return d;
  };

  for (const id of ids) walk(id);
  return { depth, cyclic, backEdges };
}

// ─── Task Graph Component ───

export function TaskGraph() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const tasks = useCommandStore((s) => s.tasks);

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

    const byId = new Map(tasks.map((t) => [t.id, t]));

    // `blocked_by` may name tasks outside the fetched set — completed ones
    // filtered out by activeOnly, or tasks in another project. Those are real
    // dependencies but we have no node to attach them to, so they are dropped
    // from the layout rather than drawn as edges into nothing.
    const dependenciesOf = (id: string) =>
      (byId.get(id)?.blockedBy ?? []).filter((d) => byId.has(d));

    const { depth, cyclic, backEdges } = computeDepths(
      tasks.map((t) => t.id),
      dependenciesOf
    );

    // Mirror of the executor's SATISFIES predicate (spec v10): work counts
    // only when completed, gates only when passed. A dependency absent from
    // the fetched set was filtered by activeOnly, i.e. it already reached a
    // satisfying terminal state. Failed gates and failed/skipped work never
    // satisfy — downstream shows "upstream failed", the executor's
    // dependency-failure condition.
    const satisfies = (depId: string): boolean => {
      const dep = byId.get(depId);
      if (!dep) return true;
      return dep.taskType === 'verification'
        ? dep.gateState === 'passed'
        : dep.status === 'completed';
    };
    const unsatisfiable = (depId: string): boolean => {
      const dep = byId.get(depId);
      if (!dep) return false;
      if (dep.taskType === 'verification') return dep.gateState === 'failed';
      // Archived work is unsatisfiable-terminal (matches graph_unsatisfiable
      // in the DB) — the API ships archived blockers of the active set
      // precisely so this reads them.
      return dep.status === 'archived' || dep.outcome === 'failed' || dep.outcome === 'skipped';
    };
    const isReady = (t: (typeof tasks)[number]): boolean =>
      t.taskType !== 'verification' &&
      t.status === 'pending' &&
      !t.claimedBySessionId &&
      (t.blockedBy ?? []).every(satisfies);
    const hasFailedDep = (t: (typeof tasks)[number]): boolean =>
      (t.blockedBy ?? []).some(unsatisfiable);

    // Group tasks by groupId
    const groups = new Map<string, typeof tasks>();
    const ungrouped: typeof tasks = [];

    for (const task of tasks) {
      if (task.groupId) {
        const group = groups.get(task.groupId) ?? [];
        group.push(task);
        groups.set(task.groupId, group);
      } else {
        ungrouped.push(task);
      }
    }

    const COL = 240;
    const ROW = 92;
    let yOffset = 0;

    /** Places one set of tasks in dependency columns; returns its height. */
    const layoutSet = (set: typeof tasks, xBase: number, yBase: number): number => {
      const rowInColumn = new Map<number, number>();

      // Stable order within a column so the layout doesn't reshuffle on every
      // poll: declared order first, then title.
      const ordered = [...set].sort(
        (a, b) =>
          (a.taskOrder ?? Number.MAX_SAFE_INTEGER) - (b.taskOrder ?? Number.MAX_SAFE_INTEGER) ||
          a.title.localeCompare(b.title)
      );

      for (const task of ordered) {
        const d = depth.get(task.id) ?? 0;
        const row = rowInColumn.get(d) ?? 0;
        rowInColumn.set(d, row + 1);

        n.push({
          id: `task-${task.id}`,
          type: 'taskNode',
          position: { x: xBase + d * COL, y: yBase + row * ROW },
          data: {
            label: task.title,
            status: task.status,
            priority: task.priority,
            agentId: task.agentId,
            blocked: dependenciesOf(task.id).length > 0,
            cyclic: cyclic.has(task.id),
            taskType: task.taskType,
            gateState: task.gateState,
            gateAttempt: task.gateAttempt,
            eligibleAt: task.eligibleAt,
            claimed: Boolean(task.claimedBySessionId),
            ready: isReady(task),
            depFailed: hasFailedDep(task),
          },
        });
      }

      return Math.max(1, ...rowInColumn.values()) * ROW;
    };

    for (const [groupId, groupTasks] of groups) {
      const groupTitle = groupTasks[0]?.groupTitle ?? 'Task Group';
      const groupEdgeCount = groupTasks.reduce((sum, t) => sum + dependenciesOf(t.id).length, 0);

      n.push({
        id: `group-${groupId}`,
        type: 'groupHeader',
        position: { x: 0, y: yOffset },
        data: { label: groupTitle, model: groupTasks[0]?.groupExecutionModel ?? null },
      });

      const height = layoutSet(groupTasks, 200, yOffset);

      // Header connects to the entry points — every task nothing else blocks.
      for (const task of groupTasks) {
        if (dependenciesOf(task.id).length > 0) continue;
        e.push({
          id: `e-group-${groupId}-task-${task.id}`,
          source: `group-${groupId}`,
          target: `task-${task.id}`,
          animated: task.status === 'in_progress',
          style: { stroke: skin.colors.accent + '60' },
        });
      }

      // A group with no recorded dependencies is a list, and the honest way to
      // draw a list is as a dashed sequence — implied by task_order, not
      // declared by anyone. Solid edges are reserved for real blocked_by
      // links, so the picture never claims a dependency the data doesn't have.
      // A GRAPH group with no edges is different: genuinely parallel work,
      // not an implied order — drawing a sequence there would lie.
      const isGraphGroup = groupTasks[0]?.groupExecutionModel === 'graph';
      if (groupEdgeCount === 0 && groupTasks.length > 1 && !isGraphGroup) {
        const seq = [...groupTasks].sort(
          (a, b) =>
            (a.taskOrder ?? Number.MAX_SAFE_INTEGER) - (b.taskOrder ?? Number.MAX_SAFE_INTEGER)
        );
        for (let i = 1; i < seq.length; i += 1) {
          e.push({
            id: `e-seq-${seq[i - 1].id}-${seq[i].id}`,
            source: `task-${seq[i - 1].id}`,
            target: `task-${seq[i].id}`,
            animated: false,
            style: { stroke: skin.colors.border, strokeDasharray: '4 4' },
          });
        }
      }

      yOffset += height + ROW;
    }

    if (ungrouped.length > 0) {
      yOffset += layoutSet(ungrouped, 50, yOffset) + ROW;
    }

    // Dependency edges, including those crossing task groups — a cross-group
    // blocker is exactly the kind of coupling a per-group list cannot show.
    for (const task of tasks) {
      for (const depId of dependenciesOf(task.id)) {
        const blocker = byId.get(depId)!;
        // The one edge that closes a cycle is the one edge the layout could
        // not honour, so it is the one edge that points backwards. Draw it —
        // it is a real dependency — but mark it, rather than letting it read
        // as an ordinary link the reader is meant to trust.
        const isBackEdge = backEdges.has(`${depId}->${task.id}`);
        e.push({
          id: `e-dep-${depId}-${task.id}`,
          source: `task-${depId}`,
          target: `task-${task.id}`,
          animated: !isBackEdge && task.status === 'in_progress',
          label: isBackEdge ? '⚠ cycle' : undefined,
          style: {
            stroke: isBackEdge
              ? skin.colors.taskBlocked
              : blocker.status === 'completed'
                ? skin.colors.taskCompleted + '80'
                : skin.colors.taskBlocked + '90',
            strokeWidth: isBackEdge || blocker.groupId !== task.groupId ? 2 : 1,
            ...(isBackEdge ? { strokeDasharray: '6 3' } : {}),
          },
        });
      }
    }

    return { nodes: n, edges: e };
  }, [tasks, skin]);

  if (tasks.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ backgroundColor: skin.colors.surface, color: skin.colors.textMuted }}
      >
        <div className="text-center">
          <div className="text-2xl mb-2">📋</div>
          <div className="text-sm" style={{ fontFamily: skin.fonts.body }}>
            No active tasks
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full" style={{ backgroundColor: skin.colors.surface }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ backgroundColor: skin.colors.bg }}
      >
        <Background color={skin.colors.border} gap={20} />
        <Controls
          style={{
            backgroundColor: skin.colors.surface,
            borderColor: skin.colors.border,
          }}
        />
        <MiniMap
          style={{
            backgroundColor: skin.colors.bg,
            border: `1px solid ${skin.colors.border}`,
          }}
          nodeColor={(node) => {
            const status = node.data?.status as string;
            if (status === 'completed') return skin.colors.taskCompleted;
            if (status === 'in_progress') return skin.colors.taskInProgress;
            if (status === 'blocked') return skin.colors.taskBlocked;
            return skin.colors.taskPending;
          }}
        />
      </ReactFlow>
    </div>
  );
}
