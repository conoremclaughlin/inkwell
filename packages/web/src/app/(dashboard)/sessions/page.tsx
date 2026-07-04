'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Activity,
  AlertTriangle,
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
  repoRoot: string | null;
  purpose: string | null;
  workType: string | null;
  status: string;
  repoName: string | null;
  worktreePath: string | null;
}

interface Session {
  id: string;
  backendSessionId: string | null;
  agentId: string;
  agentName: string;
  agentRole: string | null;
  lifecycle: string | null;
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
  studio: SessionWorkspace | null;
  preview: Array<{
    id: string;
    source: 'activity_stream' | 'session_logs' | 'local_transcript' | 'synced_transcript';
    type: string;
    role: 'in' | 'out' | 'system';
    content: string;
    timestamp: string;
  }>;
}

interface SessionsResponse {
  stats: {
    running: number;
    generating: number;
    idle: number;
    blocked: number;
    paused: number;
    total: number;
  };
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

function getLifecycle(session: Session): string {
  // Prefer lifecycle column; fall back to old runtime:* phase for backward compat
  if (session.lifecycle) return session.lifecycle;
  if (session.currentPhase === 'runtime:generating') return 'running';
  if (session.currentPhase === 'runtime:idle') return 'idle';
  return 'idle';
}

function getSessionState(session: Session): {
  label: string;
  cardClass: string;
  badgeClass: string;
  phaseClass: string;
} {
  const normalizedStatus = String(session.status || '').toLowerCase();

  if (isBlocked(session)) {
    return {
      label: 'Blocked',
      cardClass: 'border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-900/20',
      badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      phaseClass: 'font-medium text-amber-700 dark:text-amber-400',
    };
  }

  const lifecycle = getLifecycle(session);

  if (lifecycle === 'failed') {
    return {
      label: 'Failed',
      cardClass: 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-900/20',
      badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      phaseClass: 'text-red-600 dark:text-red-400',
    };
  }

  if (normalizedStatus === 'paused') {
    return {
      label: 'Paused',
      cardClass: 'border-border',
      badgeClass: 'bg-muted text-muted-foreground',
      phaseClass: 'text-muted-foreground',
    };
  }

  if (lifecycle === 'running') {
    const isGenerating = session.currentPhase === 'runtime:generating';
    return {
      label: isGenerating ? 'Generating' : 'Running',
      cardClass: 'border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-900/20',
      badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      phaseClass: 'font-medium text-blue-700 dark:text-blue-400',
    };
  }

  if (lifecycle === 'completed') {
    return {
      label: 'Completed',
      cardClass: 'border-border',
      badgeClass: 'bg-muted text-muted-foreground',
      phaseClass: 'text-muted-foreground',
    };
  }

  if (lifecycle === 'idle') {
    return {
      label: 'Idle',
      cardClass: 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/20',
      badgeClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      phaseClass: 'text-green-700 dark:text-green-400',
    };
  }

  if (
    normalizedStatus === 'resumable' ||
    normalizedStatus === 'active' ||
    normalizedStatus === 'running'
  ) {
    return {
      label: 'Running',
      cardClass: 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/20',
      badgeClass: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      phaseClass: 'text-muted-foreground',
    };
  }

  return {
    label: lifecycle || session.status || 'unknown',
    cardClass: 'border-border',
    badgeClass: 'bg-muted text-muted-foreground',
    phaseClass: 'text-muted-foreground',
  };
}

function SessionCard({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false);
  const state = getSessionState(session);
  const phaseLabel = session.currentPhase;
  const repoName = session.studio?.repoName;

  return (
    <div className={clsx('rounded-lg border p-4', state.cardClass)}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">{session.agentName}</h3>
            <Badge variant="outline" className="text-xs font-mono">
              {session.agentId}
            </Badge>
            <Badge className={clsx('text-xs', state.badgeClass)}>{state.label}</Badge>
          </div>

          {/* Phase - prominent for blocked sessions */}
          {phaseLabel && <p className={clsx('text-sm mt-1', state.phaseClass)}>{phaseLabel}</p>}

          {/* Context / Summary */}
          {session.context && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {typeof session.context === 'string'
                ? session.context
                : JSON.stringify(session.context)}
            </p>
          )}

          {/* Workspace info */}
          {session.studio && (
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              {repoName && (
                <span
                  className="flex items-center gap-1"
                  title={session.studio.repoRoot || undefined}
                >
                  <FolderGit2 className="h-3 w-3" />
                  {repoName}
                </span>
              )}
              <span className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                {session.studio.branch || 'no branch'}
              </span>
              {session.studio.purpose && (
                <span className="truncate max-w-xs">{session.studio.purpose}</span>
              )}
              {session.studio.workType && (
                <Badge variant="outline" className="text-xs">
                  {session.studio.workType}
                </Badge>
              )}
            </div>
          )}

          {/* Footer: messages, backend, model */}
          <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground/70">
            {session.messageCount != null && session.messageCount > 0 && (
              <span>{session.messageCount} messages</span>
            )}
            {session.backend && <span>{session.backend}</span>}
            {session.model && <span>{session.model}</span>}
          </div>

          {/* Preview messages */}
          {session.preview && session.preview.length > 0 ? (
            <div className="mt-3 rounded-md border border-border bg-card/70 p-2 space-y-1">
              {session.preview.map((item) => (
                <div key={item.id} className="text-xs text-muted-foreground">
                  <span
                    className={clsx(
                      'mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] uppercase tracking-wide',
                      item.role === 'in' &&
                        'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400',
                      item.role === 'out' &&
                        'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                      item.role === 'system' &&
                        'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    )}
                  >
                    {item.role}
                  </span>
                  <span className="text-muted-foreground">{item.content}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-muted-foreground/70">
              No cloud log preview yet. Open full log for local transcript fallback.
            </div>
          )}
        </div>
        <div className="text-right text-sm shrink-0 ml-4">
          <div className="text-xs text-muted-foreground/70">Updated</div>
          <div className="font-medium text-foreground/90">
            {formatRelativeTime(session.updatedAt)}
          </div>
          <div className="text-xs text-muted-foreground/70 mt-1">
            Started {formatRelativeTime(session.startedAt)}
          </div>
        </div>
      </div>

      {/* Expand/collapse toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 mt-3 text-xs text-muted-foreground/70 hover:text-foreground/90 transition-colors"
      >
        <ChevronDown className={clsx('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="rounded-md bg-muted/50 p-3 text-xs space-y-3">
            <div>
              <Link
                href={`/sessions/${session.id}`}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs font-medium text-foreground/90 hover:bg-muted"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                View full log
              </Link>
            </div>
            {/* Session IDs */}
            <div>
              <div className="flex items-center gap-1.5 font-medium text-foreground/90 mb-1.5">
                <Hash className="h-3.5 w-3.5" />
                Identifiers
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-muted-foreground">
                <div>
                  <span className="text-muted-foreground/70">PCP Session ID: </span>
                  <code className="font-mono select-all">{session.id}</code>
                </div>
                {session.backendSessionId && (
                  <div>
                    <span className="text-muted-foreground/70">Backend Session ID: </span>
                    <code className="font-mono select-all">{session.backendSessionId}</code>
                  </div>
                )}
              </div>
            </div>

            {/* Studio details */}
            {session.studio && (
              <div>
                <div className="flex items-center gap-1.5 font-medium text-foreground/90 mb-1.5">
                  <FolderGit2 className="h-3.5 w-3.5" />
                  Studio
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-muted-foreground">
                  <div>
                    <span className="text-muted-foreground/70">ID: </span>
                    <code className="font-mono select-all">{session.studio.id}</code>
                  </div>
                  <div>
                    <span className="text-muted-foreground/70">Status: </span>
                    <span>{session.studio.status}</span>
                  </div>
                  {session.studio.repoName && (
                    <div>
                      <span className="text-muted-foreground/70">Repo: </span>
                      <code className="font-mono">{session.studio.repoName}</code>
                    </div>
                  )}
                  {session.studio.branch && (
                    <div>
                      <span className="text-muted-foreground/70">Branch: </span>
                      <code className="font-mono">{session.studio.branch}</code>
                    </div>
                  )}
                  {session.studio.worktreePath && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground/70">Path: </span>
                      <code className="font-mono break-all">{session.studio.worktreePath}</code>
                    </div>
                  )}
                  {session.studio.baseBranch && (
                    <div>
                      <span className="text-muted-foreground/70">Base: </span>
                      <code className="font-mono">{session.studio.baseBranch}</code>
                    </div>
                  )}
                  {session.studio.repoRoot && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground/70">Repo root: </span>
                      <code className="font-mono break-all">{session.studio.repoRoot}</code>
                    </div>
                  )}
                  {session.studio.purpose && (
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground/70">Purpose: </span>
                      <span>{session.studio.purpose}</span>
                    </div>
                  )}
                  {session.studio.workType && (
                    <div>
                      <span className="text-muted-foreground/70">Type: </span>
                      <span>{session.studio.workType}</span>
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

  const stats = data?.stats ?? {
    running: 0,
    generating: 0,
    idle: 0,
    blocked: 0,
    paused: 0,
    total: 0,
  };
  const sessions = data?.sessions ?? [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Sessions</h1>
          <p className="mt-2 text-muted-foreground">
            Real-time view of all active sessions and their linked studios.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error.message}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6">
        <Card>
          <CardContent className="p-4 text-center">
            <Activity className="h-5 w-5 mx-auto text-green-700 dark:text-green-400 mb-1" />
            <div className="text-2xl font-bold text-green-700 dark:text-green-400">
              {stats.running}
            </div>
            <div className="text-xs text-muted-foreground">Running</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Activity className="h-5 w-5 mx-auto text-blue-600 dark:text-blue-400 mb-1" />
            <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {stats.generating}
            </div>
            <div className="text-xs text-muted-foreground">Generating</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <CircleDot className="h-5 w-5 mx-auto text-green-600 dark:text-green-400 mb-1" />
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {stats.idle}
            </div>
            <div className="text-xs text-muted-foreground">Runtime Idle</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <AlertTriangle className="h-5 w-5 mx-auto text-amber-600 dark:text-amber-400 mb-1" />
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {stats.blocked}
            </div>
            <div className="text-xs text-muted-foreground">Blocked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Monitor className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
            <div className="text-2xl font-bold text-muted-foreground">{stats.total}</div>
            <div className="text-xs text-muted-foreground">Total</div>
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
            <p className="text-muted-foreground">Loading...</p>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8">
              <Monitor className="h-12 w-12 mx-auto text-muted-foreground/70 mb-3" />
              <p className="text-muted-foreground">No active sessions</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
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
