'use client';

import { useState } from 'react';
import type { ToolCallBlock, ToolResultBlock } from './types';

const TOOL_CATEGORIES: Record<string, { label: string; color: string }> = {
  Read: { label: 'Read', color: 'text-emerald-600' },
  Write: { label: 'Write', color: 'text-amber-600' },
  Edit: { label: 'Edit', color: 'text-amber-600' },
  Bash: { label: 'Bash', color: 'text-violet-600' },
  Agent: { label: 'Agent', color: 'text-blue-600' },
  WebSearch: { label: 'Search', color: 'text-cyan-600' },
  WebFetch: { label: 'Fetch', color: 'text-cyan-600' },
};

function getToolMeta(name: string): { label: string; color: string } {
  if (TOOL_CATEGORIES[name]) return TOOL_CATEGORIES[name];
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? 'mcp';
    const tool = parts.slice(2).join('__');
    return { label: `${server}/${tool}`, color: 'text-indigo-600' };
  }
  return { label: name, color: 'text-gray-600' };
}

function formatInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const parts: string[] = [];
  for (const key of keys.slice(0, 4)) {
    const val = obj[key];
    if (typeof val === 'string') {
      parts.push(`${key}: ${val.length > 60 ? val.slice(0, 60) + '…' : val}`);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${key}: ${val}`);
    }
  }
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  return parts.join(' · ');
}

function truncateResult(content: string, max = 300): string {
  if (content.length <= max) return content;
  return content.slice(0, max) + '…';
}

export function ToolCallCard({ call, result }: { call: ToolCallBlock; result?: ToolResultBlock }) {
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(call.name);
  const summary = formatInput(call.input);

  return (
    <div className="my-1.5 rounded-lg border border-gray-200 bg-gray-50/80 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100/80 transition-colors"
      >
        <span className="text-xs font-mono font-medium shrink-0" style={{ minWidth: '16px' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span className={`text-xs font-semibold font-mono shrink-0 ${meta.color}`}>
          {meta.label}
        </span>
        {summary && <span className="text-xs text-gray-500 truncate">{summary}</span>}
        {result && (
          <span
            className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
              result.isError ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {result.isError ? 'error' : 'ok'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          {call.input != null &&
          typeof call.input === 'object' &&
          Object.keys(call.input as Record<string, unknown>).length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Input</div>
              <pre className="text-xs text-gray-700 bg-white rounded border border-gray-100 p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">Result</div>
              <pre
                className={`text-xs rounded border p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words ${
                  result.isError
                    ? 'text-red-700 bg-red-50 border-red-100'
                    : 'text-gray-700 bg-white border-gray-100'
                }`}
              >
                {truncateResult(result.content, 2000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
