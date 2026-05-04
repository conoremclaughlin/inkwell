'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  Layers,
  Tag,
  ArrowUpCircle,
  Bot,
  Zap,
  Activity,
  Play,
  Pause,
  RotateCcw,
  ExternalLink,
  GitBranch,
  FolderOpen,
  Loader2,
  Radio,
  ChevronDown,
  ChevronRight,
  Target,
  Hash,
  Timer,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

// ─── Types ───

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  taskOrder: number | null;
  outcome: string | null;
  outcomeReason: string | null;
  metadata: Record<string, unknown>;
  completedAt: string | null;
  createdAt: string;
}

interface TaskGroupDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  tags: string[];
  autonomous: boolean;
  strategy: string | null;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  agentName: string | null;
  projectName: string | null;
  currentTaskIndex: number;
  strategyStartedAt: string | null;
  strategyPausedAt: string | null;
  planUri: string | null;
  contextSummary: string | null;
  taskCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MissionDetailResponse {
  group: TaskGroupDetail;
  tasks: Task[];
}

interface ActivityEvent {
  id: string;
  type: string;
  subtype: string | null;
  content: string;
  agentId: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ActivityResponse {
  events: ActivityEvent[];
}

// ─── Constants ───

const AGENT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  wren: { bg: 'bg-sky-50', text: 'text-sky-700', dot: 'bg-sky-500' },
  lumen: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  myra: { bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
  benson: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500' },
  aster: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
};

const AGENT_BADGE_COLORS: Record<string, string> = {
  wren: 'bg-sky-100 text-sky-700',
  lumen: 'bg-amber-100 text-amber-700',
  myra: 'bg-rose-100 text-rose-700',
  benson: 'bg-violet-100 text-violet-700',
  aster: 'bg-emerald-100 text-emerald-700',
};

const STATUS_CONFIG = {
  active: {
    label: 'Active',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    dot: 'bg-emerald-500',
  },
  paused: {
    label: 'Paused',
    color: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    dot: 'bg-amber-500',
  },
  completed: {
    label: 'Completed',
    color: 'text-gray-500',
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    dot: 'bg-gray-400',
  },
  draft: {
    label: 'Draft',
    color: 'text-blue-700',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    dot: 'bg-blue-500',
  },
  failed: {
    label: 'Failed',
    color: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-200',
    dot: 'bg-red-500',
  },
} as const;

const TASK_STATUS_ICON = {
  completed: CheckCircle2,
  in_progress: ArrowUpCircle,
  pending: Circle,
  blocked: AlertCircle,
} as const;

const SUBTYPE_META: Record<string, { icon: typeof Play; label: string; color: string }> = {
  strategy_started: { icon: Play, label: 'Strategy started', color: 'text-emerald-600' },
  strategy_paused: { icon: Pause, label: 'Strategy paused', color: 'text-amber-600' },
  strategy_resumed: { icon: RotateCcw, label: 'Strategy resumed', color: 'text-blue-600' },
  strategy_completed: {
    icon: CheckCircle2,
    label: 'Strategy completed',
    color: 'text-emerald-600',
  },
  task_advanced: { icon: ArrowUpCircle, label: 'Task advanced', color: 'text-indigo-600' },
  approval_required: { icon: AlertCircle, label: 'Approval required', color: 'text-amber-600' },
  approval_granted: { icon: CheckCircle2, label: 'Approval granted', color: 'text-emerald-600' },
  runner_spawned: { icon: Zap, label: 'Runner spawned', color: 'text-violet-600' },
  runner_completed: { icon: CheckCircle2, label: 'Runner completed', color: 'text-gray-500' },
  runner_crashed: { icon: AlertCircle, label: 'Runner crashed', color: 'text-red-600' },
  watchdog_wakeup: { icon: Activity, label: 'Watchdog check', color: 'text-gray-400' },
  strategy_trigger: { icon: Zap, label: 'Strategy triggered', color: 'text-indigo-500' },
};

// ─── Helpers ───

function formatRelativeTime(date: string): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  if (diffMs >= 0) {
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }
  if (mins < 60) return `in ${mins}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
}

function formatTime(date: string): string {
  return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(date: string): string {
  return new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function groupEventsByDate(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const groups = new Map<string, ActivityEvent[]>();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  for (const event of events) {
    const dateStr = new Date(event.createdAt).toDateString();
    let label: string;
    if (dateStr === today) label = 'Today';
    else if (dateStr === yesterday) label = 'Yesterday';
    else
      label = new Date(event.createdAt).toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });

    const list = groups.get(label) ?? [];
    list.push(event);
    groups.set(label, list);
  }
  return groups;
}

function computeElapsed(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

// ─── Task Progress Column ───

function TaskProgressList({ tasks, currentIndex }: { tasks: Task[]; currentIndex: number }) {
  const [showCompleted, setShowCompleted] = useState(true);
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const total = tasks.length;

  return (
    <div>
      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-gray-600">
            {completed}/{total} tasks complete
          </span>
          <span className="text-xs text-gray-400">
            {total > 0 ? Math.round((completed / total) * 100) : 0}%
          </span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-1">
        {tasks.map((task, i) => {
          const Icon = TASK_STATUS_ICON[task.status];
          const isCurrent = task.status === 'in_progress';
          const isDone = task.status === 'completed';
          const isBlocked = task.status === 'blocked';

          if (isDone && !showCompleted) return null;

          return (
            <div
              key={task.id}
              className={clsx(
                'flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors',
                isCurrent && 'bg-emerald-50 border border-emerald-200',
                isBlocked && 'bg-red-50/50',
                !isCurrent && !isBlocked && 'hover:bg-gray-50'
              )}
            >
              <Icon
                className={clsx(
                  'h-4 w-4 shrink-0',
                  isDone && 'text-gray-300',
                  isCurrent && 'text-emerald-600',
                  isBlocked && 'text-red-500',
                  !isDone && !isCurrent && !isBlocked && 'text-gray-300'
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'text-sm',
                      isDone && 'text-gray-400 line-through',
                      isCurrent && 'text-gray-900 font-medium',
                      isBlocked && 'text-red-700',
                      !isDone && !isCurrent && !isBlocked && 'text-gray-600'
                    )}
                  >
                    {task.title}
                  </span>
                  {isCurrent && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium">
                      <Radio className="h-2.5 w-2.5 animate-pulse" />
                      active
                    </span>
                  )}
                </div>
                {task.description && isCurrent && (
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{task.description}</p>
                )}
                {task.outcome && isDone && task.outcome !== 'completed' && (
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {task.outcome}
                    {task.outcomeReason ? `: ${task.outcomeReason}` : ''}
                  </p>
                )}
              </div>
              <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">
                {task.taskOrder != null ? `#${task.taskOrder + 1}` : ''}
              </span>
            </div>
          );
        })}
      </div>

      {/* Toggle completed */}
      {completed > 0 && (
        <button
          onClick={() => setShowCompleted(!showCompleted)}
          className="mt-2 text-[11px] text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
        >
          {showCompleted ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {showCompleted ? 'Hide' : 'Show'} {completed} completed
        </button>
      )}
    </div>
  );
}

