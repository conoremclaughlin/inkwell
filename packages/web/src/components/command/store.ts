import { create } from 'zustand';

// ─── Types ───

export type SkinId = 'pixel' | 'scifi' | 'minimal';

export interface AgentState {
  agentId: string;
  name: string;
  role: string | null;
  backend: string | null;
  /** Identity UUID (agent_identities.id) — matches task assignee references. */
  sbId: string | null;
  /** Primary studio the agent holds. Null when it holds none. */
  studioId: string | null;
  studioSlug: string | null;
  /**
   * Every studio this agent currently holds a lease on. An agent can hold
   * more than one (concurrent sessions in separate worktrees), so `studioId`
   * alone would hide real occupancy — it is the marker for where to draw the
   * agent, not a claim that it is the only place they are.
   */
  heldStudioIds: string[];
  lifecycle: string | null;
  phase: string | null;
  activeThreadKey: string | null;
  updatedAt: string | null;
  position: { x: number; y: number };
  targetPosition: { x: number; y: number } | null;
}

/**
 * Occupancy for a studio, as recorded by the lease
 * (spec:trigger-studio-routing Phase 5). Null when the studio is free.
 */
export interface StudioLeaseView {
  sessionId: string;
  threadKey: string;
  agentId: string;
  acquiredAt: string;
  heartbeatAt: string;
  reason?: string;
  quarantined: boolean;
  claimKind: string | null;
  pendingRelease: { reason: string; requestedAt: string } | null;
  /** Past the staleness threshold — reclaimable, not necessarily dead. */
  stale: boolean;
  heartbeatAgeMs: number | null;
}

export interface StudioNode {
  id: string;
  slug: string | null;
  branch: string;
  purpose: string | null;
  workType: string | null;
  status: string;
  agentId: string;
  /** Repo this studio's worktree belongs to — the Level 0 territory key. */
  repoRoot: string | null;
  lease: StudioLeaseView | null;
  ephemeral: boolean;
  parentStudioId: string | null;
  expiresAt: string | null;
  position: { x: number; y: number };
}

export interface TaskNode {
  id: string;
  title: string;
  status: string;
  priority: string;
  groupId: string | null;
  groupTitle: string | null;
  taskOrder: number | null;
  agentId: string | null;
  /** Task IDs that must complete before this one — the real graph edges. */
  blockedBy: string[];
  // Workflow graph execution state (spec: ink://specs/workflow-graph v10).
  // 'work' for every legacy task; verification nodes are gates.
  taskType: 'work' | 'verification';
  outcome: string | null;
  gateState: string | null;
  gateAttempt: number | null;
  /** Dwelling gates: when the gate becomes openable (scheduled ≠ stalled). */
  eligibleAt: string | null;
  claimedBySessionId: string | null;
  /** Identity UUID this node is assigned to (verdict authority for gates). */
  assigneeIdentityId: string | null;
  /** The owning group's executor — 'graph' groups run the ready-node scheduler. */
  groupExecutionModel: 'linear' | 'graph' | null;
}

export interface ActivityEvent {
  id: string;
  type: string;
  subtype: string | null;
  agentId: string | null;
  content: string | null;
  status: string | null;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  to: string | null;
  content: string;
  timestamp: string;
  threadKey: string | null;
}

// ─── Store ───

interface CommandStore {
  skin: SkinId;
  setSkin: (skin: SkinId) => void;

  agents: AgentState[];
  setAgents: (agents: AgentState[]) => void;

  studios: StudioNode[];
  setStudios: (studios: StudioNode[]) => void;

  tasks: TaskNode[];
  setTasks: (tasks: TaskNode[]) => void;

  activity: ActivityEvent[];
  addActivity: (event: ActivityEvent) => void;
  setActivity: (events: ActivityEvent[]) => void;

  selectedAgent: string | null;
  selectAgent: (agentId: string | null) => void;

  selectedStudio: string | null;
  selectStudio: (studioId: string | null) => void;

  /**
   * Group focused in the TASKS view. Hundreds of active tasks exist at any
   * time, so the graph renders ONE group's tasks; this picks which. Null =
   * nothing picked yet (the view defaults to the most active group).
   */
  selectedTaskGroup: string | null;
  selectTaskGroup: (groupId: string | null) => void;

  showTaskGraph: boolean;
  toggleTaskGraph: () => void;
}

export const useCommandStore = create<CommandStore>((set) => ({
  skin: 'pixel',
  setSkin: (skin) => set({ skin }),

  agents: [],
  setAgents: (agents) => set({ agents }),

  studios: [],
  setStudios: (studios) => set({ studios }),

  tasks: [],
  setTasks: (tasks) => set({ tasks }),

  activity: [],
  addActivity: (event) => set((s) => ({ activity: [event, ...s.activity].slice(0, 100) })),
  setActivity: (events) => set({ activity: events }),

  selectedAgent: null,
  selectAgent: (agentId) => set({ selectedAgent: agentId }),

  selectedStudio: null,
  selectStudio: (studioId) => set({ selectedStudio: studioId }),

  selectedTaskGroup: null,
  selectTaskGroup: (groupId) => set({ selectedTaskGroup: groupId }),

  showTaskGraph: true,
  toggleTaskGraph: () => set((s) => ({ showTaskGraph: !s.showTaskGraph })),
}));
