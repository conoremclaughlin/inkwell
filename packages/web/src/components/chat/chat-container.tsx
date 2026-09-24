'use client';

import { useState, useCallback } from 'react';
import { useApiQuery, useApiPost, useQueryClient } from '@/lib/api';
import { AgentPicker, type Agent } from './agent-picker';
import { ChatMessageList } from './chat-message-list';
import { ChatInput } from './chat-input';
import type { ChatMessageData } from './chat-message';

interface AgentsResponse {
  agents: Agent[];
}

interface HistoryResponse {
  messages: ChatMessageData[];
}

interface SendMessageInput {
  sbSlug: string;
  content: string;
}

interface SendMessageResponse {
  success: boolean;
  response: string | null;
  sessionId: string;
  error?: string;
}

export function ChatContainer() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessageData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const queryClient = useQueryClient();

  // Load available agents
  const { data: agentsData, isLoading: agentsLoading } = useApiQuery<AgentsResponse>(
    ['chat-agents'],
    '/api/chat/agents'
  );

  const agents = agentsData?.agents ?? [];

  // Auto-select first agent
  const effectiveSlug = selectedSlug || agents[0]?.sbSlug || null;

  // Load chat history for selected agent
  const { data: historyData } = useApiQuery<HistoryResponse>(
    ['chat-history', effectiveSlug],
    `/api/chat/history?sbSlug=${effectiveSlug}`,
    { enabled: !!effectiveSlug }
  );

  const historyMessages = historyData?.messages ?? [];

  // Combine history with optimistic messages
  const allMessages = [...historyMessages, ...optimisticMessages];

  // Get selected agent name
  const selectedAgent = agents.find((a) => a.sbSlug === effectiveSlug);

  // Send message mutation
  const sendMutation = useApiPost<SendMessageResponse, SendMessageInput>('/api/chat/message');

  const handleSend = useCallback(
    async (content: string) => {
      if (!effectiveSlug || isProcessing) return;

      // Add optimistic user message
      const optimisticId = `optimistic-${Date.now()}`;
      const userMessage: ChatMessageData = {
        id: optimisticId,
        direction: 'in',
        content,
        sbSlug: effectiveSlug,
        createdAt: new Date().toISOString(),
      };
      setOptimisticMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        const result = await sendMutation.mutateAsync({
          sbSlug: effectiveSlug,
          content,
        });

        if (result.response) {
          // Add agent response as optimistic message
          const responseMessage: ChatMessageData = {
            id: `response-${Date.now()}`,
            direction: 'out',
            content: result.response,
            sbSlug: effectiveSlug,
            createdAt: new Date().toISOString(),
          };
          setOptimisticMessages((prev) => [...prev, responseMessage]);
        }

        // Invalidate history to sync with server
        queryClient.invalidateQueries({ queryKey: ['chat-history', effectiveSlug] });
      } catch {
        // Add error message
        const errorMessage: ChatMessageData = {
          id: `error-${Date.now()}`,
          direction: 'out',
          content: 'Failed to send message. Please try again.',
          sbSlug: effectiveSlug,
          createdAt: new Date().toISOString(),
        };
        setOptimisticMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
      }
    },
    [effectiveSlug, isProcessing, sendMutation, queryClient]
  );

  const handleAgentSelect = useCallback((sbSlug: string) => {
    setSelectedSlug(sbSlug);
    setOptimisticMessages([]);
  }, []);

  if (agentsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">Loading agents...</div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">
        <div className="text-center">
          <p className="text-lg">No agents available</p>
          <p className="mt-1 text-sm">Create an agent identity using the Inkwell tools first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AgentPicker agents={agents} selectedSlug={effectiveSlug} onSelect={handleAgentSelect} />
      <ChatMessageList
        messages={allMessages}
        isProcessing={isProcessing}
        agentName={selectedAgent?.name}
      />
      <ChatInput
        onSend={handleSend}
        disabled={isProcessing || !effectiveSlug}
        placeholder={
          effectiveSlug
            ? `Message ${selectedAgent?.name || effectiveSlug}...`
            : 'Select an agent to start chatting'
        }
      />
    </div>
  );
}
