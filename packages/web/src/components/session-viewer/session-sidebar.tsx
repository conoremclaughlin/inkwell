'use client';

import { useMemo, useState } from 'react';
import { useApiQuery } from '@/lib/api';
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

type StatusFilter = 'all' | 'active' | 'completed';

function isActive(s: Session): boolean {
  return s.lifecycle === 'running' || s.lifecycle === 'idle';
}

function isCompleted(s: Session): boolean {
  return (
    s.lifecycle === 'completed' ||
    s.lifecycle === 'complete' ||
    s.lifecycle === 'failed' ||
    s.lifecycle === 'paused'
  );
}

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

function matchesSearch(session: Session, query: string): boolean {
  const q = query.toLowerCase();
  return (
    session.agentId.toLowerCase().includes(q) ||
    session.agentName.toLowerCase().includes(q) ||
    (session.activeThreadKey?.toLowerCase().includes(q) ?? false) ||
    (session.studio?.branch?.toLowerCase().includes(q) ?? false) ||
    (session.studio?.slug?.toLowerCase().includes(q) ?? false) ||
    (session.currentPhase?.toLowerCase().includes(q) ?? false) ||
    (session.backend?.toLowerCase().includes(q) ?? false)
  );
}

function SessionItem({
  session,
  isSelected,
  onSelect,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const dot = statusDot(session.lifecycle, session.currentPhase);
  return (
    <button
      onClick={() => onSelect(session.id)}
      className={clsx(
        'w-full text-left px-3 py-1.5 transition-colors',
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
        <div className="mt-0.5 pl-3">
          <span className="text-[10px] font-mono text-indigo-500 truncate block">
            {session.activeThreadKey}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 mt-0.5 pl-3 text-[10px] text-gray-400">
        {session.studio?.branch && <span className="truncate">{session.studio.branch}</span>}
        {session.studio?.slug && !session.studio.branch && (
          <span className="truncate">{session.studio.slug}</span>
        )}
        {session.backend && <span className="shrink-0">{session.backend}</span>}
        {session.messageCount != null && session.messageCount > 0 && (
          <span className="shrink-0">{session.messageCount} msgs</span>
        )}
      </div>
    </button>
  );
}

function AgentGroup({
  agentId,
  sessions,
  selectedId,
  onSelect,
  defaultExpanded,
}: {
  agentId: string;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const activeCount = sessions.filter((s) => s.lifecycle === 'running').length;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 pt-2.5 pb-1 flex items-center gap-1.5 hover:bg-gray-50 transition-colors"
      >
        <svg
          className={clsx(
            'w-3 h-3 text-gray-400 transition-transform shrink-0',
            expanded && 'rotate-90'
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${AGENT_COLORS[agentId] ?? 'bg-gray-400'}`}
        />
        <span className="text-xs font-semibold text-gray-700 capitalize">{agentId}</span>
        <span className="text-[10px] text-gray-400">{sessions.length}</span>
        {activeCount > 0 && (
          <span className="text-[10px] text-green-600 ml-auto">{activeCount} active</span>
        )}
      </button>
      {expanded &&
        sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isSelected={session.id === selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export function SessionSidebar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');

  const { data } = useApiQuery<SessionsResponse>(
    ['session-viewer-sessions'],
    '/api/admin/sessions',
    { refetchInterval: 15000, staleTime: 0 }
  );

  const sessions = data?.sessions ?? [];

  const filtered = useMemo(() => {
    let result = sessions;
    if (filter === 'active') result = result.filter(isActive);
    else if (filter === 'completed') result = result.filter(isCompleted);
    if (search.trim()) result = result.filter((s) => matchesSearch(s, search.trim()));
    return result;
  }, [sessions, filter, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of filtered) {
      const key = s.agentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    const withActive = Array.from(groups.entries()).filter(([, ss]) =>
      ss.some((s) => s.lifecycle === 'running')
    );
    const withoutActive = Array.from(groups.entries()).filter(
      ([, ss]) => !ss.some((s) => s.lifecycle === 'running')
    );
    return [...withActive, ...withoutActive];
  }, [filtered]);

  const counts = useMemo(() => {
    const running = sessions.filter((s) => s.lifecycle === 'running').length;
    const active = sessions.filter(isActive).length;
    const completed = sessions.filter(isCompleted).length;
    return { running, active, completed, total: sessions.length };
  }, [sessions]);

  return (
    <div className="h-full flex flex-col border-r border-gray-200 bg-white" style={{ width: 280 }}>
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-200 shrink-0">
        <h2 className="text-xs font-bold tracking-wider text-gray-500 uppercase">Sessions</h2>
        <div className="flex gap-2 mt-1 text-[10px] text-gray-400">
          <span>{counts.running} running</span>
          <span>·</span>
          <span>{counts.total} total</span>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-gray-100 shrink-0">
        <input
          type="text"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 bg-gray-50 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex px-3 py-1.5 gap-1 border-b border-gray-100 shrink-0">
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded-full capitalize transition-colors',
              filter === f ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'
            )}
          >
            {f}
            <span className="ml-1 opacity-60">
              {f === 'all' ? counts.total : f === 'active' ? counts.active : counts.completed}
            </span>
          </button>
        ))}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {grouped.map(([agentId, agentSessions]) => (
          <AgentGroup
            key={agentId}
            agentId={agentId}
            sessions={agentSessions}
            selectedId={selectedId}
            onSelect={onSelect}
            defaultExpanded={
              agentSessions.some((s) => s.lifecycle === 'running') ||
              agentSessions.some((s) => s.id === selectedId)
            }
          />
        ))}

        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-gray-400">
            {search ? 'No sessions match your search' : 'No sessions'}
          </div>
        )}
      </div>
    </div>
  );
}
