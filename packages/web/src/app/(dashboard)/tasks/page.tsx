'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  Layers,
  FolderOpen,
  Tag,
  ChevronDown,
  ChevronRight,
  ListTodo,
  ArrowUpCircle,
  User,
  Calendar,
  Bot,
  Zap,
  MessageCircle,
  Send,
  Loader2,
  Activity,
  Play,
  Pause,
  RotateCcw,
  ExternalLink,
  GitBranch,
} from 'lucide-react';
import { useApiQuery, useApiPost, useApiPut, useQueryClient } from '@/lib/api';
import clsx from 'clsx';

// ─── Types ───

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  projectId: string | null;
  projectName: string | null;
  taskGroupId: string | null;
  taskGroupTitle: string | null;
  blockedBy: string[] | null;
  createdBy: string | null;
  completedAt: string | null;
  dueDate: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface TasksResponse {
  tasks: Task[];
  stats: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
  };
}

interface TaskGroupData {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  tags: string[];
  autonomous: boolean;
  agentId: string | null;
  agentName: string | null;
  projectName: string | null;
  taskCount: number;
  contextSummary: string | null;
  outputTarget: string | null;
  outputStatus: string | null;
  threadKey: string | null;
  strategy: string | null;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  currentTaskIndex: number;
  strategyStartedAt: string | null;
  strategyPausedAt: string | null;
  planUri: string | null;
  createdAt: string;
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

interface TaskGroupsResponse {
  groups: TaskGroupData[];
}

interface TaskComment {
  id: string;
  taskId: string;
  parentCommentId: string | null;
  content: string;
  authorAgentId: string | null;
  authorName: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CommentsResponse {
  comments: TaskComment[];
}

type StatusFilter = 'all' | 'active' | 'completed' | 'blocked';

// ─── Constants ───

const statusConfig = {
  in_progress: {
    icon: ArrowUpCircle,
    label: 'In Progress',
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    accentColor: 'text-emerald-600',
    dotColor: 'bg-emerald-500',
  },
  pending: {
    icon: Circle,
    label: 'Pending',
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    accentColor: 'text-blue-600',
    dotColor: 'bg-blue-500',
  },
  blocked: {
    icon: AlertCircle,
    label: 'Blocked',
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    accentColor: 'text-red-600',
    dotColor: 'bg-red-500',
  },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    color: 'text-gray-500',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    accentColor: 'text-gray-400',
    dotColor: 'bg-gray-400',
  },
} as const;

const priorityConfig = {
  critical: {
    label: 'Critical',
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    dotColor: 'bg-red-500',
  },
  high: {
    label: 'High',
    color: 'text-orange-700',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    dotColor: 'bg-orange-500',
  },
  medium: {
    label: 'Medium',
    color: 'text-gray-600',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    dotColor: 'bg-gray-400',
  },
  low: {
    label: 'Low',
    color: 'text-slate-500',
    bgColor: 'bg-slate-50',
    borderColor: 'border-slate-200',
    dotColor: 'bg-slate-400',
  },
} as const;

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  blocked: 2,
  completed: 3,
};

// ─── Helpers ───

