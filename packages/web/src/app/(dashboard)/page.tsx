'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  MessageSquare,
  Users,
  UsersRound,
  Key,
  GitBranch,
  ArrowRight,
  Monitor,
  FolderGit2,
} from 'lucide-react';
import Link from 'next/link';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';
import { getAgentGradient } from '@/lib/utils';

// ─── Types ───

interface StudioInfo {
  id: string;
  branch: string;
  baseBranch: string | null;
  purpose: string | null;
  workType: string | null;
  worktreePath: string | null;
  slug: string | null;
  status: string;
  updatedAt: string;
}

interface AgentLatestSession {
  currentPhase: string | null;
  status: string | null;
  updatedAt: string;
}

interface AgentWithStudios {
  agentId: string;
  agentName: string;
  agentRole: string | null;
  backend: string | null;
  identityId: string;
  latestSession: AgentLatestSession | null;
  studios: StudioInfo[];
}

interface StudiosResponse {
  agents: AgentWithStudios[];
}

// ─── Helpers ───

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

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function getAgentStatusBadge(
  phase: string | null,
  sessionStatus: string | null
): {
  label: string;
  badgeClass: string;
} {
  // Phase takes priority when present
  if (phase) {
    if (phase.startsWith('blocked'))
      return { label: 'Blocked', badgeClass: 'bg-amber-100 text-amber-700' };
    if (phase === 'runtime:generating')
      return { label: 'Generating', badgeClass: 'bg-blue-100 text-blue-700' };
    if (phase === 'runtime:idle')
      return { label: 'Idle', badgeClass: 'bg-green-100 text-green-700' };
    return { label: 'Active', badgeClass: 'bg-green-100 text-green-700' };
  }
  // Fall back to session status when phase is null
  if (sessionStatus === 'active' || sessionStatus === 'resumable')
    return { label: 'Active', badgeClass: 'bg-green-100 text-green-700' };
  if (sessionStatus) return { label: 'Active', badgeClass: 'bg-green-100 text-green-700' };
  return { label: 'Offline', badgeClass: 'bg-gray-100 text-gray-500' };
}

function getStudioSlug(worktreePath: string | null): string | null {
  if (!worktreePath) return null;
  // Worktree folder names follow the pattern: <repo>--<slug>
  // e.g. /path/to/personal-context-protocol--wren → "wren"
  // e.g. /path/to/personal-context-protocol--lumen--lumen-alpha → "lumen--lumen-alpha"
  const folder = worktreePath.split('/').pop() || '';
  const dashDashIdx = folder.indexOf('--');
  if (dashDashIdx === -1) return null;
  return folder.slice(dashDashIdx + 2);
}

function getStudioStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'text-green-600';
    case 'idle':
      return 'text-gray-500';
    case 'archived':
      return 'text-gray-400';
    default:
      return 'text-gray-400';
  }
}

function formatBackend(backend: string | null): string | null {
  if (!backend) return null;
  const map: Record<string, string> = {
    'claude-code': 'Claude',
    'codex-cli': 'Codex',
    gemini: 'Gemini',
  };
  return map[backend] || backend;
}

// ─── Quick Links ───

const quickLinks = [
  {
    name: 'Sessions',
    description: 'View all agent sessions',
    href: '/sessions',
    icon: Monitor,
  },
  {
    name: 'WhatsApp',
    description: 'Manage WhatsApp connection',
    href: '/whatsapp',
    icon: MessageSquare,
  },
  {
    name: 'Trusted Users',
    description: 'Add or remove trusted users',
    href: '/trusted-users',
    icon: Users,
  },
  {
    name: 'Groups',
    description: 'View and manage authorized groups',
    href: '/groups',
    icon: UsersRound,
  },
  {
    name: 'Challenge Codes',
    description: 'Generate group authorization codes',
    href: '/challenge-codes',
    icon: Key,
  },
];

// ─── Component ───

export default function DashboardPage() {
  const { data, isLoading } = useApiQuery<StudiosResponse>(['studios'], '/api/admin/studios', {
    refetchInterval: 30000,
  });

  const agents = data?.agents ?? [];

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">Monitor your SBs and their studios.</p>

      {/* SBs + Studios */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Studios</h2>
          <Link
            href="/sessions"
            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
          >
            View all sessions
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-24 rounded-lg border border-gray-200 bg-gray-50 animate-pulse"
              />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center">
              <FolderGit2 className="h-8 w-8 mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-500">No SBs configured</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {agents.map((agent) => {
              const gradient = getAgentGradient(agent.agentId);
              const status = getAgentStatusBadge(
                agent.latestSession?.currentPhase ?? null,
                agent.latestSession?.status ?? null
              );
              const backendLabel = formatBackend(agent.backend);

              return (
                <Card key={agent.agentId} className="overflow-hidden">
                  {/* Agent header */}
                  <div className="flex items-center gap-4 px-5 py-4 border-b bg-gray-50/50">
                    <div
                      className={clsx(
                        'h-10 w-10 rounded-full bg-gradient-to-br flex items-center justify-center text-white font-semibold text-sm shrink-0',
                        gradient
                      )}
                    >
                      {getInitial(agent.agentName)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-gray-900">{agent.agentName}</h3>
                        <span className="text-xs text-gray-400">@{agent.agentId}</span>
                        <Badge className={clsx('text-[11px]', status.badgeClass)}>
                          {status.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {agent.agentRole && (
                          <p className="text-sm text-gray-500 truncate">{agent.agentRole}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {backendLabel && (
                        <span className="text-xs text-gray-400">{backendLabel}</span>
                      )}
                      {agent.latestSession && (
                        <span className="text-xs text-gray-400">
                          {formatRelativeTime(agent.latestSession.updatedAt)}
                        </span>
                      )}
                      <Link
                        href={`/routing/${agent.agentId}`}
                        className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors"
                      >
                        Manage
                      </Link>
                    </div>
                  </div>

                  {/* Studios list */}
                  {agent.studios.length === 0 ? (
                    <div className="px-5 py-4 text-sm text-gray-400">No studios</div>
                  ) : (
                    <div className="divide-y">
                      {agent.studios.map((studio) => {
                        const slug = studio.slug || getStudioSlug(studio.worktreePath);
                        return (
                          <div key={studio.id} className="flex items-center gap-4 px-5 py-3">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <GitBranch
                                  className={clsx('h-4 w-4', getStudioStatusColor(studio.status))}
                                />
                                <span className="text-sm font-medium text-gray-700">
                                  {slug || studio.branch}
                                </span>
                              </div>
                              {studio.purpose && (
                                <span className="text-xs text-gray-400 truncate">
                                  {studio.purpose}
                                </span>
                              )}
                              {studio.workType && (
                                <Badge className="text-[10px] bg-gray-100 text-gray-500 border-gray-200">
                                  {studio.workType}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <Badge
                                className={clsx(
                                  'text-[11px] font-medium border',
                                  studio.status === 'active'
                                    ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-50'
                                    : studio.status === 'idle'
                                      ? 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-50'
                                      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-50'
                                )}
                              >
                                {studio.status}
                              </Badge>
                              <span className="text-xs text-gray-400">
                                {formatRelativeTime(studio.updatedAt)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
        {quickLinks.map((item) => (
          <Link key={item.name} href={item.href}>
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{item.name}</CardTitle>
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <CardDescription>{item.description}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
