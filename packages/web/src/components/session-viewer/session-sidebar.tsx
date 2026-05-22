'use client';

import { useMemo } from 'react';
import { useApiQuery } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import clsx from 'clsx';

interface SessionWorkspace {
  id: string;
  branch: string | null;
  repoName: string | null;
  slug: string | null;
}

interface Session {
  id: string;
  agentId: string;
  agentName: string;
  agentRole: string | null;
  backend: string | null;
  lifecycle: string | null;
  currentPhase: string | null;
  activeThreadKey: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  messageCount: number | null;
  studio: SessionWorkspace | null;
}

interface SessionsResponse {
  stats: Record<string, number>;
  sessions: Session[];
}

const AGENT_COLORS: Record<string, string> = {
  wren: 'bg-rose-500',
  lumen: 'bg-cyan-500',
  aster: 'bg-yellow-500',
  myra: 'bg-violet-500',
  benson: 'bg-emerald-500',
};

function formatRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusDot(
  lifecycle: string | null,
  phase: string | null
): { color: string; pulse: boolean } {
  if (lifecycle === 'running') {
    if (phase === 'runtime:generating') return { color: 'bg-blue-500', pulse: true };
    return { color: 'bg-green-500', pulse: true };
  }
  if (phase?.startsWith('blocked')) return { color: 'bg-amber-500', pulse: false };
  if (lifecycle === 'idle') return { color: 'bg-green-400', pulse: false };
  return { color: 'bg-gray-400', pulse: false };
}

function phaseText(lifecycle: string | null, phase: string | null): string {
  if (lifecycle === 'running') {
    if (phase === 'runtime:generating') return 'generating';
    return phase?.replace('runtime:', '') ?? 'running';
  }
  if (phase?.startsWith('blocked')) return phase;
  if (lifecycle === 'idle') return phase ?? 'idle';
  return phase ?? lifecycle ?? '';
}

export function SessionSidebar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data } = useApiQuery<SessionsResponse>(
    ['session-viewer-sessions'],
    '/api/admin/sessions',
    { refetchInterval: 15000, staleTime: 0 }
  );

  const sessions = data?.sessions ?? [];

  const grouped = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const key = s.agentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    const active = Array.from(groups.entries()).filter(([, ss]) =>
      ss.some((s) => s.lifecycle === 'running')
    );
    const idle = Array.from(groups.entries()).filter(
      ([, ss]) => !ss.some((s) => s.lifecycle === 'running')
    );
    return [...active, ...idle];
  }, [sessions]);

  return (
    <div className="h-full flex flex-col border-r border-gray-200 bg-white" style={{ width: 280 }}>
      <div className="px-3 py-2.5 border-b border-gray-200 shrink-0">
        <h2 className="text-xs font-bold tracking-wider text-gray-500 uppercase">Sessions</h2>
        <div className="flex gap-2 mt-1 text-[10px] text-gray-400">
          <span>{sessions.filter((s) => s.lifecycle === 'running').length} active</span>
          <span>·</span>
          <span>{sessions.length} total</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {grouped.map(([agentId, agentSessions]) => (
          <div key={agentId}>
            <div className="px-3 pt-3 pb-1 flex items-center gap-1.5">
              <div
                className={`w-2.5 h-2.5 rounded-full ${AGENT_COLORS[agentId] ?? 'bg-gray-400'}`}
              />
              <span className="text-xs font-semibold text-gray-700 capitalize">{agentId}</span>
              <span className="text-[10px] text-gray-400">{agentSessions.length}</span>
            </div>
            {agentSessions.map((session) => {
              const dot = statusDot(session.lifecycle, session.currentPhase);
              const isSelected = session.id === selectedId;
              return (
                <button
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2 transition-colors',
                    isSelected
                      ? 'bg-blue-50 border-l-2 border-blue-500'
                      : 'hover:bg-gray-50 border-l-2 border-transparent'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        className={clsx(
                          'w-1.5 h-1.5 rounded-full shrink-0',
                          dot.color,
                          dot.pulse && 'animate-pulse'
                        )}
                      />
                      <span className="text-xs text-gray-600 truncate">
                        {phaseText(session.lifecycle, session.currentPhase) || 'session'}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-400 shrink-0 ml-1">
                      {formatRelative(session.updatedAt)}
                    </span>
                  </div>

                  {session.activeThreadKey && (
                    <div className="mt-0.5">
                      <span className="text-[10px] font-mono text-indigo-500">
                        {session.activeThreadKey}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400">
                    {session.studio?.branch && (
                      <span className="truncate">{session.studio.branch}</span>
                    )}
                    {session.studio?.slug && !session.studio.branch && (
                      <span className="truncate">{session.studio.slug}</span>
                    )}
                    {session.backend && <span className="shrink-0">{session.backend}</span>}
                  </div>

                  {session.messageCount != null && session.messageCount > 0 && (
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      {session.messageCount} messages
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        {sessions.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-gray-400">No active sessions</div>
        )}
      </div>
    </div>
  );
}