function formatRelativeTime(date: string): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  if (diffMs >= 0) {
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }
  if (mins < 60) return `in ${mins}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    // Status first
    const sd = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (sd !== 0) return sd;
    // Then priority
    const pd = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (pd !== 0) return pd;
    // Then due date
    if (a.dueDate && b.dueDate)
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function statusSummary(tasks: Task[]): { active: number; completed: number; blocked: number } {
  let active = 0,
    completed = 0,
    blocked = 0;
  for (const t of tasks) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'blocked') blocked++;
    else active++;
  }
  return { active, completed, blocked };
}

// ─── Comment Thread ───

const AGENT_COLORS: Record<string, string> = {
  wren: 'bg-sky-100 text-sky-700',
  lumen: 'bg-amber-100 text-amber-700',
  myra: 'bg-rose-100 text-rose-700',
  benson: 'bg-violet-100 text-violet-700',
  aster: 'bg-emerald-100 text-emerald-700',
};

function CommentThread({ taskId }: { taskId: string }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useApiQuery<CommentsResponse>(
    ['task-comments', taskId],
    `/api/admin/tasks/${taskId}/comments`
  );

  const addComment = useApiPost<{ comment: TaskComment }, { content: string }>(
    `/api/admin/tasks/${taskId}/comments`,
    { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] }) }
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || addComment.isPending) return;
    addComment.mutate({ content: draft.trim() });
    setDraft('');
    inputRef.current?.focus();
  };

  const comments = data?.comments ?? [];

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      {/* Comment list */}
      {isLoading ? (
        <div className="text-[11px] text-gray-400 flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading comments...
        </div>
      ) : comments.length > 0 ? (
        <div className="space-y-2 mb-3">
          {comments.map((c) => {
            const agentColor = c.authorAgentId
              ? (AGENT_COLORS[c.authorAgentId] ?? 'bg-gray-100 text-gray-600')
              : 'bg-gray-100 text-gray-600';
            return (
              <div key={c.id} className="flex gap-2">
                <div
                  className={clsx(
                    'h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5',
                    agentColor
                  )}
                >
                  {(c.authorName || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-gray-700">{c.authorName}</span>
                    <span className="text-[10px] text-gray-400">
                      {formatRelativeTime(c.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{c.content}</p>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          placeholder="Add a comment..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 text-xs rounded-lg border border-gray-200 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 placeholder:text-gray-400"
        />
        <button
          type="submit"
          disabled={!draft.trim() || addComment.isPending}
          className={clsx(
            'rounded-lg px-2.5 py-1.5 transition-colors',
            draft.trim()
              ? 'bg-gray-900 text-white hover:bg-gray-800'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          )}
        >
          {addComment.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}

// ─── Activity Timeline ───

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
};

function ActivityTimeline({ groupId }: { groupId: string }) {
  const { data, isLoading } = useApiQuery<ActivityResponse>(
    ['task-group-activity', groupId],
    `/api/admin/task-groups/${groupId}/activity`
  );

  if (isLoading) {
    return (
      <div className="text-[11px] text-gray-400 flex items-center gap-1 py-3">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading timeline...
      </div>
    );
  }

  const events = data?.events ?? [];
  if (events.length === 0) {
    return <div className="text-[11px] text-gray-400 py-3">No activity recorded yet.</div>;
  }

  return (
    <div className="relative pl-4 space-y-0">
      {/* Vertical line */}
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200" />

      {events.map((event, i) => {
        const meta = SUBTYPE_META[event.subtype ?? ''];
        const Icon = meta?.icon ?? Activity;
        const color = meta?.color ?? 'text-gray-400';
        const label = meta?.label ?? event.subtype ?? event.type;
        const isLast = i === events.length - 1;

        return (
          <div
            key={event.id}
            className={clsx('relative flex gap-3 items-start', !isLast && 'pb-3')}
          >
            {/* Dot */}
            <div className={clsx('relative z-10 rounded-full bg-white p-0.5 -ml-[11px]')}>
              <Icon className={clsx('h-3.5 w-3.5', color)} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 -mt-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-700">{label}</span>
                {event.agentId && (
                  <span
                    className={clsx(
                      'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                      AGENT_COLORS[event.agentId] ?? 'bg-gray-100 text-gray-600'
                    )}
                  >
                    {event.agentId}
                  </span>
                )}
                {event.sessionId && (
                  <Link
                    href={`/sessions/${event.sessionId}`}
                    className="text-[10px] text-blue-500 hover:text-blue-700 flex items-center gap-0.5 transition-colors"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    session log
                  </Link>
                )}
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{event.content}</p>
              <span className="text-[10px] text-gray-400">
                {formatRelativeTime(event.createdAt)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sub-components ───

function PriorityBadge({ priority }: { priority: Task['priority'] }) {
  const config = priorityConfig[priority];
  if (priority === 'medium') return null;
  return (
    <Badge
      className={clsx(
        'text-[10px] font-medium border gap-1',
        config.bgColor,
        config.color,
        config.borderColor
      )}
    >
      <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', config.dotColor)} />
      {config.label}
    </Badge>
  );
}

function StatusDot({ status }: { status: Task['status'] }) {
  return (
    <span
      className={clsx('inline-block h-1.5 w-1.5 rounded-full', statusConfig[status].dotColor)}
    />
  );
}

function TaskCard({
  task,
  onStatusChange,
  compact,
}: {
  task: Task;
  onStatusChange: (id: string, status: Task['status']) => void;
  compact?: boolean;
}) {
  const [showComments, setShowComments] = useState(false);
  const config = statusConfig[task.status];
  const StatusIcon = config.icon;
  const isDone = task.status === 'completed';
  const isOverdue = task.dueDate && !isDone && new Date(task.dueDate) < new Date();

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onStatusChange(task.id, isDone ? 'pending' : 'completed');
  };

  return (
    <div
      className={clsx(
        'rounded-lg border p-3 transition-all',
        showComments ? 'shadow-md border-gray-300' : 'hover:shadow-md hover:border-gray-300',
        task.status === 'in_progress' && 'border-emerald-200 bg-emerald-50/20',
        task.status === 'pending' && 'border-blue-100 bg-blue-50/10',
        task.status === 'blocked' && 'border-red-200 bg-red-50/20',
        task.status === 'completed' && 'border-gray-100 bg-gray-50/30'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Status toggle */}
        <button
          onClick={handleToggle}
          className={clsx(
            'mt-0.5 shrink-0 rounded-full p-0.5 transition-colors',
            task.status === 'blocked' ? 'cursor-default' : 'hover:bg-gray-100 cursor-pointer'
          )}
          title={isDone ? 'Reopen task' : task.status === 'blocked' ? 'Blocked' : 'Mark complete'}
          disabled={task.status === 'blocked'}
        >
          <StatusIcon className={clsx('h-4 w-4', config.accentColor)} />
        </button>

        <div className="flex-1 min-w-0">
          {/* Title + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <h4
              className={clsx(
                'font-medium text-sm',
                isDone ? 'text-gray-400 line-through' : 'text-gray-900'
              )}
            >
              {task.title}
            </h4>
            <PriorityBadge priority={task.priority} />
          </div>

          {/* Description */}
          {!compact && task.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</p>
          )}

          {/* Tags */}
          {task.tags.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <Tag className="h-3 w-3 text-gray-300" />
              {task.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400 flex-wrap">
            {task.createdBy && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {task.createdBy}
              </span>
            )}
            {!compact && task.projectName && (
              <span className="flex items-center gap-1">
                <FolderOpen className="h-3 w-3" />
                {task.projectName}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(task.createdAt)}
            </span>
            {task.completedAt && (
              <span className="flex items-center gap-1 text-green-500">
                <CheckCircle2 className="h-3 w-3" />
                done {formatRelativeTime(task.completedAt)}
              </span>
            )}
            {task.dueDate && (
              <span
                className={clsx(
                  'flex items-center gap-1',
                  isOverdue
                    ? 'text-red-600 font-medium'
                    : isDone
                      ? 'text-gray-400'
                      : 'text-gray-500'
                )}
              >
                <Calendar className="h-3 w-3" />
                {formatDate(task.dueDate)}
                {isOverdue && ' (overdue)'}
              </span>
            )}
            <button
              onClick={() => setShowComments(!showComments)}
              className="flex items-center gap-1 hover:text-gray-600 transition-colors cursor-pointer"
            >
              <MessageCircle className="h-3 w-3" />
              {showComments ? 'hide' : 'comment'}
            </button>
          </div>

          {/* Blocked reason */}
          {task.status === 'blocked' && task.blockedBy && task.blockedBy.length > 0 && (
            <div className="mt-1.5 text-[11px] text-red-500 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Blocked by: {task.blockedBy.join(', ')}
            </div>
          )}

          {/* Comments */}
          {showComments && <CommentThread taskId={task.id} />}
        </div>
      </div>
    </div>
  );
}

function TaskGroupSection({
  group,
  tasks,
  onStatusChange,
  defaultCollapsed,
}: {
  group: TaskGroupData;
  tasks: Task[];
  onStatusChange: (id: string, status: Task['status']) => void;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const [showTimeline, setShowTimeline] = useState(false);
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const summary = useMemo(() => statusSummary(tasks), [tasks]);
  const allDone = summary.active === 0 && summary.blocked === 0 && summary.completed > 0;

  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={clsx(
          'flex items-center gap-3 w-full px-5 py-3.5 text-left transition-colors',
          'bg-gradient-to-r from-slate-50 to-white',
          'hover:from-slate-100/60',
          'border-b',
          collapsed ? 'border-transparent' : 'border-gray-100'
        )}
      >
        <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Layers className="h-4 w-4 text-indigo-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={clsx('font-semibold text-sm', allDone ? 'text-gray-400' : 'text-gray-900')}
            >
              {group.title}
            </span>
            {group.autonomous && (
              <Badge className="text-[10px] font-medium border bg-violet-50 text-violet-700 border-violet-200 gap-1">
                <Zap className="h-2.5 w-2.5" />
                Autonomous
              </Badge>
            )}
            {group.strategy && (
              <Badge className="text-[10px] font-medium border bg-indigo-50 text-indigo-700 border-indigo-200 gap-1">
                <GitBranch className="h-2.5 w-2.5" />
                {group.strategy}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-400">
            {(group.strategy ? group.ownerAgentName : group.agentName) && (
              <span className="flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {group.strategy ? group.ownerAgentName : group.agentName}
              </span>
            )}
            {group.projectName && (
              <span className="flex items-center gap-1">
                <FolderOpen className="h-3 w-3" />
                {group.projectName}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Mini status summary */}
          {summary.active > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-blue-600 font-medium">
              <StatusDot status="pending" /> {summary.active}
            </span>
          )}
          {summary.blocked > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-red-600 font-medium">
              <StatusDot status="blocked" /> {summary.blocked}
            </span>
          )}
          {summary.completed > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gray-400 font-medium">
              <StatusDot status="completed" /> {summary.completed}
            </span>
          )}
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-gray-400 ml-1" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400 ml-1" />
          )}
        </div>
      </button>

      {/* Group description */}
      {!collapsed && group.description && (
        <div className="px-5 pt-3 pb-0">
          <p className="text-xs text-gray-500">{group.description}</p>
        </div>
      )}

      {/* Tasks */}
      {!collapsed && (
        <div className="px-5 pb-4 pt-3 space-y-2">
          {sorted.map((task) => (
            <TaskCard key={task.id} task={task} onStatusChange={onStatusChange} compact />
          ))}
        </div>
      )}

      {/* Timeline toggle + panel */}
      {!collapsed && (
        <div className="border-t border-gray-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowTimeline(!showTimeline);
            }}
            className="flex items-center gap-2 px-5 py-2.5 text-[11px] text-gray-400 hover:text-gray-600 transition-colors w-full text-left"
          >
            <Activity className="h-3 w-3" />
            {showTimeline ? 'Hide timeline' : 'Show timeline'}
          </button>
          {showTimeline && (
            <div className="px-5 pb-4">
              <ActivityTimeline groupId={group.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UngroupedStatusSection({
  status,
  tasks,
  onStatusChange,
  defaultCollapsed,
}: {
  status: Task['status'];
  tasks: Task[];
  onStatusChange: (id: string, status: Task['status']) => void;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const config = statusConfig[status];
  const StatusIcon = config.icon;
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);

  if (tasks.length === 0) return null;

  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={clsx(
          'flex items-center gap-3 w-full px-5 py-3.5 text-left transition-colors',
          'bg-gradient-to-r from-gray-50 to-white',
          'hover:from-gray-100/60',
          'border-b',
          collapsed ? 'border-transparent' : 'border-gray-100'
        )}
      >
        <div
          className={clsx(
            'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
            config.bgColor
          )}
        >
          <StatusIcon className={clsx('h-4 w-4', config.accentColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-gray-900 text-sm">{config.label}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Badge
            className={clsx(
              'text-[10px] font-medium border',
              config.bgColor,
              config.color,
              config.borderColor
            )}
          >
            {tasks.length}
          </Badge>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>
      {!collapsed && (
        <div className="px-5 pb-4 pt-3 space-y-2">
          {sorted.map((task) => (
            <TaskCard key={task.id} task={task} onStatusChange={onStatusChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───

const STATUS_DISPLAY_ORDER: Task['status'][] = ['in_progress', 'pending', 'blocked', 'completed'];

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useApiQuery<TasksResponse>(['tasks'], '/api/admin/tasks', {
    refetchInterval: 30000,
  });

  const { data: groupsData } = useApiQuery<TaskGroupsResponse>(
    ['task-groups'],
    '/api/admin/task-groups'
  );

  const updateTask = useApiPut<Task, { id: string; body: { status: Task['status'] } }>(
    ({ id }) => `/api/admin/tasks/${id}`,
    ({ body }) => body,
    { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }) }
  );

  const handleStatusChange = useCallback(
    (id: string, status: Task['status']) => {
      updateTask.mutate({ id, body: { status } });
    },
    [updateTask]
  );

  const allTasks = data?.tasks ?? [];
  const groupsMap = useMemo(() => {
    const m = new Map<string, TaskGroupData>();
    for (const g of groupsData?.groups ?? []) m.set(g.id, g);
    return m;
  }, [groupsData]);

  const stats = useMemo(() => {
    if (data?.stats) return data.stats;
    return {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      inProgress: allTasks.filter((t) => t.status === 'in_progress').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
    };
  }, [data, allTasks]);

  // Apply status filter
  const filtered = useMemo(() => {
    if (statusFilter === 'active')
      return allTasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    if (statusFilter === 'completed') return allTasks.filter((t) => t.status === 'completed');
    if (statusFilter === 'blocked') return allTasks.filter((t) => t.status === 'blocked');
    return allTasks;
  }, [allTasks, statusFilter]);

  // Split into grouped and ungrouped
  const { grouped, ungrouped } = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    const ungrouped: Task[] = [];

    for (const task of filtered) {
      if (task.taskGroupId && groupsMap.has(task.taskGroupId)) {
        const list = grouped.get(task.taskGroupId) ?? [];
        list.push(task);
        grouped.set(task.taskGroupId, list);
      } else {
        ungrouped.push(task);
      }
    }

    return { grouped, ungrouped };
  }, [filtered, groupsMap]);

  // Sort groups: active work first, then by task count
  const sortedGroupIds = useMemo(() => {
    return [...grouped.keys()].sort((a, b) => {
      const aTasks = grouped.get(a) ?? [];
      const bTasks = grouped.get(b) ?? [];
      const aActive = aTasks.filter((t) => t.status !== 'completed').length;
      const bActive = bTasks.filter((t) => t.status !== 'completed').length;
      if (aActive > 0 && bActive === 0) return -1;
      if (bActive > 0 && aActive === 0) return 1;
      return bTasks.length - aTasks.length;
    });
  }, [grouped]);

  // Group ungrouped by status
  const ungroupedByStatus = useMemo(() => {
    const groups: Record<Task['status'], Task[]> = {
      in_progress: [],
      pending: [],
      blocked: [],
      completed: [],
    };
    for (const task of ungrouped) groups[task.status].push(task);
    return groups;
  }, [ungrouped]);

  const filterButtons: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'active', label: 'Active', count: stats.pending + stats.inProgress },
    { key: 'completed', label: 'Completed', count: stats.completed },
    { key: 'blocked', label: 'Blocked', count: stats.blocked },
  ];

  const hasVisibleTasks = filtered.length > 0;

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Tasks</h1>
        <p className="mt-1 text-gray-500">Track work across projects and agents.</p>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error.message}
        </div>
      )}

      {/* Stats row */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: 'Pending',
            value: stats.pending,
            color: 'text-blue-700',
            dotColor: 'bg-blue-500',
          },
          {
            label: 'In Progress',
            value: stats.inProgress,
            color: 'text-emerald-700',
            dotColor: 'bg-emerald-500',
          },
          {
            label: 'Completed',
            value: stats.completed,
            color: 'text-gray-500',
            dotColor: 'bg-gray-400',
          },
          { label: 'Blocked', value: stats.blocked, color: 'text-red-700', dotColor: 'bg-red-500' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border bg-white p-3 transition-all hover:shadow-sm"
          >
            <div className="flex items-center gap-1.5">
              <span className={clsx('inline-block h-2 w-2 rounded-full', stat.dotColor)} />
              <span className="text-xs text-gray-500">{stat.label}</span>
            </div>
            <div className={clsx('text-2xl font-semibold mt-0.5', stat.color)}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Filter pills */}
      <div className="mt-6 flex items-center">
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
                <span
                  className={clsx(
                    'ml-1.5 tabular-nums',
                    statusFilter === btn.key ? 'text-gray-300' : 'text-gray-400'
                  )}
                >
                  {btn.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="mt-4 space-y-3">
        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center text-gray-500">Loading...</CardContent>
          </Card>
        ) : !hasVisibleTasks ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ListTodo className="h-10 w-10 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No tasks yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Use <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">create_task</code>{' '}
                to create one.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Task Groups */}
            {sortedGroupIds.map((groupId) => {
              const group = groupsMap.get(groupId)!;
              const tasks = grouped.get(groupId) ?? [];
              const allComplete = tasks.every((t) => t.status === 'completed');
              return (
                <TaskGroupSection
                  key={groupId}
                  group={group}
                  tasks={tasks}
                  onStatusChange={handleStatusChange}
                  defaultCollapsed={allComplete}
                />
              );
            })}

            {/* Ungrouped tasks by status */}
            {ungrouped.length > 0 && sortedGroupIds.length > 0 && (
              <div className="pt-2">
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2 px-1">
                  Ungrouped
                </h3>
              </div>
            )}
            {STATUS_DISPLAY_ORDER.map((status) => (
              <UngroupedStatusSection
                key={status}
                status={status}
                tasks={ungroupedByStatus[status]}
                onStatusChange={handleStatusChange}
                defaultCollapsed={status === 'completed'}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
