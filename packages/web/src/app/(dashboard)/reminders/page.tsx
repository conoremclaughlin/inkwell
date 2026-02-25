'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Bell,
  Clock,
  CheckCircle,
  XCircle,
  PauseCircle,
  Repeat,
  Hash,
  ChevronDown,
  ChevronRight,
  Send,
  MessageCircle,
  Mail,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';
import { getAgentGradient } from '@/lib/utils';

// ─── Types ───

interface Reminder {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  cronExpression: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  deliveryChannel: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  runCount: number;
  maxRuns: number | null;
  agentId: string | null;
  agentName: string | null;
  createdAt: string | null;
}

interface RemindersResponse {
  reminders: Reminder[];
}

type StatusFilter = 'all' | 'active' | 'paused' | 'completed';

interface SBReminderGroup {
  agentId: string | null;
  agentName: string;
  reminders: Reminder[];
  activeCount: number;
  totalCount: number;
}

// ─── Constants ───

const STATUS_ORDER: Record<string, number> = { active: 0, paused: 1, completed: 2, cancelled: 3 };

const statusConfig: Record<string, { icon: typeof Bell; label: string; color: string; bgColor: string; borderColor: string }> = {
  active: { icon: Bell, label: 'Active', color: 'text-green-700', bgColor: 'bg-green-50', borderColor: 'border-green-200' },
  paused: { icon: PauseCircle, label: 'Paused', color: 'text-amber-700', bgColor: 'bg-amber-50', borderColor: 'border-amber-200' },
  completed: { icon: CheckCircle, label: 'Completed', color: 'text-gray-500', bgColor: 'bg-gray-50', borderColor: 'border-gray-200' },
  cancelled: { icon: XCircle, label: 'Cancelled', color: 'text-gray-400', bgColor: 'bg-gray-50', borderColor: 'border-gray-200' },
};

const channelConfig: Record<string, { icon: typeof Send; label: string }> = {
  telegram: { icon: Send, label: 'Telegram' },
  whatsapp: { icon: MessageCircle, label: 'WhatsApp' },
  email: { icon: Mail, label: 'Email' },
  push: { icon: Bell, label: 'Push' },
};

// ─── Helpers ───

function formatCron(cron: string | null): string {
  if (!cron) return 'One-time';
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [minute, hour, , , dayOfWeek] = parts;
  const time = `${hour}:${minute.padStart(2, '0')}`;
  if (dayOfWeek === '*') return `Daily at ${time}`;
  if (dayOfWeek === '1-5') return `Weekdays at ${time}`;
  const days: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };
  return `${days[dayOfWeek] || dayOfWeek} at ${time}`;
}

function formatRelativeTime(date: string): string {
  const diffMs = new Date(date).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const suffix = diffMs < 0 ? ' ago' : '';
  const prefix = diffMs >= 0 ? 'in ' : '';
  if (mins < 60) return `${prefix}${mins}m${suffix}`;
  if (hours < 24) return `${prefix}${hours}h${suffix}`;
  return `${prefix}${days}d${suffix}`;
}

function sortReminders(reminders: Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => {
    const sd = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (sd !== 0) return sd;
    if (a.nextRunAt && b.nextRunAt) return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
    if (a.nextRunAt) return -1;
    if (b.nextRunAt) return 1;
    return 0;
  });
}

// ─── Sub-components ───

