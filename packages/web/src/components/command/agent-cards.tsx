'use client';

import { useCommandStore } from './store';
import { getSkin } from './skins';
import type { SkinConfig } from './skins';
import type { AgentState, StudioNode, TaskNode } from './store';

const AGENT_COLORS: Record<string, string> = {
  wren: '#e94560',
  lumen: '#0abde3',
  aster: '#f9ca24',
  myra: '#6c5ce7',
  benson: '#00b894',
};

function formatBackend(b: string | null): string {
  if (!b) return 'Unknown';
  const map: Record<string, string> = {
    'claude-code': 'Claude Code',
    claude: 'Claude',
    'codex-cli': 'Codex CLI',
    codex: 'Codex',
    gemini: 'Gemini',
  };
  return map[b] ?? b;
}

function timeAgo(ts: string | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function lifecycleColor(lifecycle: string | null, phase: string | null, skin: SkinConfig): string {
  if (lifecycle === 'running') return skin.colors.agentActive;
  if (phase?.startsWith('blocked')) return skin.colors.agentBlocked;
  return skin.colors.agentIdle;
}

function lifecycleLabel(lifecycle: string | null, phase: string | null): string {
  if (!lifecycle && !phase) return 'offline';
  if (lifecycle === 'running') return phase ?? 'active';
  if (lifecycle === 'idle') return phase ?? 'idle';
  return phase ?? lifecycle ?? 'unknown';
}

interface TaskStats {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
}

function computeTaskStats(agentId: string, tasks: TaskNode[]): TaskStats {
  const agentTasks = tasks.filter((t) => t.agentId === agentId);
  return {
    total: agentTasks.length,
    completed: agentTasks.filter((t) => t.status === 'completed' || t.status === 'done').length,
    inProgress: agentTasks.filter((t) => t.status === 'in_progress').length,
    blocked: agentTasks.filter((t) => t.status === 'blocked').length,
  };
}

function ProgressBar({ stats, skin }: { stats: TaskStats; skin: SkinConfig }) {
  if (stats.total === 0) return null;
  const pct = (stats.completed / stats.total) * 100;
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ backgroundColor: skin.colors.border }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: skin.colors.taskCompleted,
          }}
        />
      </div>
      <span className="text-[10px] shrink-0" style={{ color: skin.colors.textMuted }}>
        {stats.completed}/{stats.total}
      </span>
    </div>
  );
}

