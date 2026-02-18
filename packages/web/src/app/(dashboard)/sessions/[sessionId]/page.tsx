'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ChevronLeft, ChevronRight, TerminalSquare } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

interface SessionLogsResponse {
  session: {
    id: string;
    agentId: string;
    status: string;
    currentPhase: string | null;
    backend: string | null;
    backendSessionId: string | null;
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
  };
  logs: Array<{
    id: string;
    source: 'activity_stream' | 'session_logs' | 'local_transcript';
    type: string;
    role: 'in' | 'out' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  sources: {
    cloud: number;
    local: number;
  };
}

function formatDate(date: string): string {
  return new Date(date).toLocaleString();
}

export default function SessionLogsPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const queryPath = useMemo(
    () => `/api/admin/sessions/${sessionId}/logs?limit=${limit}&offset=${offset}&includeLocal=true`,
    [sessionId, limit, offset]
  );

  const { data, isLoading, error } = useApiQuery<SessionLogsResponse>(
    ['session-logs', sessionId, offset],
    queryPath,
    { refetchInterval: 15000 }
  );

  const logs = data?.logs || [];
  const pagination = data?.pagination;
  const session = data?.session;

  return (
    <div>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/sessions">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Sessions
          </Link>
        </Button>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Session Log</h1>
        {session && (
          <p className="mt-2 text-gray-600">
            <span className="font-medium">{session.agentId}</span> · {session.backend || 'unknown backend'}
            {session.backendSessionId ? ` · ${session.backendSessionId}` : ''}
          </p>
        )}
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 p-4 text-red-700">{error.message}</div>}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            Latest activity, session logs, and local transcript fallback when available.
          </CardDescription>
          {data && (
            <div className="flex flex-wrap gap-2 text-xs text-gray-500">
              <Badge variant="outline">Cloud: {data.sources.cloud}</Badge>
              <Badge variant="outline">Local: {data.sources.local}</Badge>
              <Badge variant="outline">Total: {data.pagination.total}</Badge>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-gray-500">Loading session log…</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-gray-500">No log messages found for this session.</p>
          ) : (
            <div className="space-y-3">
              {logs.map((entry) => (
                <div key={entry.id} className="rounded-md border border-gray-200 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={clsx(
                          entry.role === 'in' && 'border-slate-300 text-slate-700',
                          entry.role === 'out' && 'border-blue-300 text-blue-700',
                          entry.role === 'system' && 'border-amber-300 text-amber-700'
                        )}
                      >
                        {entry.role}
                      </Badge>
                      <Badge variant="outline">{entry.source}</Badge>
                      <span>{entry.type}</span>
                    </div>
                    <span>{formatDate(entry.timestamp)}</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm text-gray-800">
                    <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {pagination && (
            <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
              <p className="text-xs text-gray-500">
                Showing {pagination.offset + 1} -{' '}
                {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.offset === 0}
                  onClick={() => setOffset(Math.max(0, pagination.offset - pagination.limit))}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!pagination.hasMore}
                  onClick={() => setOffset(pagination.offset + pagination.limit)}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
