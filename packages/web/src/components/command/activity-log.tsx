'use client';

import { useCommandStore } from './store';
import { getSkin } from './skins';

const AGENT_COLORS: Record<string, string> = {
  wren: '#e94560',
  lumen: '#0abde3',
  aster: '#f9ca24',
  myra: '#6c5ce7',
  benson: '#00b894',
  echo: '#ff9ff3',
};

const TYPE_ICONS: Record<string, string> = {
  agent_spawn: '▶',
  agent_complete: '✓',
  inkmail_dispatch: '✉',
  inkmail_deliver: '✉',
  inkmail_fail: '✖',
  state_change: '↺',
  message_in: '💬',
  message_out: '💬',
  error: '⚠',
  heartbeat: '♥',
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ActivityLog() {
  const skin = getSkin(useCommandStore((s) => s.skin));
  const agents = useCommandStore((s) => s.agents);
  const activity = useCommandStore((s) => s.activity);

  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: skin.colors.surface, color: skin.colors.text }}
    >
      {/* Agent status strip */}
      <div className="p-3 border-b shrink-0" style={{ borderColor: skin.colors.border }}>
        <div
          className="text-xs font-bold mb-2 tracking-wider uppercase"
          style={{ fontFamily: skin.fonts.heading, color: skin.colors.accent, fontSize: '10px' }}
        >
          Agents
        </div>
        <div className="space-y-0.5">
          {agents.map((agent) => {
            const color = AGENT_COLORS[agent.agentId] ?? '#888';
            const running = agent.lifecycle === 'running';
            // No session at all = offline. Idle is a real state (session
            // parked between turns); offline means nothing to report.
            const offline = !agent.lifecycle;
            return (
              <div
                key={agent.agentId}
                className="flex items-center gap-1.5 text-xs"
                style={{ fontFamily: skin.fonts.mono, fontSize: '10px' }}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0${running ? ' animate-pulse' : ''}`}
                  style={{
                    backgroundColor: running
                      ? skin.colors.agentActive
                      : offline
                        ? skin.colors.border
                        : skin.colors.agentIdle,
                  }}
                />
                <span className="font-bold shrink-0" style={{ color }}>
                  {agent.name}
                </span>
                <span className="truncate" style={{ color: skin.colors.textMuted }}>
                  {offline ? 'offline' : (agent.phase ?? agent.lifecycle)}
                </span>
                {agent.activeThreadKey && (
                  <span className="truncate shrink-0" style={{ color: skin.colors.accent }}>
                    {agent.activeThreadKey}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Event feed */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        <div
          className="text-xs font-bold mb-2 tracking-wider uppercase"
          style={{ fontFamily: skin.fonts.heading, color: skin.colors.accent, fontSize: '10px' }}
        >
          Activity
        </div>
        {activity.length === 0 ? (
          <div className="text-xs" style={{ color: skin.colors.textMuted }}>
            No recent activity
          </div>
        ) : (
          activity.map((event) => {
            const color = event.agentId ? (AGENT_COLORS[event.agentId] ?? '#888') : '#888';
            const icon = TYPE_ICONS[event.type] ?? '·';
            const failed = event.type === 'error' || event.type === 'inkmail_fail';
            return (
              <div
                key={event.id}
                className="text-xs leading-snug"
                style={{ fontFamily: skin.fonts.mono, fontSize: '10px' }}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="shrink-0"
                    style={{ color: failed ? skin.colors.taskBlocked : skin.colors.textMuted }}
                  >
                    {icon}
                  </span>
                  {event.agentId && (
                    <span className="font-bold shrink-0" style={{ color }}>
                      {event.agentId}
                    </span>
                  )}
                  <span className="shrink-0" style={{ color: skin.colors.textMuted }}>
                    {event.subtype ?? event.type}
                  </span>
                  <span
                    className="ml-auto shrink-0"
                    style={{ color: skin.colors.textMuted + '99' }}
                  >
                    {timeAgo(event.timestamp)}
                  </span>
                </div>
                {event.content && (
                  <div
                    className="pl-4 truncate"
                    style={{ color: failed ? skin.colors.taskBlocked : skin.colors.text + 'bb' }}
                    title={event.content}
                  >
                    {event.content}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div
        className="text-xs px-3 py-2 border-t shrink-0"
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
