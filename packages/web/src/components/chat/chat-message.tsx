'use client';

import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface ChatMessageData {
  id: string;
  direction: 'in' | 'out';
  content: string;
  agentId: string;
  createdAt: string;
}

interface ChatMessageProps {
  message: ChatMessageData;
  agentName?: string;
}

export function ChatMessage({ message, agentName }: ChatMessageProps) {
  const isUser = message.direction === 'in';

  return (
    <div
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5',
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-900'
        )}
      >
        {!isUser && agentName && (
          <div className="mb-1 text-xs font-medium text-gray-500">
            {agentName}
          </div>
        )}
        <div
          className={cn(
            'prose prose-sm max-w-none',
            isUser
              ? 'prose-invert prose-p:text-white prose-strong:text-white prose-code:text-blue-100 prose-a:text-blue-200'
              : 'prose-p:text-gray-900'
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
