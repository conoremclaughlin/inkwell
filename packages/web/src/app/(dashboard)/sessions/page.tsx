'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Activity,
  AlertTriangle,
  Pause,
  CircleDot,
  Monitor,
  GitBranch,
  ChevronDown,
  Hash,
  FolderGit2,
  MessageSquare,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

interface SessionWorkspace {
  id: string;
  branch: string | null;
  baseBranch: string | null;
  purpose: string | null;
  workType: string | null;
  status: string;
}

interface Session {
  id: string;
  backendSessionId: string | null;
  agentId: string;
  agentName: string;
  agentRole: string | null;
  status: string;
  currentPhase: string | null;
  summary: string | null;
  context: string | null;
  backend: string | null;
  model: string | null;
  messageCount: number | null;
  tokenCount: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  workspace: SessionWorkspace | null;
  preview: Array<{
    id: string;
    source: 'activity_stream' | 'session_logs' | 'local_transcript';
    type: string;
    role: 'in' | 'out' | 'system';
    content: string;
    timestamp: string;
  }>;
}

interface SessionsResponse {
  stats: { active: number; blocked: number; paused: number; total: number };
  sessions: Session[];
}

function formatRelativeTime(date: string): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function isBlocked(session: Session): boolean {
  return session.currentPhase?.startsWith('blocked') ?? false;
}

function isGenerating(session: Session): boolean {
  return session.currentPhase === 'runtime:generating';
}

function isRuntimeIdle(session: Session): boolean {
  return session.currentPhase === 'runtime:idle';
}

function formatPhaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  if (!phase.startsWith('runtime:')) return phase;
  const runtimeState = phase.replace('runtime:', '');
  return `Runtime: ${runtimeState}`;
}

function getSessionState(session: Session): {
  label: string;
  cardClass: string;
  badgeClass: string;
  phaseClass: string;
} {
  if (isBlocked(session)) {
    return {
      label: 'Blocked',
      cardClass: 'border-amber-300 bg-amber-50/50',
      badgeClass: 'bg-amber-100 text-amber-700',
      phaseClass: 'font-medium text-amber-700',
    };
  }

  if (session.status === 'paused') {
    return {
      label: 'Paused',
      cardClass: 'border-gray-200',
      badgeClass: 'bg-gray-100 text-gray-600',
      phaseClass: 'text-gray-600',
    };
  }

  if (isGenerating(session)) {
    return {
      label: 'Generating',
      cardClass: 'border-blue-200 bg-blue-50/50',
      badgeClass: 'bg-blue-100 text-blue-700',
      phaseClass: 'font-medium text-blue-700',
    };
  }

  if (isRuntimeIdle(session)) {
    return {
      label: 'Idle',
      cardClass: 'border-green-200 bg-green-50/50',
      badgeClass: 'bg-green-100 text-green-700',
      phaseClass: 'text-green-700',
    };
  }

  if (session.status === 'active') {
    return {
      label: 'Active',
      cardClass: 'border-green-200 bg-green-50/50',
      badgeClass: 'bg-green-100 text-green-700',
      phaseClass: 'text-gray-600',
    };
  }

  return {
    label: session.status,
    cardClass: 'border-gray-200',
    badgeClass: 'bg-gray-100 text-gray-600',
    phaseClass: 'text-gray-600',
  };
}

