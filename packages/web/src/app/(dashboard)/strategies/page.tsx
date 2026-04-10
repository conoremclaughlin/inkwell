'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ArrowUpCircle,
  Bot,
  Zap,
  Pause,
  Play,
  Eye,
  Shield,
  Loader2,
} from 'lucide-react';
import { useApiQuery, useApiPostDynamic, useQueryClient } from '@/lib/api';
import clsx from 'clsx';

interface StrategyTask {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: string;
  taskOrder: number | null;
  tags: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WatchdogEntry {
  id: string;
  content: string;
  status: string;
  fireAt: string;
  createdAt: string;
  action: string | null;
}

interface Strategy {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  strategy: string;
  strategyConfig: Record<string, unknown>;
  verificationMode: string;
  planUri: string | null;
  currentTaskIndex: number;
  iterationsSinceApproval: number;
  strategyStartedAt: string | null;
  strategyPausedAt: string | null;
  ownerAgentId: string | null;
  agentId: string | null;
  agentName: string | null;
  projectName: string | null;
  contextSummary: string | null;
  elapsedMs: number | null;
  progress: {
    total: number;
    completed: number;
    pending: number;
    inProgress: number;
    blocked: number;
    completionRate: number;
  };
  tasks: StrategyTask[];
  watchdog: WatchdogEntry[];
  createdAt: string;
  updatedAt: string;
}

interface StrategiesResponse {
  strategies: Strategy[];
}
type StatusFilter = 'all' | 'active' | 'completed';

const strategyStatusConfig = {
  active: {
    label: 'Active',
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-300',
    dotColor: 'bg-emerald-500',
  },
  paused: {
    label: 'Paused',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-300',
    dotColor: 'bg-amber-500',
  },
  completed: {
    label: 'Complete',
    color: 'text-gray-500',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-300',
    dotColor: 'bg-gray-400',
  },
  cancelled: {
    label: 'Cancelled',
    color: 'text-red-500',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-300',
    dotColor: 'bg-red-400',
  },
} as const;

const taskStatusConfig = {
  in_progress: {
    icon: ArrowUpCircle,
    label: 'In Progress',
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
  },
  pending: { icon: Circle, label: 'Pending', color: 'text-blue-500', bgColor: 'bg-blue-50' },
  blocked: { icon: AlertCircle, label: 'Blocked', color: 'text-red-500', bgColor: 'bg-red-50' },
  completed: {
    icon: CheckCircle2,
    label: 'Completed',
    color: 'text-gray-400',
    bgColor: 'bg-gray-50',
  },
} as const;

const AGENT_COLORS: Record<string, string> = {
  wren: 'bg-sky-100 text-sky-700 border-sky-200',
  lumen: 'bg-amber-100 text-amber-700 border-amber-200',
  myra: 'bg-rose-100 text-rose-700 border-rose-200',
  benson: 'bg-violet-100 text-violet-700 border-violet-200',
  aster: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

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

function formatDateTime(date: string): string {
  return new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ProgressBar({ progress }: { progress: Strategy['progress'] }) {
  const { total, completed, inProgress, blocked } = progress;
  if (total === 0) return <div className="h-2 bg-gray-100 rounded-full" />;
  const completedPct = (completed / total) * 100;
  const inProgressPct = (inProgress / total) * 100;
  const blockedPct = (blocked / total) * 100;
  return (
    <div className="h-2 bg-gray-100 rounded-full overflow-hidden flex">
      {completedPct > 0 && (
        <div
          className="bg-emerald-500 transition-all duration-500"
          style={{ width: `${completedPct}%` }}
        />
      )}
      {inProgressPct > 0 && (
        <div
          className="bg-sky-400 transition-all duration-500"
          style={{ width: `${inProgressPct}%` }}
        />
      )}
      {blockedPct > 0 && (
        <div
          className="bg-red-400 transition-all duration-500"
          style={{ width: `${blockedPct}%` }}
        />
      )}
    </div>
  );
}

function TaskRow({ task, index }: { task: StrategyTask; index: number }) {
  const config = taskStatusConfig[task.status] || taskStatusConfig.pending;
  const StatusIcon = config.icon;
  return (
    <div
      className={clsx(
        'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
        task.status === 'completed' ? 'opacity-60' : '',
        task.status === 'in_progress' ? 'bg-emerald-50/50' : 'hover:bg-gray-50'
      )}
    >
      <span className="text-xs text-gray-400 w-5 text-right font-mono">{index + 1}</span>
      <StatusIcon className={clsx('w-4 h-4 flex-shrink-0', config.color)} />
      <span
        className={clsx(
          'flex-1 text-sm',
          task.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-700'
        )}
      >
        {task.title}
      </span>
      <Badge
        variant="outline"
        className={clsx('text-xs', config.color, config.bgColor, 'border-transparent')}
      >
        {config.label}
      </Badge>
      {task.completedAt && (
        <span className="text-xs text-gray-400">{formatRelativeTime(task.completedAt)}</span>
      )}
    </div>
  );
}

function WatchdogSection({ entries }: { entries: WatchdogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) {
    return (
      <div className="text-xs text-gray-400 px-1">
        <Eye className="w-3 h-3 inline mr-1" />
        No watchdog events
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <Eye className="w-3 h-3" />
        <span>
          Watchdog: {entries.length} event{entries.length !== 1 ? 's' : ''}
        </span>
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 pl-4 border-l-2 border-gray-200">
          {entries.map((e) => (
            <div key={e.id} className="text-xs text-gray-500">
              <span className="text-gray-400">{formatDateTime(e.fireAt)}</span>
              {' \u2014 '}
              <span>{e.content}</span>
              {e.status !== 'fired' && (
                <Badge variant="outline" className="ml-1 text-xs py-0 px-1">
                  {e.status}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StrategyCard({ strategy }: { strategy: Strategy }) {
  const [expanded, setExpanded] = useState(strategy.status === 'active');
  const queryClient = useQueryClient();
  const actionMutation = useApiPostDynamic<{ success: boolean }, { action: string }>(
    () => `/api/admin/strategies/${strategy.id}/action`,
    ({ action }) => ({ action }),
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['strategies'] });
      },
    }
  );
  const statusCfg = strategyStatusConfig[strategy.status] || strategyStatusConfig.active;
  const agentColor = strategy.ownerAgentId
    ? AGENT_COLORS[strategy.ownerAgentId] || 'bg-gray-100 text-gray-600 border-gray-200'
    : '';
  const configSummary: string[] = [];
  const cfg = strategy.strategyConfig;
  if (cfg.checkInInterval) configSummary.push(`check-in every ${cfg.checkInInterval} tasks`);
  if (cfg.checkInNotify) configSummary.push(`notify ${cfg.checkInNotify}`);
  if (cfg.maxIterationsWithoutApproval)
    configSummary.push(`approval gate at ${cfg.maxIterationsWithoutApproval}`);
  if (cfg.verificationGates)
    configSummary.push(`gates: ${(cfg.verificationGates as string[]).join(', ')}`);

  return (
    <Card className={clsx('overflow-hidden transition-all', statusCfg.borderColor)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-gray-50/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium text-gray-900 text-sm truncate">{strategy.title}</h3>
              <Badge
                variant="outline"
                className={clsx(
                  'text-xs',
                  statusCfg.color,
                  statusCfg.bgColor,
                  'border-transparent'
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full mr-1', statusCfg.dotColor)} />
                {statusCfg.label}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <Zap className="w-3 h-3" />
                {strategy.strategy}
              </span>
              {strategy.ownerAgentId && (
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border',
                    agentColor
                  )}
                >
                  <Bot className="w-3 h-3" />
                  {strategy.ownerAgentId}
                </span>
              )}
              <span>
                {strategy.progress.completed}/{strategy.progress.total} tasks
                {strategy.progress.completionRate > 0 && ` (${strategy.progress.completionRate}%)`}
              </span>
              {strategy.elapsedMs !== null && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatDuration(strategy.elapsedMs)}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 ml-7">
          <ProgressBar progress={strategy.progress} />
        </div>
      </button>
      {expanded && (
        <CardContent className="px-4 pb-4 pt-0">
          <div className="ml-7 space-y-4">
            <div className="flex flex-wrap gap-4 text-xs text-gray-500">
              {strategy.strategyStartedAt && (
                <span>Started: {formatDateTime(strategy.strategyStartedAt)}</span>
              )}
              {strategy.strategyPausedAt && (
                <span>Paused: {formatDateTime(strategy.strategyPausedAt)}</span>
              )}
              {strategy.verificationMode !== 'self' && (
                <span className="inline-flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  Verification: {strategy.verificationMode}
                </span>
              )}
              {strategy.planUri && (
                <span className="font-mono text-gray-400">{strategy.planUri}</span>
              )}
            </div>
            {configSummary.length > 0 && (
              <div className="text-xs text-gray-400">Config: {configSummary.join(' \u00b7 ')}</div>
            )}
            <div className="space-y-0.5">
              {strategy.tasks.map((task, i) => (
                <TaskRow key={task.id} task={task} index={i} />
              ))}
              {strategy.tasks.length === 0 && (
                <div className="text-sm text-gray-400 py-2">No tasks in this strategy</div>
              )}
            </div>
            <WatchdogSection entries={strategy.watchdog} />
            {strategy.contextSummary && (
              <div className="text-xs text-gray-400 bg-gray-50 rounded p-2 font-mono">
                {strategy.contextSummary}
              </div>
            )}
            {(strategy.status === 'active' || strategy.status === 'paused') && (
              <div className="flex gap-2 pt-1">
                {strategy.status === 'active' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actionMutation.mutate({ action: 'pause' });
                    }}
                    disabled={actionMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition-colors disabled:opacity-50"
                  >
                    {actionMutation.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Pause className="w-3 h-3" />
                    )}
                    Pause
                  </button>
                )}
                {strategy.status === 'paused' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actionMutation.mutate({ action: 'resume' });
                    }}
                    disabled={actionMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 transition-colors disabled:opacity-50"
                  >
                    {actionMutation.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    Resume
                  </button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function StrategiesPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { data, isLoading, error } = useApiQuery<StrategiesResponse>(
    ['strategies'],
    '/api/admin/strategies',
    { refetchInterval: 15000 }
  );
  const strategies = useMemo(() => {
    if (!data?.strategies) return [];
    if (statusFilter === 'all') return data.strategies;
    if (statusFilter === 'active')
      return data.strategies.filter((s) => s.status === 'active' || s.status === 'paused');
    return data.strategies.filter((s) => s.status === 'completed' || s.status === 'cancelled');
  }, [data, statusFilter]);
  const counts = useMemo(() => {
    const all = data?.strategies || [];
    return {
      total: all.length,
      active: all.filter((s) => s.status === 'active' || s.status === 'paused').length,
      completed: all.filter((s) => s.status === 'completed' || s.status === 'cancelled').length,
    };
  }, [data]);

  if (error) {
    return (
      <div className="p-6">
        <div className="text-red-600 bg-red-50 border border-red-200 rounded-lg p-4">
          Failed to load strategies: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            Strategies
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Work strategy execution and monitoring</p>
        </div>
        {!isLoading && counts.total > 0 && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-emerald-600 font-medium">{counts.active} active</span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-500">{counts.completed} done</span>
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-4">
        {[
          { key: 'all' as StatusFilter, label: 'All', count: counts.total },
          { key: 'active' as StatusFilter, label: 'Active', count: counts.active },
          { key: 'completed' as StatusFilter, label: 'Completed', count: counts.completed },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={clsx(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
              statusFilter === key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
            )}
          >
            {label}
            {count > 0 && (
              <span
                className={clsx(
                  'ml-1.5 px-1.5 py-0.5 rounded-full text-xs',
                  statusFilter === key ? 'bg-gray-700' : 'bg-gray-200'
                )}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : strategies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Zap className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              {counts.total === 0
                ? 'No strategies yet. Start one with start_strategy via MCP.'
                : 'No strategies match this filter.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {strategies.map((strategy) => (
            <StrategyCard key={strategy.id} strategy={strategy} />
          ))}
        </div>
      )}
    </div>
  );
}
