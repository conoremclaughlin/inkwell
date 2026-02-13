'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell, Clock, CheckCircle, XCircle, PauseCircle } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

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
}

interface RemindersResponse {
  reminders: Reminder[];
}

const statusConfig = {
  active: {
    icon: Bell,
    label: 'Active',
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  paused: {
    icon: PauseCircle,
    label: 'Paused',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-100',
  },
  completed: {
    icon: CheckCircle,
    label: 'Completed',
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  cancelled: {
    icon: XCircle,
    label: 'Cancelled',
    color: 'text-gray-500',
    bgColor: 'bg-gray-100',
  },
};

const channelLabels: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  email: 'Email',
  push: 'Push',
};

function formatCron(cron: string | null): string {
  if (!cron) return 'No schedule';

  // Simple cron formatting - could be enhanced with a library like cronstrue
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute === '0' && hour === '9') return 'Daily at 9:00 AM';
    if (minute === '0' && hour === '8') return 'Daily at 8:00 AM';
    if (minute === '0') return `Daily at ${hour}:00`;
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${hour}:${minute.padStart(2, '0')}`;
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '0') {
    return `Sundays at ${hour}:${minute.padStart(2, '0')}`;
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1') {
    return `Mondays at ${hour}:${minute.padStart(2, '0')}`;
  }

  return cron;
}

function formatRelativeTime(date: string): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  if (diffMs < 0) {
    // Past
    if (diffMins > -60) return `${Math.abs(diffMins)} min ago`;
    if (diffHours > -24) return `${Math.abs(diffHours)} hours ago`;
    return `${Math.abs(diffDays)} days ago`;
  } else {
    // Future
    if (diffMins < 60) return `in ${diffMins} min`;
    if (diffHours < 24) return `in ${diffHours} hours`;
    return `in ${diffDays} days`;
  }
}

export default function RemindersPage() {
  const { data, isLoading, error } = useApiQuery<RemindersResponse>(
    ['reminders'],
    '/api/admin/reminders'
  );

  const reminders = data?.reminders ?? [];

  // Stats
  const stats = {
    active: reminders.filter((r) => r.status === 'active').length,
    paused: reminders.filter((r) => r.status === 'paused').length,
    completed: reminders.filter((r) => r.status === 'completed').length,
    total: reminders.length,
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reminders</h1>
          <p className="mt-2 text-gray-600">View scheduled reminders across all users.</p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mt-6">
        <Card>
          <CardContent className="p-4 text-center">
            <Bell className="h-5 w-5 mx-auto text-green-600 mb-1" />
            <div className="text-2xl font-bold text-green-600">{stats.active}</div>
            <div className="text-xs text-gray-500">Active</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <PauseCircle className="h-5 w-5 mx-auto text-yellow-600 mb-1" />
            <div className="text-2xl font-bold text-yellow-600">{stats.paused}</div>
            <div className="text-xs text-gray-500">Paused</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <CheckCircle className="h-5 w-5 mx-auto text-blue-600 mb-1" />
            <div className="text-2xl font-bold text-blue-600">{stats.completed}</div>
            <div className="text-xs text-gray-500">Completed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Clock className="h-5 w-5 mx-auto text-gray-600 mb-1" />
            <div className="text-2xl font-bold text-gray-600">{stats.total}</div>
            <div className="text-xs text-gray-500">Total</div>
          </CardContent>
        </Card>
      </div>

      {/* Reminders List */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>All Reminders</CardTitle>
          <CardDescription>Sorted by next scheduled run time</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : reminders.length === 0 ? (
            <div className="text-center py-8">
              <Bell className="h-12 w-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No reminders scheduled yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Use the <code className="bg-gray-100 px-1 rounded">create_reminder</code> tool to
                schedule one.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {reminders.map((reminder) => {
                const config = statusConfig[reminder.status] || statusConfig.active;
                const StatusIcon = config.icon;

                return (
                  <div
                    key={reminder.id}
                    className={clsx(
                      'rounded-lg border p-4',
                      reminder.status === 'active'
                        ? 'border-green-200 bg-green-50/50'
                        : 'border-gray-200'
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-gray-900">{reminder.title}</h3>
                          <Badge className={clsx('text-xs', config.bgColor, config.color)}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {config.label}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            {channelLabels[reminder.deliveryChannel] || reminder.deliveryChannel}
                          </Badge>
                        </div>
                        {reminder.description && (
                          <p className="text-sm text-gray-600 mt-1">{reminder.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatCron(reminder.cronExpression)}
                          </span>
                          {reminder.runCount > 0 && (
                            <span>
                              Ran {reminder.runCount} time{reminder.runCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        {reminder.nextRunAt && reminder.status === 'active' && (
                          <div>
                            <div className="text-gray-500">Next run</div>
                            <div className="font-medium text-gray-900">
                              {formatRelativeTime(reminder.nextRunAt)}
                            </div>
                            <div className="text-xs text-gray-400">
                              {new Date(reminder.nextRunAt).toLocaleString()}
                            </div>
                          </div>
                        )}
                        {reminder.lastRunAt && (
                          <div className="mt-2">
                            <div className="text-xs text-gray-400">
                              Last: {formatRelativeTime(reminder.lastRunAt)}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