function ReminderCard({ reminder }: { reminder: Reminder }) {
  const config = statusConfig[reminder.status] || statusConfig.active;
  const StatusIcon = config.icon;
  const channel = channelConfig[reminder.deliveryChannel];
  const ChannelIcon = channel?.icon || Bell;
  const isRecurring = !!reminder.cronExpression;

  return (
    <div
      className={clsx(
        'rounded-lg border p-4 transition-all',
        reminder.status === 'active' && 'border-green-200 bg-green-50/30',
        reminder.status === 'paused' && 'border-amber-200 bg-amber-50/20',
        (reminder.status === 'completed' || reminder.status === 'cancelled') && 'border-gray-100 bg-gray-50/30',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-medium text-gray-900 text-sm">{reminder.title}</h4>
            <Badge className={clsx('text-[10px] font-medium border', config.bgColor, config.color, config.borderColor)}>
              <StatusIcon className="h-3 w-3 mr-0.5" />
              {config.label}
            </Badge>
            {isRecurring && (
              <Badge variant="outline" className="text-[10px] text-purple-600 border-purple-200">
                <Repeat className="h-3 w-3 mr-0.5" />
                Recurring
              </Badge>
            )}
          </div>
          {reminder.description && (
            <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">{reminder.description}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-400">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatCron(reminder.cronExpression)}
            </span>
            <span className="flex items-center gap-1">
              <ChannelIcon className="h-3 w-3" />
              {channel?.label || reminder.deliveryChannel}
            </span>
            {reminder.runCount > 0 && (
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" />
                {reminder.runCount}{reminder.maxRuns ? `/${reminder.maxRuns}` : ''} run{reminder.runCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          {reminder.nextRunAt && reminder.status === 'active' && (
            <div>
              <div className="text-sm font-medium text-gray-900">
                {formatRelativeTime(reminder.nextRunAt)}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {new Date(reminder.nextRunAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </div>
          )}
          {reminder.lastRunAt && (
            <div className="text-[10px] text-gray-400 mt-1">
              Last: {formatRelativeTime(reminder.lastRunAt)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SBSection({ group, statusFilter }: { group: SBReminderGroup; statusFilter: StatusFilter }) {
  const [collapsed, setCollapsed] = useState(group.activeCount === 0);
  const gradient = getAgentGradient(group.agentId || '__unassigned__');

  const filtered = statusFilter === 'all'
    ? group.reminders
    : group.reminders.filter((r) => r.status === statusFilter);

  if (filtered.length === 0) return null;

  const activeInGroup = group.reminders.filter((r) => r.status === 'active').length;

  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      {/* SB Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-3 w-full px-5 py-3.5 text-left hover:bg-gray-50/50 transition-colors"
      >
        {group.agentId ? (
          <div className={clsx(
            'h-9 w-9 rounded-full bg-gradient-to-br flex items-center justify-center text-white font-semibold text-sm shrink-0',
            gradient
          )}>
            {group.agentName.charAt(0).toUpperCase()}
          </div>
        ) : (
          <div className="h-9 w-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 shrink-0">
            <Bell className="h-4 w-4" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 text-sm">{group.agentName}</span>
            {group.agentId && (
              <span className="text-xs text-gray-400">@{group.agentId}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {activeInGroup > 0 && (
            <Badge className="bg-green-50 text-green-700 border border-green-200 text-[10px] hover:bg-green-50">
              {activeInGroup} active
            </Badge>
          )}
          <span className="text-xs text-gray-400">{filtered.length} reminder{filtered.length !== 1 ? 's' : ''}</span>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Reminders */}
      {!collapsed && (
        <div className="px-5 pb-4 space-y-2">
          {filtered.map((reminder) => (
            <ReminderCard key={reminder.id} reminder={reminder} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───

export default function RemindersPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, error } = useApiQuery<RemindersResponse>(
    ['reminders'],
    '/api/admin/reminders'
  );

  const allReminders = data?.reminders ?? [];

  // Group by SB, sorted with active-first
  const sbGroups = useMemo<SBReminderGroup[]>(() => {
    const groups = new Map<string, SBReminderGroup>();

    for (const r of sortReminders(allReminders)) {
      const key = r.agentId || '__unassigned__';
      if (!groups.has(key)) {
        groups.set(key, {
          agentId: r.agentId,
          agentName: r.agentName || (r.agentId ? r.agentId : 'Unassigned'),
          reminders: [],
          activeCount: 0,
          totalCount: 0,
        });
      }
      const group = groups.get(key)!;
      group.reminders.push(r);
      group.totalCount++;
      if (r.status === 'active') group.activeCount++;
    }

    // Sort groups: those with active reminders first, then alphabetically
    return [...groups.values()].sort((a, b) => {
      if (a.activeCount > 0 && b.activeCount === 0) return -1;
      if (a.activeCount === 0 && b.activeCount > 0) return 1;
      if (a.agentId === null) return 1; // Unassigned last
      if (b.agentId === null) return -1;
      return a.agentName.localeCompare(b.agentName);
    });
  }, [allReminders]);

  const stats = {
    active: allReminders.filter((r) => r.status === 'active').length,
    paused: allReminders.filter((r) => r.status === 'paused').length,
    completed: allReminders.filter((r) => r.status === 'completed').length,
    total: allReminders.length,
  };

  const filterButtons: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'active', label: 'Active', count: stats.active },
    { key: 'paused', label: 'Paused', count: stats.paused },
    { key: 'completed', label: 'Completed', count: stats.completed },
  ];

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Reminders</h1>
        <p className="mt-1 text-gray-500">Scheduled reminders and recurring check-ins, grouped by SB.</p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error.message}
        </div>
      )}

      {/* Stats row */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Active', value: stats.active, color: 'text-green-700' },
          { label: 'Paused', value: stats.paused, color: 'text-amber-600' },
          { label: 'Completed', value: stats.completed, color: 'text-gray-500' },
          { label: 'Total', value: stats.total, color: 'text-gray-900' },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">{stat.label}</div>
            <div className={clsx('text-2xl font-semibold', stat.color)}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Filter pills */}
      <div className="mt-6 flex items-center justify-between">
        <div className="flex gap-1">
          {filterButtons.map((btn) => (
            <button
              key={btn.key}
              onClick={() => setStatusFilter(btn.key)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                statusFilter === btn.key
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
            >
              {btn.label}
              {btn.count > 0 && (
                <span className={clsx(
                  'ml-1.5 tabular-nums',
                  statusFilter === btn.key ? 'text-gray-300' : 'text-gray-400'
                )}>
                  {btn.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <Link
          href="/routing"
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Manage routing
        </Link>
      </div>

      {/* SB Groups */}
      <div className="mt-4 space-y-3">
        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center text-gray-500">Loading...</CardContent>
          </Card>
        ) : sbGroups.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Bell className="h-10 w-10 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No reminders scheduled yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Use <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">create_reminder</code> to schedule one.
              </p>
            </CardContent>
          </Card>
        ) : (
          sbGroups.map((group) => (
            <SBSection key={group.agentId || '__unassigned__'} group={group} statusFilter={statusFilter} />
          ))
        )}
      </div>
    </div>
  );
}
