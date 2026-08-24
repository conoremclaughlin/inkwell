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
import type { TaskNode as TaskNodeData } from './store';
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
      className="px-4 py-2 rounded-lg border flex items-center max-w-[240px]"
      style={{
        backgroundColor: skin.colors.accent + '15',
        borderColor: skin.colors.accent + '40',
        fontFamily: skin.fonts.heading,
      }}
    >
      <span
        className="text-xs font-bold truncate"
        style={{ color: skin.colors.accent }}
        title={data.label as string}
      >
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

// ─── SATISFIES mirror (spec v10) ───

type TaskLike = TaskNodeData;

// Mirror of the executor's SATISFIES predicate: work counts only when
// completed, gates only when passed. A dependency absent from the fetched
// set was filtered by activeOnly, i.e. it already reached a satisfying
// terminal state. Failed gates and failed/skipped work never satisfy.
function makePredicates(byId: Map<string, TaskLike>) {
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
  const isReady = (t: TaskLike): boolean =>
    t.taskType !== 'verification' &&
    t.status === 'pending' &&
    !t.claimedBySessionId &&
    (t.blockedBy ?? []).every(satisfies);
  const hasFailedDep = (t: TaskLike): boolean => (t.blockedBy ?? []).some(unsatisfiable);
  return { satisfies, unsatisfiable, isReady, hasFailedDep };
}

// ─── Group summaries for the sidebar ───

const UNGROUPED = 'ungrouped';

interface GroupSummary {
  id: string;
  title: string;
  model: 'linear' | 'graph' | null;
  total: number;
  inProgress: number;
  ready: number;
  gatesOpen: number;
  failed: number;
}

/**
 * One row per group with the counts the operator scans for. Sorted by what
 * needs attention: running work first, then open gates awaiting verdicts,
 * then ready work, then sheer size — "what's about to occur" reads top-down.
 */
export function summarizeGroups(tasks: TaskLike[]): GroupSummary[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { isReady, hasFailedDep } = makePredicates(byId);

  const summaries = new Map<string, GroupSummary>();
  for (const t of tasks) {
    const key = t.groupId ?? UNGROUPED;
    let s = summaries.get(key);
    if (!s) {
      s = {
        id: key,
        title: t.groupId ? (t.groupTitle ?? 'Task Group') : 'Ungrouped',
        model: t.groupId ? t.groupExecutionModel : null,
        total: 0,
        inProgress: 0,
        ready: 0,
        gatesOpen: 0,
        failed: 0,
      };
      summaries.set(key, s);
    }
    s.total += 1;
    if (t.status === 'in_progress') s.inProgress += 1;
    if (isReady(t)) s.ready += 1;
    if (t.taskType === 'verification' && (t.gateState === 'open' || t.gateState === 'in_progress'))
      s.gatesOpen += 1;
    if ((t.taskType === 'verification' && t.gateState === 'failed') || hasFailedDep(t))
      s.failed += 1;
  }

  return [...summaries.values()].sort(
    (a, b) =>
      b.inProgress - a.inProgress ||
      b.gatesOpen - a.gatesOpen ||
      b.ready - a.ready ||
      b.total - a.total ||
      a.title.localeCompare(b.title)
  );
}

// ─── Task Graph Component ───