function SessionCard({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false);
  const state = getSessionState(session);
  const phaseLabel = formatPhaseLabel(session.currentPhase);

  return (
    <div className={clsx('rounded-lg border p-4', state.cardClass)}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900">{session.agentName}</h3>
            <Badge variant="outline" className="text-xs font-mono">
              {session.agentId}
            </Badge>
            <Badge className={clsx('text-xs', state.badgeClass)}>{state.label}</Badge>
          </div>

          {/* Phase - prominent for blocked sessions */}
          {phaseLabel && <p className={clsx('text-sm mt-1', state.phaseClass)}>{phaseLabel}</p>}

          {/* Context / Summary */}
          {session.context && (
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">
              {typeof session.context === 'string'
                ? session.context
                : JSON.stringify(session.context)}
            </p>
          )}

          {/* Workspace info */}
          {session.workspace && (
            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                {session.workspace.branch || 'no branch'}
              </span>
              {session.workspace.purpose && (
                <span className="truncate max-w-xs">{session.workspace.purpose}</span>
              )}
              {session.workspace.workType && (
                <Badge variant="outline" className="text-xs">
                  {session.workspace.workType}
                </Badge>
              )}
            </div>
          )}

          {/* Footer: messages, backend, model */}
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
            {session.messageCount != null && session.messageCount > 0 && (
              <span>{session.messageCount} messages</span>
            )}
            {session.backend && <span>{session.backend}</span>}
            {session.model && <span>{session.model}</span>}
          </div>

          {/* Preview messages */}
          {session.preview && session.preview.length > 0 ? (
            <div className="mt-3 rounded-md border border-gray-200 bg-white/70 p-2 space-y-1">
              {session.preview.map((item) => (
                <div key={item.id} className="text-xs text-gray-600">
                  <span
                    className={clsx(
                      'mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] uppercase tracking-wide',
                      item.role === 'in' && 'bg-slate-100 text-slate-600',
                      item.role === 'out' && 'bg-blue-100 text-blue-700',
                      item.role === 'system' && 'bg-amber-100 text-amber-700'
                    )}
                  >
                    {item.role}
                  </span>
                  <span className="text-gray-500">{item.content}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-gray-400">
              No cloud log preview yet. Open full log for local transcript fallback.
            </div>
          )}
        </div>
        <div className="text-right text-sm shrink-0 ml-4">
          <div className="text-xs text-gray-400">Updated</div>
          <div className="font-medium text-gray-700">{formatRelativeTime(session.updatedAt)}</div>
          <div className="text-xs text-gray-400 mt-1">
            Started {formatRelativeTime(session.startedAt)}
          </div>
        </div>
      </div>

      {/* Expand/collapse toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        <ChevronDown className={clsx('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="rounded-md bg-gray-50 p-3 text-xs space-y-3">
            <div>
              <Link
                href={`/sessions/${session.id}`}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                View full log
              </Link>
            </div>
            {/* Session IDs */}
            <div>
              <div className="flex items-center gap-1.5 font-medium text-gray-700 mb-1.5">
                <Hash className="h-3.5 w-3.5" />
                Identifiers
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-gray-500">
                <div>
                  <span className="text-gray-400">PCP Session ID: </span>
                  <code className="font-mono select-all">{session.id}</code>
                </div>
                {session.backendSessionId && (
                  <div>
                    <span className="text-gray-400">Backend Session ID: </span>
                    <code className="font-mono select-all">{session.backendSessionId}</code>
                  </div>
                )}
              </div>
            </div>

            {/* Studio details */}
            {session.workspace && (
              <div>
                <div className="flex items-center gap-1.5 font-medium text-gray-700 mb-1.5">
                  <FolderGit2 className="h-3.5 w-3.5" />
                  Studio
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-gray-500">
                  <div>
                    <span className="text-gray-400">ID: </span>
                    <code className="font-mono select-all">{session.workspace.id}</code>
                  </div>
                  <div>
                    <span className="text-gray-400">Status: </span>
                    <span>{session.workspace.status}</span>
                  </div>
                  {session.workspace.branch && (
                    <div>
                      <span className="text-gray-400">Branch: </span>
                      <code className="font-mono">{session.workspace.branch}</code>
                    </div>
                  )}
                  {session.workspace.baseBranch && (
                    <div>
                      <span className="text-gray-400">Base: </span>
                      <code className="font-mono">{session.workspace.baseBranch}</code>
                    </div>
                  )}
                  {session.workspace.purpose && (
                    <div className="sm:col-span-2">
                      <span className="text-gray-400">Purpose: </span>
                      <span>{session.workspace.purpose}</span>
                    </div>
                  )}
                  {session.workspace.workType && (
                    <div>
                      <span className="text-gray-400">Type: </span>
                      <span>{session.workspace.workType}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SessionsPage() {
  const { data, isLoading, error } = useApiQuery<SessionsResponse>(
    ['sessions'],
    '/api/admin/sessions',
    { refetchInterval: 30000 }
  );

  const stats = data?.stats ?? { active: 0, blocked: 0, paused: 0, total: 0 };
  const sessions = data?.sessions ?? [];
  const generatingCount = sessions.filter((session) => isGenerating(session)).length;
  const idleCount = sessions.filter((session) => isRuntimeIdle(session)).length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Sessions</h1>
          <p className="mt-2 text-gray-600">
            Real-time view of all active sessions and their linked studios.
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6">
        <Card>
          <CardContent className="p-4 text-center">
            <Activity className="h-5 w-5 mx-auto text-blue-600 mb-1" />
            <div className="text-2xl font-bold text-blue-600">{generatingCount}</div>
            <div className="text-xs text-gray-500">Generating</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <CircleDot className="h-5 w-5 mx-auto text-green-600 mb-1" />
            <div className="text-2xl font-bold text-green-600">{idleCount}</div>
            <div className="text-xs text-gray-500">Runtime Idle</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <AlertTriangle className="h-5 w-5 mx-auto text-amber-600 mb-1" />
            <div className="text-2xl font-bold text-amber-600">{stats.blocked}</div>
            <div className="text-xs text-gray-500">Blocked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Pause className="h-5 w-5 mx-auto text-gray-500 mb-1" />
            <div className="text-2xl font-bold text-gray-500">{stats.paused}</div>
            <div className="text-xs text-gray-500">Paused</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Monitor className="h-5 w-5 mx-auto text-gray-600 mb-1" />
            <div className="text-2xl font-bold text-gray-600">{stats.total}</div>
            <div className="text-xs text-gray-500">Total</div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions List */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>All Sessions</CardTitle>
          <CardDescription>Sorted by most recently updated</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8">
              <Monitor className="h-12 w-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No active sessions</p>
              <p className="text-sm text-gray-400 mt-1">
                Sessions will appear here when agents start working.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {sessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
