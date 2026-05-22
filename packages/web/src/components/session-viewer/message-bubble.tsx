'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationTurn, ToolCallBlock, ToolResultBlock } from './types';
import { ToolCallCard } from './tool-call-card';

function ThinkingToggle({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        <span className="font-mono">{open ? '▾' : '▸'}</span>
        <span className="italic">thinking…</span>
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l-2 border-gray-200 text-xs text-gray-500 whitespace-pre-wrap max-h-64 overflow-y-auto">
          {text.length > 2000 ? text.slice(0, 2000) + '…' : text}
        </div>
      )}
    </div>
  );
}

function SystemBadge({ text, subtype }: { text: string; subtype?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 flex justify-center">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-gray-400 bg-gray-100 rounded-full px-3 py-0.5 hover:bg-gray-200 transition-colors"
      >
        {subtype ?? 'system'} {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="absolute mt-7 z-10 bg-white border border-gray-200 rounded-lg shadow-lg p-3 max-w-lg max-h-48 overflow-y-auto text-xs text-gray-600 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

export function MessageBubble({
  turn,
  agentName,
  toolResults,
}: {
  turn: ConversationTurn;
  agentName?: string;
  toolResults: Map<string, ToolResultBlock>;
}) {
  if (turn.role === 'system') {
    const block = turn.blocks[0];
    if (!block) return null;
    if (block.kind === 'system') {
      return <SystemBadge text={block.text} subtype={block.subtype} />;
    }
    return null;
  }

  const isUser = turn.role === 'user';
  const hasOnlyToolResults = turn.blocks.every((b) => b.kind === 'tool-result');
  if (hasOnlyToolResults) return null;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* Header */}
        <div className={`flex items-center gap-2 mb-0.5 ${isUser ? 'flex-row-reverse' : ''}`}>
          {!isUser && agentName && (
            <span className="text-xs font-semibold text-gray-700">{agentName}</span>
          )}
          <span className="text-[10px] text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTime(turn.timestamp)}
          </span>
        </div>

        {/* Content blocks */}
        <div className={`space-y-1 ${isUser ? 'text-right' : ''}`}>
          {turn.blocks.map((block, i) => {
            if (block.kind === 'text') {
              return (
                <div
                  key={i}
                  className={`rounded-2xl px-4 py-2.5 inline-block text-left ${
                    isUser
                      ? 'bg-blue-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-900'
                  }`}
                >
                  <div
                    className={`prose prose-sm max-w-none ${
                      isUser
                        ? 'prose-invert prose-p:text-white prose-strong:text-white prose-code:text-blue-100'
                        : 'prose-p:text-gray-900'
                    }`}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
                  </div>
                </div>
              );
            }

            if (block.kind === 'thinking') {
              return <ThinkingToggle key={i} text={block.text} />;
            }

            if (block.kind === 'tool-call') {
              const result = toolResults.get(block.toolUseId);
              return <ToolCallCard key={i} call={block as ToolCallBlock} result={result} />;
            }

            if (block.kind === 'system') {
              return <SystemBadge key={i} text={block.text} subtype={block.subtype} />;
            }

            return null;
          })}
        </div>
      </div>
    </div>
  );
}