// ─── Live Timeline ───

function LiveTimeline({ groupId, isActive }: { groupId: string; isActive: boolean }) {
  const { data, isLoading } = useApiQuery<ActivityResponse>(
    ['mission-timeline', groupId],
    `/api/admin/task-groups/${groupId}/activity?limit=200`,
    { refetchInterval: isActive ? 5000 : false }
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading timeline...
      </div>
    );
  }

  const events = data?.events ?? [];
  if (events.length === 0) {
    return (
      <div className="text-center py-8">
        <Activity className="h-8 w-8 mx-auto text-gray-200 mb-2" />
        <p className="text-sm text-gray-400">No activity recorded yet.</p>
        <p className="text-xs text-gray-300 mt-1">
          Events will appear here as the strategy executes.
        </p>
      </div>
    );
  }

  const dateGroups = groupEventsByDate(events);

  return (
    <div className="space-y-4">
      {/* Live indicator */}
      {isActive && (
        <div className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live — updating every 5s
        </div>
      )}

      {[...dateGroups.entries()].map(([dateLabel, dayEvents]) => (
        <div key={dateLabel}>
          {/* Date separator */}
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
              {dateLabel}
            </span>
            <div className="flex-1 h-px bg-gray-100" />
          </div>

          {/* Events */}
          <div className="relative pl-5 space-y-0">
            <div className="absolute left-[9px] top-1 bottom-1 w-px bg-gray-200" />

            {dayEvents.map((event, i) => {
              const meta = SUBTYPE_META[event.subtype ?? ''];
              const Icon = meta?.icon ?? Activity;
              const color = meta?.color ?? 'text-gray-400';
              const label = meta?.label ?? event.subtype ?? event.type;
              const isLatest =
                i === dayEvents.length - 1 && dateLabel === [...dateGroups.keys()].at(-1);
              const agentBadge = event.agentId
                ? (AGENT_BADGE_COLORS[event.agentId] ?? 'bg-gray-100 text-gray-600')
                : null;

              return (
                <div
                  key={event.id}
                  className={clsx(
                    'relative flex gap-3 items-start pb-4 group',
                    isLatest && isActive && 'animate-fade-in'
                  )}
                >
                  {/* Icon node */}
                  <div
                    className={clsx(
                      'relative z-10 rounded-full bg-white p-0.5 -ml-[13px] ring-2 ring-white',
                      isLatest && isActive && 'ring-emerald-50'
                    )}
                  >
                    <Icon className={clsx('h-3.5 w-3.5', color)} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 -mt-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-gray-700">{label}</span>
                      {agentBadge && (
                        <span
                          className={clsx(
                            'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                            agentBadge
                          )}
                        >
                          {event.agentId}
                        </span>
                      )}
                      {event.sessionId && (
                        <Link
                          href={`/sessions/${event.sessionId}`}
                          className="text-[10px] text-blue-500 hover:text-blue-700 flex items-center gap-0.5 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          session
                        </Link>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-3">{event.content}</p>
                    <span className="text-[10px] text-gray-400">{formatTime(event.createdAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ───

export default function MissionDetailPage() {
  const params = useParams();
  const groupId = params.groupId as string;

  const { data, isLoading, error } = useApiQuery<MissionDetailResponse>(
    ['mission-detail', groupId],
    `/api/admin/task-groups/${groupId}`,
    { refetchInterval: 15000 }
  );

  if (isLoading) {
    return (
      <div className="max-w-6xl">
        <Link
          href="/tasks"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Tasks
        </Link>
        <div className="flex items-center gap-3 text-gray-400 py-16 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading mission...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-6xl">
        <Link
          href="/tasks"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Tasks
        </Link>
        <div className="rounded-lg bg-red-50 border border-red-200 p-6 text-center">
          <p className="text-sm text-red-800">{error?.message ?? 'Mission not found'}</p>
        </div>
      </div>
    );
  }

  const { group, tasks } = data;
  const isActive = group.status === 'active';
  const isPaused = group.status === 'paused';
  const statusCfg =
    STATUS_CONFIG[group.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.draft;
  const ownerName = group.strategy ? group.ownerAgentName : group.agentName;
  const elapsed = computeElapsed(group.strategyStartedAt);
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const agentColors = ownerName ? (AGENT_COLORS[ownerName.toLowerCase()] ?? null) : null;

  return (
    <div className="max-w-6xl">
      {/* Navigation */}
      <Link
        href="/tasks"
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Tasks
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
            <Layers className="h-5 w-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{group.title}</h1>
              <Badge
                className={clsx(
                  'text-xs font-medium border gap-1',
                  statusCfg.bg,
                  statusCfg.color,
                  statusCfg.border
                )}
              >
                <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', statusCfg.dot)} />
                {statusCfg.label}
              </Badge>
              {group.autonomous && (
                <Badge className="text-xs font-medium border bg-violet-50 text-violet-700 border-violet-200 gap-1">
                  <Zap className="h-3 w-3" />
                  Autonomous
                </Badge>
              )}
              {group.strategy && (
                <Badge className="text-xs font-medium border bg-indigo-50 text-indigo-700 border-indigo-200 gap-1">
                  <GitBranch className="h-3 w-3" />
                  {group.strategy}
                </Badge>
              )}
            </div>

            {group.description && (
              <p className="text-sm text-gray-500 mt-1.5">{group.description}</p>
            )}

            {/* Meta row */}
            <div className="flex items-center gap-4 mt-2.5 flex-wrap">
              {ownerName && (
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <Bot className="h-3.5 w-3.5" />
                  <span
                    className={clsx(
                      'font-medium px-1.5 py-0.5 rounded-full text-[11px]',
                      agentColors
                        ? `${agentColors.bg} ${agentColors.text}`
                        : 'bg-gray-100 text-gray-600'
                    )}
                  >
                    {ownerName}
                  </span>
                </span>
              )}
              {group.projectName && (
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {group.projectName}
                </span>
              )}
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <Target className="h-3.5 w-3.5" />
                {completed}/{tasks.length} tasks
              </span>
              {elapsed && (
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <Timer className="h-3.5 w-3.5" />
                  {elapsed}
                </span>
              )}
              {group.strategyStartedAt && (
                <span className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Clock className="h-3.5 w-3.5" />
                  Started {formatDateTime(group.strategyStartedAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Task Progress (2 cols) */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border bg-white p-5 sticky top-8">
            <div className="flex items-center gap-2 mb-4">
              <Hash className="h-4 w-4 text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-700">Task Progress</h2>
            </div>
            <TaskProgressList tasks={tasks} currentIndex={group.currentTaskIndex} />
          </div>
        </div>

        {/* Right: Live Timeline (3 cols) */}
        <div className="lg:col-span-3">
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-700">Timeline</h2>
              </div>
              {isActive && (
                <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 font-medium">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
              {isPaused && (
                <span className="flex items-center gap-1.5 text-[11px] text-amber-600 font-medium">
                  <Pause className="h-3 w-3" />
                  Paused
                </span>
              )}
            </div>
            <LiveTimeline groupId={groupId} isActive={isActive} />
          </div>
        </div>
      </div>
    </div>
  );
}
