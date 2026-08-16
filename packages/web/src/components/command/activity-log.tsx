'use client';

import { useCommandStore } from './store';
import { getSkin } from './skins';

const AGENT_COLORS: Record<string, string> = {
  wren: '#e94560',
  lumen: '#0abde3',
  aster: '#f9ca24',
  myra: '#6c5ce7',
  benson: '#00b894',
};

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ActivityLog() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const agents = useCommandStore((s) => s.agents);

  return (
    <div
      className="h-full overflow-y-auto p-3 space-y-1"
      style={{ backgroundColor: skin.colors.surface, color: skin.colors.text }}
    >
      <div
        className="text-xs font-bold mb-2 tracking-wider uppercase"
        style={{ fontFamily: skin.fonts.heading, color: skin.colors.accent, fontSize: '10px' }}
      >
        Activity Log
      </div>

      {agents.length === 0 ? (
        <div className="text-xs" style={{ color: skin.colors.textMuted }}>
          Waiting for data...
        </div>
      ) : (
        agents.map((agent) => {
          const color = AGENT_COLORS[agent.agentId] ?? '#888';
          const phase = agent.phase ?? 'idle';
          const updated = agent.updatedAt ? formatTime(agent.updatedAt) : '--:--';

          return (
            <div
              key={agent.agentId}
              className="flex items-center gap-2 py-1 px-2 rounded text-xs"
              style={{
                fontFamily: skin.fonts.mono,
                backgroundColor: skin.colors.bg + '80',
              }}
            >
              <span style={{ color: skin.colors.textMuted }}>{updated}</span>
              <span className="font-bold" style={{ color }}>
                {agent.name}
              </span>
              <span style={{ color: skin.colors.textMuted }}>→</span>
              <span style={{ color: skin.colors.text }} className="truncate">
                {phase}
              </span>
              {agent.activeThreadKey && (
                <span style={{ color: skin.colors.accent }} className="truncate">
                  {agent.activeThreadKey}
                </span>
              )}
              {agent.lifecycle === 'running' && (
                <span
                  className="inline-block w-2 h-2 rounded-full animate-pulse"
                  style={{ backgroundColor: skin.colors.agentActive }}
                />
              )}
            </div>
          );
        })
      )}

      <div
        className="text-xs mt-3 pt-2 border-t"
        style={{
          color: skin.colors.textMuted,
          borderColor: skin.colors.border,
          fontFamily: skin.fonts.mono,
        }}
      >
        {agents.filter((a) => a.lifecycle === 'running').length} active · {agents.length} total SBs
      </div>
    </div>
  );
}