function AgentCard({
  agent,
  studios,
  taskStats,
  skin,
  onSelect,
}: {
  agent: AgentState;
  studios: StudioNode[];
  taskStats: TaskStats;
  skin: SkinConfig;
  onSelect: () => void;
}) {
  const color = AGENT_COLORS[agent.agentId] ?? '#888';
  const statusColor = lifecycleColor(agent.lifecycle, agent.phase, skin);
  const statusLabel = lifecycleLabel(agent.lifecycle, agent.phase);
  const isActive = agent.lifecycle === 'running';
  const activeStudios = studios.filter((s) => s.status === 'active');

  return (
    <button
      onClick={onSelect}
      className="w-full text-left rounded-lg border transition-all hover:scale-[1.01]"
      style={{
        backgroundColor: skin.colors.surface,
        borderColor: isActive ? statusColor + '60' : skin.colors.border,
        boxShadow: isActive ? `0 0 12px ${statusColor}20` : 'none',
      }}
    >
      {/* Header */}
      <div className="p-3 pb-2 flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0"
          style={{ backgroundColor: color }}
        >
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm truncate" style={{ color: skin.colors.text }}>
              {agent.name}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  backgroundColor: statusColor,
                  animation: isActive ? 'pulse 2s infinite' : 'none',
                }}
              />
              <span className="text-[10px]" style={{ color: statusColor }}>
                {statusLabel}
              </span>
            </div>
          </div>
          <span className="text-xs" style={{ color: skin.colors.textMuted }}>
            {formatBackend(agent.backend)}
          </span>
        </div>
      </div>

      {/* Active context */}
      {(agent.activeThreadKey || agent.phase) && (
        <div className="px-3 pb-2 space-y-1">
          {agent.activeThreadKey && (
            <div
              className="inline-block text-[11px] px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: skin.colors.accent + '18',
                color: skin.colors.accent,
                fontFamily: skin.fonts.mono,
              }}
            >
              {agent.activeThreadKey}
            </div>
          )}
        </div>
      )}

      {/* Studios */}
      {activeStudios.length > 0 && (
        <div className="px-3 pb-2">
          <div className="flex flex-wrap gap-1">
            {activeStudios.slice(0, 3).map((s) => (
              <span
                key={s.id}
                className="text-[10px] px-1.5 py-0.5 rounded truncate max-w-[120px]"
                style={{
                  backgroundColor: skin.colors.bg,
                  color: skin.colors.textMuted,
                  fontFamily: skin.fonts.mono,
                }}
              >
                {s.slug ?? s.branch}
              </span>
            ))}
            {activeStudios.length > 3 && (
              <span className="text-[10px] px-1" style={{ color: skin.colors.textMuted }}>
                +{activeStudios.length - 3}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Footer: tasks + time */}
      <div
        className="px-3 py-2 border-t flex items-center justify-between gap-2"
        style={{ borderColor: skin.colors.border + '60' }}
      >
        <div className="flex-1 min-w-0">
          <ProgressBar stats={taskStats} skin={skin} />
          {taskStats.total === 0 && (
            <span className="text-[10px]" style={{ color: skin.colors.textMuted }}>
              No active tasks
            </span>
          )}
        </div>
        <span
          className="text-[10px] shrink-0"
          style={{ color: skin.colors.textMuted, fontFamily: skin.fonts.mono }}
        >
          {timeAgo(agent.updatedAt)}
        </span>
      </div>
    </button>
  );
}

export function AgentCards() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const agents = useCommandStore((s) => s.agents);
  const studios = useCommandStore((s) => s.studios);
  const tasks = useCommandStore((s) => s.tasks);
  const selectAgent = useCommandStore((s) => s.selectAgent);

  const activeAgents = agents.filter((a) => a.lifecycle === 'running');
  const idleAgents = agents.filter((a) => a.lifecycle !== 'running');

  return (
    <div className="h-full overflow-y-auto p-6" style={{ backgroundColor: skin.colors.bg }}>
      {/* Summary bar */}
      <div className="flex items-center gap-4 mb-5">
        <h2
          className="text-xs font-bold tracking-wider uppercase"
          style={{ fontFamily: skin.fonts.heading, color: skin.colors.accent, fontSize: '10px' }}
        >
          Agent Workbench
        </h2>
        <div
          className="flex items-center gap-3 text-[11px]"
          style={{ color: skin.colors.textMuted }}
        >
          <span>
            <span style={{ color: skin.colors.agentActive }}>{activeAgents.length}</span> active
          </span>
          <span>{agents.length} total</span>
          <span>{studios.filter((s) => s.status === 'active').length} studios</span>
        </div>
      </div>

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <div className="mb-6">
          <div
            className="text-[10px] uppercase tracking-wider mb-2"
            style={{ color: skin.colors.agentActive, fontFamily: skin.fonts.mono }}
          >
            Working
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeAgents.map((agent) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                studios={studios.filter((s) => s.agentId === agent.agentId)}
                taskStats={computeTaskStats(agent.agentId, tasks)}
                skin={skin}
                onSelect={() => selectAgent(agent.agentId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Idle agents */}
      {idleAgents.length > 0 && (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider mb-2"
            style={{ color: skin.colors.textMuted, fontFamily: skin.fonts.mono }}
          >
            Idle
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {idleAgents.map((agent) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                studios={studios.filter((s) => s.agentId === agent.agentId)}
                taskStats={computeTaskStats(agent.agentId, tasks)}
                skin={skin}
                onSelect={() => selectAgent(agent.agentId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
