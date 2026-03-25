'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Braces, ChevronLeft, ChevronRight, TerminalSquare, Wrench } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApiPost, useApiQuery, useQueryClient } from '@/lib/api';
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
    source: 'activity_stream' | 'session_logs' | 'local_transcript' | 'synced_transcript';
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
    synced: number;
    local: number;
  };
}

function formatDate(date: string): string {
  return new Date(date).toLocaleString();
}

function isGenerating(phase: string | null): boolean {
  return phase === 'runtime:generating';
}

function isRuntimeIdle(phase: string | null): boolean {
  return phase === 'runtime:idle';
}

function isBlocked(phase: string | null): boolean {
  return phase?.startsWith('blocked') ?? false;
}

function sessionStatusBadge(
  status: string,
  phase: string | null
): { label: string; className: string } {
  const normalizedStatus = String(status || '').toLowerCase();
  if (isBlocked(phase)) return { label: 'Blocked', className: 'bg-amber-100 text-amber-700' };
  if (normalizedStatus === 'paused')
    return { label: 'Paused', className: 'bg-gray-100 text-gray-600' };
  if (isGenerating(phase)) return { label: 'Generating', className: 'bg-blue-100 text-blue-700' };
  if (isRuntimeIdle(phase)) return { label: 'Idle', className: 'bg-green-100 text-green-700' };
  if (normalizedStatus === 'resumable')
    return { label: 'Resumable', className: 'bg-violet-100 text-violet-700' };
  if (normalizedStatus === 'idle')
    return { label: 'Idle', className: 'bg-green-100 text-green-700' };
  if (normalizedStatus === 'active' || normalizedStatus === 'running')
    return { label: 'Running', className: 'bg-green-100 text-green-700' };
  return { label: status || 'unknown', className: 'bg-gray-100 text-gray-600' };
}

function formatPhaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  if (!phase.startsWith('runtime:')) return phase;
  return `Runtime: ${phase.replace('runtime:', '')}`;
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function decodePossiblyDoubleEncodedJson(input: string): unknown | null {
  const first = safeJsonParse(input);
  if (first === null) return null;
  if (typeof first === 'string') {
    const second = safeJsonParse(first);
    return second ?? first;
  }
  return first;
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeObject(input: Record<string, unknown>): string {
  if (input.type === 'tool_use') {
    const toolName = typeof input.name === 'string' ? input.name : 'unknown_tool';
    const toolInput =
      input.input && typeof input.input === 'object' ? stringifyCompact(input.input) : undefined;
    return toolInput ? `Tool call: ${toolName} ${toolInput}` : `Tool call: ${toolName}`;
  }

  if (input.type === 'tool_result') {
    const toolUseId =
      typeof input.tool_use_id === 'string' ? input.tool_use_id.slice(0, 8) : 'unknown';
    const result =
      input.content !== undefined ? stringifyCompact(input.content) : 'No result content';
    return `Tool result (${toolUseId}): ${result}`;
  }

  if (input.type === 'queue-operation' || typeof input.operation === 'string') {
    const operation = typeof input.operation === 'string' ? input.operation : 'operation';
    const sessionId =
      typeof input.sessionId === 'string' ? ` · session ${input.sessionId.slice(0, 8)}` : '';
    return `Queue ${operation}${sessionId}`;
  }

  // Direct text block: {type: "text", text: "..."}
  if (input.type === 'text' && typeof input.text === 'string') {
    return input.text;
  }

  if (input.type === 'assistant' || input.type === 'user') {
    const message = input.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const textBlock = content.find(
          (block) =>
            block &&
            typeof block === 'object' &&
            !Array.isArray(block) &&
            (block as Record<string, unknown>).type === 'text'
        ) as Record<string, unknown> | undefined;
        if (textBlock && typeof textBlock.text === 'string' && textBlock.text.trim()) {
          return textBlock.text;
        }
      }
    }
  }

  return stringifyCompact(input);
}

function formatEntryContent(
  rawContent: string,
  _backend: string | null | undefined
): {
  display: string;
  rawJson: string | null;
  kind: 'tool' | 'json' | 'text';
} {
  const parsed = decodePossiblyDoubleEncodedJson(rawContent);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { display: rawContent, rawJson: null, kind: 'text' };
  }

  const parsedObj = parsed as Record<string, unknown>;
  const rawJson = JSON.stringify(parsedObj, null, 2);
  const summary = summarizeObject(parsedObj);

  if (parsedObj.type === 'tool_use' || parsedObj.type === 'tool_result') {
    return { display: summary, rawJson, kind: 'tool' };
  }

  // Placeholder for future backend-specific formatting (codex/claude/gemini).
  // For now, non-tool JSON payloads share one presentation.
  return { display: summary, rawJson, kind: 'json' };
}

