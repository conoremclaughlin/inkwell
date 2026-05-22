'use client';

import { useMemo, useRef, useEffect } from 'react';
import { useApiQuery, useApiPost, useQueryClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { parseTranscript } from './transcript-parser';
import { MessageBubble } from './message-bubble';
import type { ToolResultBlock } from './types';

interface TranscriptPayload {
  version?: number;
  events?: unknown[];
}

interface ConversationResponse {
  session: {
    id: string;
    agentId: string;
    agentName: string;
    backend: string | null;
    backendSessionId: string | null;
    lifecycle: string | null;
    currentPhase: string | null;
    activeThreadKey: string | null;
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
  };
  source: 'synced' | 'local' | 'cloud' | 'none';
  backend: string;
  transcript: TranscriptPayload | null;
  totalEvents: number;
}

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
    source: string;
    type: string;
    role: 'in' | 'out' | 'system';
    content: string;
    timestamp: string;
  }>;
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  sources: { cloud: number; synced: number; local: number };
}

function phaseColor(phase: string | null, lifecycle: string | null): string {
  if (lifecycle === 'running') {
    if (phase === 'runtime:generating') return 'bg-blue-100 text-blue-700';
    return 'bg-green-100 text-green-700';
  }
  if (phase?.startsWith('blocked')) return 'bg-amber-100 text-amber-700';
  if (lifecycle === 'idle') return 'bg-green-100 text-green-700';
  return 'bg-gray-100 text-gray-600';
}

function phaseLabel(phase: string | null, lifecycle: string | null): string {
  if (lifecycle === 'running') {
    if (phase === 'runtime:generating') return 'Generating';
    return phase ?? 'Running';
  }
  if (lifecycle === 'idle') return phase ?? 'Idle';
  if (lifecycle === 'completed') return 'Completed';
  return phase ?? lifecycle ?? 'unknown';
}

import type { ConversationTurn, TextBlock } from './types';

function logsToTurns(logs: SessionLogsResponse['logs']): ConversationTurn[] {
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  return sorted
    .filter((log) => log.content?.trim())
    .map((log) => ({
      id: log.id,
      role:
        log.role === 'in'
          ? ('user' as const)
          : log.role === 'out'
            ? ('assistant' as const)
            : ('system' as const),
      timestamp: log.timestamp,
      blocks: [{ kind: 'text' as const, text: log.content } satisfies TextBlock],
    }));
}

export function ConversationViewer({ sessionId }: { sessionId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: conversationData, error: conversationError } = useApiQuery<ConversationResponse>(
    ['session-conversation', sessionId],
    `/api/admin/sessions/${sessionId}/conversation`,
    { refetchInterval: 10000, retry: false }
  );

  const useLogsEndpoint = conversationError != null;

  const { data: logsData } = useApiQuery<SessionLogsResponse>(
    ['session-logs-viewer', sessionId],
    `/api/admin/sessions/${sessionId}/logs?limit=200&offset=0&includeLocal=true`,
    { refetchInterval: 15000, enabled: useLogsEndpoint }
  );

  const syncTranscript = useApiPost<{ ok: boolean; lineCount: number }, Record<string, never>>(
    `/api/admin/sessions/${sessionId}/sync-transcript`,
    {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ['session-conversation', sessionId] });
        await queryClient.invalidateQueries({ queryKey: ['session-logs-viewer', sessionId] });
      },
    }
  );

  const { turns, source, totalEvents, session, backend } = useMemo(() => {
    if (conversationData) {
      const events = conversationData.transcript?.events ?? [];
      const parsed = events.length > 0 ? parseTranscript(conversationData.backend, events) : [];
      return {
        turns: parsed,
        source: conversationData.source,
        totalEvents: conversationData.totalEvents,
        session: conversationData.session,
        backend: conversationData.backend,
      };
    }

    if (logsData) {
      return {
        turns: logsToTurns(logsData.logs),
        source: (logsData.sources.synced > 0
          ? 'synced'
          : logsData.sources.local > 0
            ? 'local'
            : 'cloud') as 'synced' | 'local' | 'cloud',
        totalEvents: logsData.pagination.total,
        session: {
          ...logsData.session,
          agentName: logsData.session.agentId,
          lifecycle: logsData.session.status,
          activeThreadKey: null,
        },
        backend: logsData.session.backend ?? 'claude-code',
      };
    }

    return { turns: [], source: 'none' as const, totalEvents: 0, session: null, backend: '' };
  }, [conversationData, logsData]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const turn of turns) {
      for (const block of turn.blocks) {
        if (block.kind === 'tool-result') {
          map.set(block.toolUseId, block);
        }
      }
    }
    return map;
  }, [turns]);

  const isLive = session?.lifecycle === 'running';

  useEffect(() => {
    if (scrollRef.current && turns.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns.length]);

  if (!conversationData && !logsData && !conversationError) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <div className="text-center">
          <div className="animate-pulse text-lg mb-2">Loading conversation…</div>
          <div className="text-xs">{sessionId.slice(0, 8)}</div>
        </div>
      </div>
    );
  }

  if (!session) return null;

  const agentName = session.agentName || session.agentId;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Session header */}
      <div className="shrink-0 px-4 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-900">{agentName}</h2>
            <Badge variant="outline" className="text-xs font-mono">
              {session.agentId}
            </Badge>
            <Badge className={`text-xs ${phaseColor(session.currentPhase, session.lifecycle)}`}>
              {phaseLabel(session.currentPhase, session.lifecycle)}
            </Badge>
            {'activeThreadKey' in session && session.activeThreadKey && (
              <Badge
                variant="outline"
                className="text-xs font-mono text-indigo-600 border-indigo-300"
              >
                {session.activeThreadKey}
              </Badge>
            )}
            {isLive && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                live
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {useLogsEndpoint && (
              <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                flat view
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              {source === 'synced'
                ? 'Cloud'
                : source === 'local'
                  ? 'Local'
                  : source === 'cloud'
                    ? 'Activity'
                    : 'No transcript'}
            </Badge>
            <span className="text-xs text-gray-400">{totalEvents} events</span>
            {source !== 'synced' && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7"
                onClick={() => syncTranscript.mutate({})}
                disabled={syncTranscript.isPending}
              >
                {syncTranscript.isPending ? 'Syncing…' : 'Sync'}
              </Button>
            )}
          </div>
        </div>
        {backend && (
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
            <span>{backend}</span>
            {session.backendSessionId && (
              <code className="font-mono text-[10px] text-gray-400">
                {session.backendSessionId.slice(0, 12)}…
              </code>
            )}
          </div>
        )}
      </div>

      {/* Conversation body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/50">
        {turns.length === 0 && source === 'none' ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
            <p className="text-sm">No transcript available for this session.</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncTranscript.mutate({})}
              disabled={syncTranscript.isPending}
            >
              {syncTranscript.isPending ? 'Syncing…' : 'Sync transcript from local'}
            </Button>
          </div>
        ) : turns.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p className="text-sm">Transcript is empty.</p>
          </div>
        ) : (
          turns.map((turn) => (
            <MessageBubble
              key={turn.id}
              turn={turn}
              agentName={turn.role === 'assistant' ? agentName : undefined}
              toolResults={toolResults}
            />
          ))
        )}
      </div>
    </div>
  );
}
