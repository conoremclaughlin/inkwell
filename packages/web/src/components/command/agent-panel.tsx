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

function formatBackend(b: string | null): string {
  if (!b) return 'Unknown';
  const map: Record<string, string> = {
    'claude-code': 'Claude Code',
    'codex-cli': 'Codex CLI',
    gemini: 'Gemini',
  };
  return map[b] ?? b;
}

export function AgentPanel() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const selectedAgent = useCommandStore((s) => s.selectedAgent);
  const agents = useCommandStore((s) => s.agents);
  const studios = useCommandStore((s) => s.studios);
  const selectAgent = useCommandStore((s) => s.selectAgent);

  const agent = agents.find((a) => a.agentId === selectedAgent);
  if (!agent) return null;

  const agentStudios = studios.filter((s) => s.agentId === agent.agentId);
  const color = AGENT_COLORS[agent.agentId] ?? '#888';

  return (
    <div
      className="absolute top-4 right-4 w-72 rounded-lg shadow-xl border overflow-hidden z-10"
      style={{
        backgroundColor: skin.colors.surface,
        borderColor: skin.colors.border,
        fontFamily: skin.fonts.body,
      }}
    >
      {/* Header */}
      <div className="p-4 border-b" style={{ borderColor: skin.colors.border }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
              style={{ backgroundColor: color }}
            >
              {agent.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-bold" style={{ color: skin.colors.text }}>
                {agent.name}
              </div>
              <div className="text-xs" style={{ color: skin.colors.textMuted }}>
                {formatBackend(agent.backend)}
              </div>
            </div>
          </div>
          <button
            onClick={() => selectAgent(null)}
            className="text-lg leading-none hover:opacity-70"
            style={{ color: skin.colors.textMuted }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="p-4 space-y-3">
        <div>
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: skin.colors.textMuted }}
          >
            Status
          </div>
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor:
                  agent.lifecycle === 'running'
                    ? skin.colors.agentActive
                    : agent.phase?.startsWith('blocked')
                      ? skin.colors.agentBlocked
                      : skin.colors.agentIdle,
              }}
            />
            <span className="text-sm" style={{ color: skin.colors.text }}>
              {agent.lifecycle ?? 'idle'}
              {agent.phase ? ` · ${agent.phase}` : ''}
            </span>
          </div>
          {agent.activeThreadKey && (
            <div
              className="text-xs mt-1 px-1.5 py-0.5 rounded inline-block"
              style={{ backgroundColor: skin.colors.bg, color: skin.colors.accent }}
            >
              {agent.activeThreadKey}
            </div>
          )}
        </div>

        {agent.role && (
          <div>
            <div
              className="text-[10px] uppercase tracking-wider mb-1"
              style={{ color: skin.colors.textMuted }}
            >
              Role
            </div>
            <div className="text-sm" style={{ color: skin.colors.text }}>
              {agent.role}
            </div>
          </div>
        )}

        {/* Studios */}
        <div>
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: skin.colors.textMuted }}
          >
            Studios ({agentStudios.length})
          </div>
          <div className="space-y-1">
            {agentStudios.map((studio) => (
              <div
                key={studio.id}
                className="flex items-center gap-2 px-2 py-1 rounded text-xs"
                style={{ backgroundColor: skin.colors.bg }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      studio.status === 'active'
                        ? skin.colors.studioActive
                        : skin.colors.studioIdle,
                  }}
                />
                <span style={{ color: skin.colors.text }} className="truncate">
                  {studio.slug ?? studio.branch}
                </span>
                {studio.workType && (
                  <span style={{ color: skin.colors.textMuted }} className="shrink-0">
                    {studio.workType}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
