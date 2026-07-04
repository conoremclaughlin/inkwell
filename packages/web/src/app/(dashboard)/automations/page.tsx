'use client';

import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, HeartPulse, Workflow, ArrowUpRight, CalendarClock, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useApiQuery } from '@/lib/api';

// ─── Types (mirrors GET /api/admin/automations) ───

type AutomationKind = 'reminder' | 'heartbeat' | 'strategy';

interface AutomationItem {
  id: string;
  kind: AutomationKind;
  title: string;
  agentId: string | null;
  agentName: string | null;
  cadence: string;
  status: string;
  lastRunAt: string | null;
  lastRunSessionId: string | null;
  nextRunAt: string | null;
  missionGroupId: string | null;
  deliveryChannel: string | null;
}

interface AutomationsResponse {
  automations: AutomationItem[];
}

// ─── Presentation config ───

const KIND_CONFIG: Record<AutomationKind, { label: string; icon: LucideIcon; iconClass: string }> =
  {
    reminder: {
      label: 'Reminder',
      icon: Clock,
      iconClass: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    },
    heartbeat: {
      label: 'Heartbeat',
      icon: HeartPulse,
      iconClass: 'bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400',
    },
    strategy: {
      label: 'Strategy',
      icon: Workflow,
      iconClass: 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
    },
  };

function getStatusChipClass(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'paused':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    case 'completed':
    case 'cancelled':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function formatRelativeTime(date: string): string {
  const diffMs = new Date(date).getTime() - Date.now();
  const absMins = Math.round(Math.abs(diffMs) / 60000);
  const absHours = Math.round(Math.abs(diffMs) / 3600000);
  const absDays = Math.round(Math.abs(diffMs) / 86400000);

  let magnitude: string;
  if (absMins < 1) magnitude = 'now';
  else if (absMins < 60) magnitude = `${absMins}m`;
  else if (absHours < 24) magnitude = `${absHours}h`;
  else magnitude = `${absDays}d`;

  if (magnitude === 'now') return diffMs >= 0 ? 'now' : 'just now';
  return diffMs >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

// ─── Component ───

export default function AutomationsPage() {
  const { data, isLoading, error } = useApiQuery<AutomationsResponse>(
    ['automations'],
    '/api/admin/automations',
    { refetchInterval: 30000 }
  );

  const automations = data?.automations ?? [];

  return (
    <div>
      <h1 className="text-3xl font-bold text-foreground">Automations</h1>
      <p className="mt-2 text-muted-foreground">
        Everything that runs on a schedule — reminders, heartbeats, and work strategies.
      </p>

      <div className="mt-8">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-lg border border-border bg-muted/50"
              />
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-6 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">
                Failed to load automations: {error.message}
              </p>
            </CardContent>
          </Card>
        ) : automations.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <Zap className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No automations yet</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Scheduled reminders, agent heartbeats, and strategies will show up here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {automations.map((automation) => {
              const config = KIND_CONFIG[automation.kind];
              const Icon = config.icon;
              return (
                <Card key={`${automation.kind}-${automation.id}`}>
                  <CardContent className="flex items-center gap-4 p-4">
                    <div
                      className={clsx(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        config.iconClass
                      )}
                      title={config.label}
                    >
                      <Icon className="h-5 w-5" strokeWidth={1.75} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {automation.title}
                        </h3>
                        <Badge
                          className={clsx(
                            'shrink-0 text-[11px] capitalize',
                            getStatusChipClass(automation.status)
                          )}
                        >
                          {automation.status}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          {automation.cadence}
                        </span>
                        {automation.agentId && (
                          <Badge className="bg-muted text-[10px] font-medium text-muted-foreground hover:bg-muted">
                            @{automation.agentId}
                          </Badge>
                        )}
                        {automation.deliveryChannel && (
                          <span className="text-muted-foreground/70">
                            via {automation.deliveryChannel}
                          </span>
                        )}
                        {automation.nextRunAt && (
                          <span>Next run {formatRelativeTime(automation.nextRunAt)}</span>
                        )}
                        {automation.lastRunAt && (
                          <span className="text-muted-foreground/70">
                            Last run {formatRelativeTime(automation.lastRunAt)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {automation.lastRunSessionId && (
                        <Link
                          href={`/sessions/${automation.lastRunSessionId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                          Last session
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      )}
                      {automation.missionGroupId && (
                        <Link
                          href={`/missions/${automation.missionGroupId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                          Mission
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