export default function SessionLogsPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;
  const [offset, setOffset] = useState(0);
  const [rawModal, setRawModal] = useState<{
    id: string;
    type: string;
    json: string;
  } | null>(null);
  const queryClient = useQueryClient();
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

  const syncTranscript = useApiPost<
    {
      ok: boolean;
      lineCount: number;
    },
    Record<string, never>
  >(`/api/admin/sessions/${sessionId}/sync-transcript`, {
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session-logs', sessionId] });
    },
  });

  const logs = data?.logs || [];
  const pagination = data?.pagination;
  const session = data?.session;
  const statusBadge = session ? sessionStatusBadge(session.status, session.currentPhase) : null;
  const phaseLabel = formatPhaseLabel(session?.currentPhase || null);

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
          <div className="mt-2 flex flex-wrap items-center gap-2 text-gray-600">
            <span className="font-medium">{session.agentId}</span>
            <span>·</span>
            <span>{session.backend || 'unknown backend'}</span>
            {statusBadge ? (
              <Badge className={clsx('text-xs', statusBadge.className)}>{statusBadge.label}</Badge>
            ) : null}
            {phaseLabel ? (
              <Badge variant="outline" className="text-xs">
                {phaseLabel}
              </Badge>
            ) : null}
            {session.backendSessionId ? (
              <>
                <span>·</span>
                <code className="font-mono text-xs">{session.backendSessionId}</code>
              </>
            ) : null}
          </div>
        )}
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 p-4 text-red-700">{error.message}</div>}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            Latest activity, session logs, synced transcript archive, and local fallback when
            available.
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncTranscript.mutate({})}
              disabled={syncTranscript.isPending}
            >
              {syncTranscript.isPending ? 'Syncing…' : 'Sync full transcript'}
            </Button>
            {syncTranscript.isSuccess ? (
              <span className="text-xs text-emerald-700">Synced transcript to cloud archive.</span>
            ) : null}
            {syncTranscript.error ? (
              <span className="text-xs text-red-600">{syncTranscript.error.message}</span>
            ) : null}
          </div>
          {data && (
            <div className="flex flex-wrap gap-2 text-xs text-gray-500">
              <Badge variant="outline">Cloud: {data.sources.cloud}</Badge>
              <Badge variant="outline">Synced: {data.sources.synced}</Badge>
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
                <div key={entry.id} className="rounded-md border border-gray-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500">
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
                    <span className="shrink-0">{formatDate(entry.timestamp)}</span>
                  </div>

                  {(() => {
                    const formatted = formatEntryContent(entry.content, session?.backend);
                    return (
                      <div className="space-y-2">
                        <div className="flex items-start gap-2 text-sm text-gray-800">
                          {formatted.kind === 'tool' ? (
                            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
                          ) : formatted.kind === 'json' ? (
                            <Braces className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                          ) : (
                            <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                          )}
                          <p className="whitespace-pre-wrap break-words leading-relaxed">
                            {formatted.display}
                          </p>
                        </div>
                        {formatted.rawJson ? (
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() =>
                                setRawModal({
                                  id: entry.id,
                                  type: entry.type,
                                  json: formatted.rawJson || '{}',
                                })
                              }
                            >
                              View raw JSON
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}

          <Dialog open={Boolean(rawModal)} onOpenChange={(open) => !open && setRawModal(null)}>
            <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Raw JSON</DialogTitle>
                <DialogDescription>
                  {rawModal ? `${rawModal.type} · ${rawModal.id}` : 'Session log payload'}
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-auto rounded-md border border-gray-200 bg-gray-950 p-3">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-100">
                  {rawModal?.json}
                </pre>
              </div>
            </DialogContent>
          </Dialog>

          {pagination && (
            <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
              <p className="text-xs text-gray-500">
                Showing {pagination.offset + 1} -{' '}
                {Math.min(pagination.offset + pagination.limit, pagination.total)} of{' '}
                {pagination.total}
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
