import { create } from 'zustand';

// ─── Types ───

export type SkinId = 'pixel' | 'scifi' | 'minimal';

export interface AgentState {
  agentId: string;
  name: string;
  role: string | null;
  backend: string | null;
  studioId: string | null;
  studioSlug: string | null;
  lifecycle: string | null;
  phase: string | null;
  updatedAt: string | null;
  position: { x: number; y: number };
  targetPosition: { x: number; y: number } | null;
}

export interface StudioNode {
  id: string;
  slug: string | null;
  branch: string;
  purpose: string | null;
  workType: string | null;
  status: string;
  agentId: string;
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
}

export interface ActivityEvent {
  id: string;
  type: string;
  agentId: string | null;
  content: string;
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

  showTaskGraph: true,
  toggleTaskGraph: () => set((s) => ({ showTaskGraph: !s.showTaskGraph })),
}));