export function TaskGraph() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const tasks = useCommandStore((s) => s.tasks);
  const selectedTaskGroup = useCommandStore((s) => s.selectedTaskGroup);
  const selectTaskGroup = useCommandStore((s) => s.selectTaskGroup);

  const groupList = useMemo(() => summarizeGroups(tasks), [tasks]);

  // The graph draws ONE group at a time — hundreds of active tasks in a
  // single canvas was a wall of noise nobody could read. Selection falls
  // back to the most active group when nothing (or a vanished group) is
  // picked.
  const activeGroupId =
    selectedTaskGroup && groupList.some((g) => g.id === selectedTaskGroup)
      ? selectedTaskGroup
      : (groupList[0]?.id ?? null);

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];
    if (!activeGroupId) return { nodes: n, edges: e };

    // Readiness is judged over the FULL fetched set (a blocker may live in
    // another group), but only the focused group's nodes are drawn.
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const { isReady, hasFailedDep } = makePredicates(byId);

    const shown =
      activeGroupId === UNGROUPED
        ? tasks.filter((t) => !t.groupId)
        : tasks.filter((t) => t.groupId === activeGroupId);
    const shownIds = new Set(shown.map((t) => t.id));

    // Only edges with both endpoints on this canvas are drawable; deps that
    // are fetched but outside the group still count for the blocked flag.
    const dependenciesShown = (id: string) =>
      (byId.get(id)?.blockedBy ?? []).filter((d) => shownIds.has(d));
    const dependenciesFetched = (id: string) =>
      (byId.get(id)?.blockedBy ?? []).filter((d) => byId.has(d));

    const { depth, cyclic, backEdges } = computeDepths(
      shown.map((t) => t.id),
      dependenciesShown
    );

    const COL = 240;
    const ROW = 92;

    const rowInColumn = new Map<number, number>();
    // Stable order within a column so the layout doesn't reshuffle on every
    // poll: declared order first, then title.
    const ordered = [...shown].sort(
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
        position: { x: 200 + d * COL, y: row * ROW },
        data: {
          label: task.title,
          status: task.status,
          priority: task.priority,
          agentId: task.agentId,
          blocked: dependenciesFetched(task.id).length > 0,
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

    const isGraphGroup = shown[0]?.groupExecutionModel === 'graph';
    const groupEdgeCount = shown.reduce((sum, t) => sum + dependenciesShown(t.id).length, 0);

    if (activeGroupId !== UNGROUPED) {
      const midY = ((Math.max(1, ...rowInColumn.values()) - 1) * ROW) / 2;
      n.push({
        id: `group-${activeGroupId}`,
        type: 'groupHeader',
        position: { x: -80, y: midY },
        data: {
          label: shown[0]?.groupTitle ?? 'Task Group',
          model: shown[0]?.groupExecutionModel ?? null,
        },
      });

      // Header connects to the entry points — every task nothing else blocks.
      for (const task of shown) {
        if (dependenciesShown(task.id).length > 0) continue;
        e.push({
          id: `e-group-${activeGroupId}-task-${task.id}`,
          source: `group-${activeGroupId}`,
          target: `task-${task.id}`,
          animated: task.status === 'in_progress',
          style: { stroke: skin.colors.accent + '60' },
        });
      }
    }

    // A group with no recorded dependencies is a list, and the honest way to
    // draw a list is as a dashed sequence — implied by task_order, not
    // declared by anyone. Solid edges are reserved for real blocked_by
    // links, so the picture never claims a dependency the data doesn't have.
    // A GRAPH group with no edges is different: genuinely parallel work,
    // not an implied order — drawing a sequence there would lie.
    if (groupEdgeCount === 0 && shown.length > 1 && !isGraphGroup && activeGroupId !== UNGROUPED) {
      const seq = [...shown].sort(
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

    // Dependency edges within the focused group.
    for (const task of shown) {
      for (const depId of dependenciesShown(task.id)) {
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
            strokeWidth: isBackEdge ? 2 : 1,
            ...(isBackEdge ? { strokeDasharray: '6 3' } : {}),
          },
        });
      }
    }

    return { nodes: n, edges: e };
  }, [tasks, skin, activeGroupId]);

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
    <div
      className="h-full w-full flex overflow-hidden"
      style={{ backgroundColor: skin.colors.surface }}
    >
      {/* Group list — pick which graph the canvas shows */}
      <div
        className="w-72 shrink-0 border-r overflow-y-auto"
        style={{ borderColor: skin.colors.border, backgroundColor: skin.colors.surface }}
      >
        <div
          className="px-3 pt-3 pb-2 text-xs font-bold tracking-wider uppercase sticky top-0"
          style={{
            fontFamily: skin.fonts.heading,
            color: skin.colors.accent,
            fontSize: '10px',
            backgroundColor: skin.colors.surface,
          }}
        >
          Task Groups ({groupList.length})
        </div>
        {groupList.map((g) => {
          const selected = g.id === activeGroupId;
          return (
            <button
              key={g.id}
              onClick={() => selectTaskGroup(g.id)}
              className="w-full text-left px-3 py-2 border-l-2 transition-colors"
              style={{
                borderLeftColor: selected ? skin.colors.accent : 'transparent',
                backgroundColor: selected ? skin.colors.accent + '12' : 'transparent',
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="text-xs truncate"
                  style={{
                    color: selected ? skin.colors.text : skin.colors.textMuted,
                    fontFamily: skin.fonts.body,
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  {g.title}
                </span>
                {g.model === 'graph' && (
                  <span
                    className="shrink-0 px-1 rounded text-[8px] font-bold uppercase tracking-wide"
                    style={{
                      backgroundColor: skin.colors.accent + '30',
                      color: skin.colors.accent,
                    }}
                  >
                    graph
                  </span>
                )}
              </div>
              <div
                className="flex items-center gap-2 mt-0.5 text-[10px]"
                style={{ fontFamily: skin.fonts.mono }}
              >
                {g.inProgress > 0 && (
                  <span style={{ color: skin.colors.taskInProgress }}>⚙ {g.inProgress}</span>
                )}
                {g.gatesOpen > 0 && (
                  <span style={{ color: skin.colors.accent }}>🛡 {g.gatesOpen}</span>
                )}
                {g.ready > 0 && (
                  <span style={{ color: skin.colors.taskCompleted }}>▶ {g.ready}</span>
                )}
                {g.failed > 0 && (
                  <span style={{ color: skin.colors.taskBlocked }}>✖ {g.failed}</span>
                )}
                <span style={{ color: skin.colors.textMuted }}>{g.total} tasks</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Focused group graph. Keyed by group so ReactFlow re-mounts and
          re-fits the viewport on every selection instead of leaving the
          camera where the previous graph was. Node-count presence is part of
          the key because fitView only runs on mount: on first load the flow
          mounts before the poll returns, and without the remount the graph
          renders wherever the default camera happened to be. */}
      <div className="flex-1 min-w-0">
        <ReactFlow
          key={`${activeGroupId ?? 'none'}-${nodes.length === 0 ? 'empty' : 'ready'}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
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
            // Default mask is light gray — on a dark skin it renders as a
            // glaring box that hides the map it is supposed to frame.
            maskColor={skin.colors.bg + 'b3'}
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
    </div>
  );
}
