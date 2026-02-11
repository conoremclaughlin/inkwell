'use client';

import { useEffect, useRef } from 'react';
import { ChatMessage, type ChatMessageData } from './chat-message';
import { TypingIndicator } from './typing-indicator';

interface ChatMessageListProps {
  messages: ChatMessageData[];
  isProcessing: boolean;
  agentName?: string;
}

export function ChatMessageList({
  messages,
  isProcessing,
  agentName,
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {messages.length === 0 && !isProcessing && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <p className="text-lg">Start a conversation</p>
            <p className="mt-1 text-sm">Send a message to begin chatting</p>
          </div>
        )}
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            agentName={agentName}
          />
        ))}
        {isProcessing && <TypingIndicator agentName={agentName} />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
