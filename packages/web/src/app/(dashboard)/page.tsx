'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  MessageSquare,
  Users,
  UsersRound,
  Key,
  Activity,
  GitBranch,
  ArrowRight,
  Monitor,
} from 'lucide-react';
import Link from 'next/link';
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

function getSessionStatusBadge(session: Session): {
  label: string;
  badgeClass: string;
  cardClass: string;
} {
  if (isBlocked(session)) {
    return {
      label: 'Blocked',
      badgeClass: 'bg-amber-100 text-amber-700',
      cardClass: 'border-amber-300 bg-amber-50/50',
    };
  }
  if (session.status === 'paused') {
    return {
      label: 'Paused',
      badgeClass: 'bg-gray-100 text-gray-600',
      cardClass: 'border-gray-200',
    };
  }
  if (isGenerating(session)) {
    return {
      label: 'Generating',
      badgeClass: 'bg-blue-100 text-blue-700',
      cardClass: 'border-blue-200 bg-blue-50/50',
    };
  }
  if (isRuntimeIdle(session)) {
    return {
      label: 'Idle',
      badgeClass: 'bg-green-100 text-green-700',
      cardClass: 'border-green-200 bg-green-50/50',
    };
  }
  if (session.status === 'active') {
    return {
      label: 'Active',
      badgeClass: 'bg-green-100 text-green-700',
      cardClass: 'border-green-200 bg-green-50/50',
    };
  }
  return {
    label: session.status,
    badgeClass: 'bg-gray-100 text-gray-600',
    cardClass: 'border-gray-200',
  };
}

function phasePreviewLabel(phase: string | null): string | null {
  if (!phase) return null;
  if (phase.startsWith('runtime:')) return phase.replace('runtime:', 'Runtime: ');
  return phase;
}

const quickLinks = [
  {
    name: 'Sessions',
    description: 'View all agent sessions and studios',
    href: '/sessions',
    icon: Activity,
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

export default function DashboardPage() {
  const { data, isLoading } = useApiQuery<SessionsResponse>(['sessions'], '/api/admin/sessions', {
    refetchInterval: 30000,
  });

  const sessions = data?.sessions ?? [];

  // Sort: blocked first, then active, then paused — then by updatedAt
  const previewSessions = [...sessions]
    .sort((a, b) => {
      const sessionPriority = (session: Session): number => {
        if (isBlocked(session)) return 0;
        if (isGenerating(session)) return 1;
        if (isRuntimeIdle(session)) return 2;
        if (session.status === 'active') return 3;
        if (session.status === 'paused') return 4;
        return 5;
      };
      const priorityDiff = sessionPriority(a) - sessionPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 4);

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Welcome to the PCP Admin Dashboard. Monitor active sessions and manage your system.
      </p>

      {/* Sessions Preview */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Active Sessions</h2>
          <Link
            href="/sessions"
            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
          >
            View all sessions
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-20 rounded-lg border border-gray-200 bg-gray-50 animate-pulse"
              />
            ))}
          </div>
        ) : previewSessions.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center">
              <Monitor className="h-8 w-8 mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-500">No active sessions</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {previewSessions.map((session) => {
              const badge = getSessionStatusBadge(session);
              const phaseLabel = phasePreviewLabel(session.currentPhase);

              return (
                <Link key={session.id} href="/sessions">
                  <div
                    className={clsx(
                      'rounded-lg border p-3 hover:shadow-md transition-shadow cursor-pointer',
                      badge.cardClass
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-gray-900 truncate">
                          {session.agentName}
                        </span>
                        <Badge className={clsx('text-xs shrink-0', badge.badgeClass)}>
                          {badge.label}
                        </Badge>
                      </div>
                      <span className="text-xs text-gray-400 shrink-0 ml-2">
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </div>
                    {phaseLabel && (
                      <p className="text-xs mt-1 truncate text-gray-500">{phaseLabel}</p>
                    )}
                    {session.workspace?.branch && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
                        <GitBranch className="h-3 w-3" />
                        <span className="truncate">{session.workspace.branch}</span>
                      </div>
                    )}
                  </div>
                </Link>
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
