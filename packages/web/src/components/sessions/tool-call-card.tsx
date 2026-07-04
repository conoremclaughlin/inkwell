'use client';

/**
 * ToolCallCard — collapsible timeline card for tool_call / tool_result
 * activity entries. Reads the structured payload logged by the server
 * (tool, argsSummary, status, durationMs) instead of regex-sniffing raw
 * log text. See ink://specs/live-session-experience (WS2).
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import clsx from 'clsx';

export interface ToolTimelineEntry {
  id: string;
  source: string;
  type: string;
  role: 'in' | 'out' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  status?: string | null;
  durationMs?: number | null;
}

export function isToolEntry(entry: Pick<ToolTimelineEntry, 'type'>): boolean {
  return entry.type.startsWith('tool_call') || entry.type.startsWith('tool_result');
}

function metaString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function toolNameFor(entry: ToolTimelineEntry): string {
  const fromPayload = metaString(entry.metadata, 'tool') || metaString(entry.metadata, 'toolName');
  if (fromPayload) return fromPayload;
  // type is "tool_call:<name>" for activity_stream entries with a subtype
  const colon = entry.type.indexOf(':');
  if (colon >= 0 && colon < entry.type.length - 1) return entry.type.slice(colon + 1);
  return entry.type.startsWith('tool_result') ? 'tool result' : 'tool call';
}

function argsPreviewFor(entry: ToolTimelineEntry): string {
  const summary = metaString(entry.metadata, 'argsSummary');
  if (summary) return summary;
  const input = entry.metadata?.input;
  if (input !== undefined) {
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return entry.content;
}

function statusFor(entry: ToolTimelineEntry): string | null {
  if (entry.status) return entry.status;
  return metaString(entry.metadata, 'status');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function expandedDetail(entry: ToolTimelineEntry): string {
  const sections: string[] = [];
  const summary = metaString(entry.metadata, 'argsSummary');
  if (summary) sections.push(`Args: ${summary}`);
  const input = entry.metadata?.input;
  if (input !== undefined) {
    try {
      sections.push(`Input:\n${JSON.stringify(input, null, 2)}`);
    } catch {
      sections.push(`Input:\n${String(input)}`);
    }
  }
  if (entry.content && entry.content.trim()) {
    sections.push(
      entry.type.startsWith('tool_result') ? `Result:\n${entry.content}` : entry.content
    );
  }
  return sections.join('\n\n') || 'No detail captured.';
}

export function toolEntryRawJson(entry: ToolTimelineEntry): string {
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    return JSON.stringify(entry.metadata, null, 2);
  }
  try {
    return JSON.stringify(JSON.parse(entry.content), null, 2);
  } catch {
    return JSON.stringify({ content: entry.content }, null, 2);
  }
}

export function ToolCallCard({
  entry,
  formatDate,
  onViewRaw,
}: {
  entry: ToolTimelineEntry;
  formatDate: (date: string) => string;
  onViewRaw: (entry: { id: string; type: string; json: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolName = toolNameFor(entry);
  const argsPreview = argsPreviewFor(entry);
  const status = statusFor(entry);
  const durationMs =
    typeof entry.durationMs === 'number'
      ? entry.durationMs
      : typeof entry.metadata?.durationMs === 'number'
        ? (entry.metadata.durationMs as number)
        : null;
  const isResult = entry.type.startsWith('tool_result');

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-violet-300 text-violet-700">
            {isResult ? 'tool result' : 'tool call'}
          </Badge>
          <Badge variant="outline">{entry.source}</Badge>
        </div>
        <span className="shrink-0">{formatDate(entry.timestamp)}</span>
      </div>

      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm text-gray-800"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
        )}
        <Wrench className="h-4 w-4 shrink-0 text-violet-500" />
        <span className="shrink-0 font-mono text-xs font-semibold text-gray-900">{toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500">
          {argsPreview}
        </span>
        {status ? (
          <Badge
            variant="outline"
            className={clsx(
              'shrink-0 text-[10px]',
              status === 'failed'
                ? 'border-red-300 text-red-700'
                : status === 'completed'
                  ? 'border-emerald-300 text-emerald-700'
                  : 'border-gray-300 text-gray-600'
            )}
          >
            {status}
          </Badge>
        ) : null}
        {durationMs != null ? (
          <span className="shrink-0 text-xs text-gray-400">{formatDuration(durationMs)}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2">
          <div className="overflow-auto rounded-md border border-gray-200 bg-gray-950 p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-100">
              {expandedDetail(entry)}
            </pre>
          </div>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                onViewRaw({ id: entry.id, type: entry.type, json: toolEntryRawJson(entry) })
              }
            >
              View raw JSON
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
