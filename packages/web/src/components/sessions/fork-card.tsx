'use client';

/**
 * ForkCard — timeline card for agent_spawn entries that forked a child
 * session (payload.childSessionId or the activity childSessionId column).
 * Links to the child session's live timeline; pulses while the fork is
 * fresh. See ink://specs/live-session-experience (WS2).
 */

import Link from 'next/link';
import { GitBranch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const RECENT_FORK_WINDOW_MS = 10 * 60 * 1000;

export interface ForkTimelineEntry {
  id: string;
  source: string;
  type: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  childSessionId?: string | null;
}

export function forkChildSessionId(
  entry: Pick<ForkTimelineEntry, 'type' | 'childSessionId' | 'metadata'>
): string | null {
  if (!entry.type.startsWith('agent_spawn') && !entry.type.includes('runner_spawned')) return null;
  if (entry.childSessionId) return entry.childSessionId;
  const fromPayload = entry.metadata?.childSessionId;
  return typeof fromPayload === 'string' && fromPayload ? fromPayload : null;
}

function metaString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function ForkCard({
  entry,
  childSessionId,
  formatDate,
}: {
  entry: ForkTimelineEntry;
  childSessionId: string;
  formatDate: (date: string) => string;
}) {
  const label =
    metaString(entry.metadata, 'childAgentId') ||
    metaString(entry.metadata, 'agentId') ||
    metaString(entry.metadata, 'label') ||
    entry.content ||
    'sub-agent';
  const isRecent = Date.now() - new Date(entry.timestamp).getTime() < RECENT_FORK_WINDOW_MS;

  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-indigo-300 text-indigo-700">
            fork
          </Badge>
          <Badge variant="outline">{entry.source}</Badge>
          <span>{entry.type}</span>
        </div>
        <span className="shrink-0">{formatDate(entry.timestamp)}</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-800">
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {isRecent ? (
            <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-indigo-400 opacity-60" />
          ) : null}
          <GitBranch className="relative h-4 w-4 text-indigo-600" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Link
          href={`/sessions/${childSessionId}`}
          className="shrink-0 text-xs font-medium text-indigo-700 underline-offset-2 hover:underline"
        >
          View child session →
        </Link>
      </div>
    </div>
  );
}
