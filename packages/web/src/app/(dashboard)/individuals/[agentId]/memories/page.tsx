'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Loader2,
  Brain,
  PenLine,
  Trash2,
  Archive,
  XCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';

interface TimelineEntry {
  id: string;
  type: 'memory_created' | 'memory_updated' | 'memory_deleted' | 'log_compacted' | 'log_discarded';
  timestamp: string;
  content: string;
  salience: string;
  source?: string;
  topics?: string[];
  metadata?: Record<string, unknown>;
  version?: number;
  memoryId?: string;
  sessionId?: string;
  changeType?: string;
}

interface TimelineResponse {
  agentId: string;
  timeline: TimelineEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface IndividualsResponse {
  individuals: { agentId: string; name: string }[];
}

const typeConfig = {
  memory_created: {
    icon: Brain,
    label: 'Memory Created',
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    dotColor: 'bg-green-500',
  },
  memory_updated: {
    icon: PenLine,
    label: 'Memory Updated',
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    dotColor: 'bg-blue-500',
  },
  memory_deleted: {
    icon: Trash2,
    label: 'Memory Deleted',
    color: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    dotColor: 'bg-red-500',
  },
  log_compacted: {
    icon: Archive,
    label: 'Log Compacted',
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    dotColor: 'bg-purple-500',
  },
  log_discarded: {
    icon: XCircle,
    label: 'Log Discarded',
    color: 'text-gray-500',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    dotColor: 'bg-gray-400',
  },
};

const salienceColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-gray-100 text-gray-600',
};

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const config = typeConfig[entry.type];
  const Icon = config.icon;

  const isLongContent = entry.content.length > 200;
  const displayContent =
    expanded || !isLongContent ? entry.content : entry.content.substring(0, 200) + '...';

  return (
    <div className={clsx('relative pl-8')}>
      {/* Timeline dot */}
      <span
        className={clsx(
          'absolute left-[7px] top-6 h-[10px] w-[10px] rounded-full',
          config.dotColor
        )}
      />

      <Card className={clsx('mb-4 border', config.borderColor)}>
        <CardContent className="p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <Icon className={clsx('h-4 w-4', config.color)} />
              <span className={clsx('text-sm font-medium', config.color)}>{config.label}</span>
              {entry.version && (
                <Badge variant="outline" className="text-xs">
                  v{entry.version}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge className={clsx('text-xs', salienceColors[entry.salience])}>
                {entry.salience}
              </Badge>
              <span className="text-xs text-gray-500">
                {new Date(entry.timestamp).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className={clsx('rounded-md p-3 mt-2', config.bgColor)}>
            <div className="prose prose-sm max-w-none text-gray-800 prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-li:marker:text-gray-800">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            </div>
            {isLongContent && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 mt-2 text-xs text-gray-600 hover:text-gray-800"
              >
                {expanded ? (
                  <>
                    <ChevronDown className="h-3 w-3" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronRight className="h-3 w-3" /> Show more
                  </>
                )}
              </button>
            )}
          </div>

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {entry.source && (
              <Badge variant="outline" className="text-xs">
                {entry.source}
              </Badge>
            )}
            {entry.topics?.map((topic) => (
              <Badge key={topic} variant="secondary" className="text-xs">
                {topic}
              </Badge>
            ))}
            {entry.memoryId && entry.type !== 'memory_created' && (
              <span className="text-xs text-gray-400 font-mono">
                → {entry.memoryId.substring(0, 8)}
              </span>
            )}
            {entry.sessionId && (
              <span className="text-xs text-gray-400 font-mono">
                session: {entry.sessionId.substring(0, 8)}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MemoryTimelinePage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const [typeFilter, setTypeFilter] = React.useState<string | null>(null);
  const [salienceFilter, setSalienceFilter] = React.useState<string | null>(null);

  // Fetch individual name
  const { data: individualsData } = useApiQuery<IndividualsResponse>(
    ['individuals'],
    '/api/admin/individuals'
  );

  // Fetch timeline
  const { data, isLoading, error } = useApiQuery<TimelineResponse>(
    ['individuals', agentId, 'memories', 'timeline'],
    `/api/admin/individuals/${agentId}/memories/timeline?limit=200`
  );

  const individual = individualsData?.individuals.find((i) => i.agentId === agentId);
  const timeline = data?.timeline ?? [];

  // Apply filters
  const filteredTimeline = timeline.filter((entry) => {
    if (typeFilter && entry.type !== typeFilter) return false;
    if (salienceFilter && entry.salience !== salienceFilter) return false;
    return true;
  });

  // Group by date
  const groupedTimeline = filteredTimeline.reduce(
    (groups, entry) => {
      const date = new Date(entry.timestamp).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(entry);
      return groups;
    },
    {} as Record<string, TimelineEntry[]>
  );

  // Stats
  const stats = {
    created: timeline.filter((e) => e.type === 'memory_created').length,
    updated: timeline.filter((e) => e.type === 'memory_updated').length,
    deleted: timeline.filter((e) => e.type === 'memory_deleted').length,
    compacted: timeline.filter((e) => e.type === 'log_compacted').length,
    discarded: timeline.filter((e) => e.type === 'log_discarded').length,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading memory timeline...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-red-800">
        {error.message}
        <Link href="/individuals" className="ml-2 underline">
          Back to Individuals
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/individuals">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {individual?.name || agentId} Memory Timeline
            </h1>
            <p className="text-gray-600">{data?.total || 0} total events</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <Card
          className={clsx(
            'cursor-pointer transition-colors',
            typeFilter === 'memory_created' ? 'ring-2 ring-green-500' : 'hover:bg-green-50'
          )}
          onClick={() => setTypeFilter(typeFilter === 'memory_created' ? null : 'memory_created')}
        >
          <CardContent className="p-4 text-center">
            <Brain className="h-5 w-5 mx-auto text-green-600 mb-1" />
            <div className="text-2xl font-bold text-green-600">{stats.created}</div>
            <div className="text-xs text-gray-500">Created</div>
          </CardContent>
        </Card>
        <Card
          className={clsx(
            'cursor-pointer transition-colors',
            typeFilter === 'memory_updated' ? 'ring-2 ring-blue-500' : 'hover:bg-blue-50'
          )}
          onClick={() => setTypeFilter(typeFilter === 'memory_updated' ? null : 'memory_updated')}
        >
          <CardContent className="p-4 text-center">
            <PenLine className="h-5 w-5 mx-auto text-blue-600 mb-1" />
            <div className="text-2xl font-bold text-blue-600">{stats.updated}</div>
            <div className="text-xs text-gray-500">Updated</div>
          </CardContent>
        </Card>
        <Card
          className={clsx(
            'cursor-pointer transition-colors',
            typeFilter === 'memory_deleted' ? 'ring-2 ring-red-500' : 'hover:bg-red-50'
          )}
          onClick={() => setTypeFilter(typeFilter === 'memory_deleted' ? null : 'memory_deleted')}
        >
          <CardContent className="p-4 text-center">
            <Trash2 className="h-5 w-5 mx-auto text-red-600 mb-1" />
            <div className="text-2xl font-bold text-red-600">{stats.deleted}</div>
            <div className="text-xs text-gray-500">Deleted</div>
          </CardContent>
        </Card>
        <Card
          className={clsx(
            'cursor-pointer transition-colors',
            typeFilter === 'log_compacted' ? 'ring-2 ring-purple-500' : 'hover:bg-purple-50'
          )}
          onClick={() => setTypeFilter(typeFilter === 'log_compacted' ? null : 'log_compacted')}
        >
          <CardContent className="p-4 text-center">
            <Archive className="h-5 w-5 mx-auto text-purple-600 mb-1" />
            <div className="text-2xl font-bold text-purple-600">{stats.compacted}</div>
            <div className="text-xs text-gray-500">Compacted</div>
          </CardContent>
        </Card>
        <Card
          className={clsx(
            'cursor-pointer transition-colors',
            typeFilter === 'log_discarded' ? 'ring-2 ring-gray-500' : 'hover:bg-gray-100'
          )}
          onClick={() => setTypeFilter(typeFilter === 'log_discarded' ? null : 'log_discarded')}
        >
          <CardContent className="p-4 text-center">
            <XCircle className="h-5 w-5 mx-auto text-gray-500 mb-1" />
            <div className="text-2xl font-bold text-gray-500">{stats.discarded}</div>
            <div className="text-xs text-gray-500">Discarded</div>
          </CardContent>
        </Card>
      </div>

      {/* Salience filter */}
      <div className="flex items-center gap-2 mb-6">
        <span className="text-sm text-gray-500">Filter by salience:</span>
        {['critical', 'high', 'medium', 'low'].map((salience) => (
          <Badge
            key={salience}
            className={clsx(
              'cursor-pointer',
              salienceFilter === salience
                ? salienceColors[salience]
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            )}
            onClick={() => setSalienceFilter(salienceFilter === salience ? null : salience)}
          >
            {salience}
          </Badge>
        ))}
        {(typeFilter || salienceFilter) && (
          <button
            className="text-xs text-gray-500 underline ml-2"
            onClick={() => {
              setTypeFilter(null);
              setSalienceFilter(null);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Timeline */}
      {filteredTimeline.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500">
            {timeline.length === 0
              ? 'No memory activity yet. Memories will appear here as they are created.'
              : 'No events match the current filters.'}
          </CardContent>
        </Card>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[11px] top-0 bottom-0 w-[2px] bg-gray-200" />

          {Object.entries(groupedTimeline).map(([date, entries]) => (
            <div key={date} className="mb-8">
              <div className="relative mb-4 pl-8">
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-gray-100 border-2 border-gray-300 flex items-center justify-center">
                  <span className="h-2 w-2 rounded-full bg-gray-400" />
                </span>
                <h3 className="text-sm font-semibold text-gray-700">{date}</h3>
              </div>
              {entries.map((entry) => (
                <TimelineCard key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
