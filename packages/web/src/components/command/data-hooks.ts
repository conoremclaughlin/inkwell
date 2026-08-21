'use client';

import { useEffect } from 'react';
import { useApiQuery } from '@/lib/api';
import { useCommandStore } from './store';
import type { AgentState, StudioNode, StudioLeaseView, TaskNode, ActivityEvent } from './store';

// ─── Types matching API responses ───

interface StudioInfo {
  id: string;
  branch: string;
  purpose: string | null;
  workType: string | null;
  worktreePath: string | null;
  repoRoot: string | null;
  slug: string | null;
  status: string;
  updatedAt: string;
  lease: StudioLeaseView | null;
  ephemeral: boolean;
  parentStudioId: string | null;
  expiresAt: string | null;
}

interface AgentLatestSession {
  lifecycle: string | null;
  currentPhase: string | null;
  status: string | null;
  activeThreadKey: string | null;
  updatedAt: string;
  studioId: string | null;
}

interface AgentWithStudios {
  agentId: string;
  agentName: string;
  agentRole: string | null;
  backend: string | null;
  sbId: string;
  latestSession: AgentLatestSession | null;
  studios: StudioInfo[];
}

interface StudiosResponse {
  agents: AgentWithStudios[];
}

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  taskGroupId: string | null;
  taskOrder: number | null;
  blockedBy: string[] | null;
  createdBy: string | null;
  // Workflow graph execution state (spec v10 steps 2-3)
  taskType?: 'work' | 'verification';
  outcome?: string | null;
  gateState?: string | null;
  gateAttempt?: number | null;
  eligibleAt?: string | null;
  claimedBySessionId?: string | null;
}

interface TaskGroupItem {
  id: string;
  title: string;
  agentId: string | null;
  agentName: string | null;
  executionModel?: 'linear' | 'graph';
}

interface TasksResponse {
  tasks: TaskItem[];
  stats: Record<string, number>;
}

// The endpoint has always returned `groups`; this hook used to type the key
// as `taskGroups`, so the map silently never resolved group titles.
interface TaskGroupsResponse {
  groups: TaskGroupItem[];
}

// ─── Layout helpers ───

function arrangeStudiosInCircle(
  studios: StudioInfo[],
  agentId: string,
  centerX: number,
  centerY: number,
  radius: number
): StudioNode[] {
  return studios.map((s, i) => {
    const angle = (2 * Math.PI * i) / Math.max(studios.length, 1) - Math.PI / 2;
    return {
      id: s.id,
      slug: s.slug,
      branch: s.branch,
      purpose: s.purpose,
      workType: s.workType,
      status: s.status,
      agentId,
      repoRoot: s.repoRoot ?? null,
      lease: s.lease ?? null,
      ephemeral: s.ephemeral ?? false,
      parentStudioId: s.parentStudioId ?? null,
      expiresAt: s.expiresAt ?? null,
      position: {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      },
    };
  });
}

// ─── Hooks ───

export function useCommandData() {
  const setAgents = useCommandStore((s) => s.setAgents);
  const setStudios = useCommandStore((s) => s.setStudios);
  const setTasks = useCommandStore((s) => s.setTasks);
  const setActivity = useCommandStore((s) => s.setActivity);

  const { data: studiosData } = useApiQuery<StudiosResponse>(
    ['command-studios'],
    '/api/admin/studios',
    { refetchInterval: 5000 }
  );

  const { data: tasksData } = useApiQuery<TasksResponse>(
    ['command-tasks'],
    '/api/admin/tasks?activeOnly=true',
    { refetchInterval: 10000 }
  );

  const { data: groupsData } = useApiQuery<TaskGroupsResponse>(
    ['command-task-groups'],
    '/api/admin/task-groups',
    { refetchInterval: 10000 }
  );

  // Transform studios data into agent + studio state
  useEffect(() => {
    if (!studiosData?.agents) return;

    const agentStates: AgentState[] = [];
    const studioNodes: StudioNode[] = [];

    const cols = Math.min(3, studiosData.agents.length);
    const colSpacing = 200;
    const rowSpacing = 200;

    studiosData.agents.forEach((agent, agentIdx) => {
      const col = agentIdx % cols;
      const row = Math.floor(agentIdx / cols);
      const rowCount = Math.min(cols, studiosData.agents.length - row * cols);
      const centerX = (col - (rowCount - 1) / 2) * colSpacing;
      const centerY = (row - Math.floor((studiosData.agents.length - 1) / cols) / 2) * rowSpacing;

      // Presence is the lease, not the status column (spec:studio-canvas
      // principle 4). `status` reports 'active' for studios untouched for
      // months, so status-based presence put every agent in a studio at all
      // times — which is indistinguishable from putting them nowhere.
      // A held lease is the only evidence an agent is actually in a worktree.
      //
      // An agent can hold several studios at once, so collect them all. The
      // singular studioId is only where the agent avatar is drawn; taking the
      // first match as "the" answer would hide every other place it is
      // working, which is the failure this whole surface exists to fix.
      // Ordered by acquisition so the avatar lands on the oldest hold rather
      // than wherever the API happened to sort.
      const heldStudios = agent.studios
        .filter((s) => s.lease && !s.lease.quarantined && !s.lease.claimKind)
        .sort((a, b) => (a.lease!.acquiredAt < b.lease!.acquiredAt ? -1 : 1));
      const heldStudio = heldStudios[0] ?? null;

      agentStates.push({
        agentId: agent.agentId,
        name: agent.agentName,
        role: agent.agentRole,
        backend: agent.backend,
        studioId: heldStudio?.id ?? null,
        studioSlug: heldStudio?.slug ?? null,
        heldStudioIds: heldStudios.map((s) => s.id),
        lifecycle: agent.latestSession?.lifecycle ?? null,
        phase: agent.latestSession?.currentPhase ?? null,
        activeThreadKey: agent.latestSession?.activeThreadKey ?? null,
        updatedAt: agent.latestSession?.updatedAt ?? null,
        position: { x: centerX, y: centerY },
        targetPosition: null,
      });

      const arranged = arrangeStudiosInCircle(
        agent.studios.filter((s) => s.status !== 'cleaned'),
        agent.agentId,
        centerX,
        centerY,
        65
      );
      studioNodes.push(...arranged);
    });

    setAgents(agentStates);
    setStudios(studioNodes);
  }, [studiosData, setAgents, setStudios]);

  // Transform tasks
  useEffect(() => {
    if (!tasksData?.tasks) return;

    const groupMap = new Map<string, TaskGroupItem>();
    if (groupsData?.groups) {
      for (const g of groupsData.groups) {
        groupMap.set(g.id, g);
      }
    }

    const taskNodes: TaskNode[] = tasksData.tasks.map((t) => {
      const group = t.taskGroupId ? groupMap.get(t.taskGroupId) : undefined;
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        groupId: t.taskGroupId,
        groupTitle: group?.title ?? null,
        taskOrder: t.taskOrder,
        agentId: t.createdBy,
        blockedBy: t.blockedBy ?? [],
        taskType: t.taskType ?? 'work',
        outcome: t.outcome ?? null,
        gateState: t.gateState ?? null,
        gateAttempt: t.gateAttempt ?? null,
        eligibleAt: t.eligibleAt ?? null,
        claimedBySessionId: t.claimedBySessionId ?? null,
        groupExecutionModel: group?.executionModel ?? null,
      };
    });

    setTasks(taskNodes);
  }, [tasksData, groupsData, setTasks]);
}
