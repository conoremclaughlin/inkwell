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

function TaskNodeComponent({ data }: { data: Record<string, unknown> }) {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const status = data.status as string;
  const title = data.label as string;
  const priority = data.priority as string;

  const statusColor =
    status === 'completed'
      ? skin.colors.taskCompleted
      : status === 'in_progress'
        ? skin.colors.taskInProgress
        : status === 'blocked'
          ? skin.colors.taskBlocked
          : skin.colors.taskPending;

  const priorityBadge =
    priority === 'critical' ? '🔴' : priority === 'high' ? '🟠' : priority === 'medium' ? '🟡' : '';

  return (
    <div
      className="px-3 py-2 rounded shadow-lg border-2 min-w-[140px] max-w-[200px]"
      style={{
        backgroundColor: skin.colors.surface,
        borderColor: statusColor,
        fontFamily: skin.fonts.body,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-400" />
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
        <span className="text-xs font-medium truncate" style={{ color: skin.colors.text }}>
          {priorityBadge} {title}
        </span>
      </div>
      <div className="text-[10px] mt-1" style={{ color: skin.colors.textMuted }}>
        {status}
        {data.agentId ? ` · ${data.agentId}` : ''}
      </div>
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
      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  taskNode: TaskNodeComponent,
  groupHeader: GroupHeaderNode,
};

// ─── Task Graph Component ───

export function TaskGraph() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const tasks = useCommandStore((s) => s.tasks);

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];

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

    let yOffset = 0;

    // Render grouped tasks
    for (const [groupId, groupTasks] of groups) {
      const sorted = [...groupTasks].sort((a, b) => (a.taskOrder ?? 0) - (b.taskOrder ?? 0));
      const groupTitle = sorted[0]?.groupTitle ?? 'Task Group';

      n.push({
        id: `group-${groupId}`,
        type: 'groupHeader',
        position: { x: 0, y: yOffset },
        data: { label: groupTitle },
      });

      sorted.forEach((task, i) => {
        const nodeId = `task-${task.id}`;
        n.push({
          id: nodeId,
          type: 'taskNode',
          position: { x: 200 + i * 220, y: yOffset },
          data: {
            label: task.title,
            status: task.status,
            priority: task.priority,
            agentId: task.agentId,
          },
        });

        // Edge from group header to first task
        if (i === 0) {
          e.push({
            id: `e-group-${groupId}-${nodeId}`,
            source: `group-${groupId}`,
            target: nodeId,
            animated: task.status === 'in_progress',
            style: { stroke: skin.colors.accent + '60' },
          });
        }

        // Chain edges between sequential tasks
        if (i > 0) {
          const prevId = `task-${sorted[i - 1].id}`;
          e.push({
            id: `e-${prevId}-${nodeId}`,
            source: prevId,
            target: nodeId,
            animated: task.status === 'in_progress',
            style: {
              stroke:
                sorted[i - 1].status === 'completed'
                  ? skin.colors.taskCompleted + '80'
                  : skin.colors.border,
            },
          });
        }
      });

      yOffset += 100;
    }

    // Ungrouped tasks
    ungrouped.forEach((task, i) => {
      n.push({
        id: `task-${task.id}`,
        type: 'taskNode',
        position: { x: 50 + (i % 4) * 220, y: yOffset + Math.floor(i / 4) * 80 },
        data: {
          label: task.title,
          status: task.status,
          priority: task.priority,
          agentId: task.agentId,
        },
      });
    });

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
