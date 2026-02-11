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
  agentId: string;
  content: string;
}

interface SendMessageResponse {
  success: boolean;
  response: string | null;
  sessionId: string;
  error?: string;
}

export function ChatContainer() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
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
  const effectiveAgentId = selectedAgentId || agents[0]?.agentId || null;

  // Load chat history for selected agent
  const { data: historyData } = useApiQuery<HistoryResponse>(
    ['chat-history', effectiveAgentId],
    `/api/chat/history?agentId=${effectiveAgentId}`,
    { enabled: !!effectiveAgentId }
  );

  const historyMessages = historyData?.messages ?? [];

  // Combine history with optimistic messages
  const allMessages = [...historyMessages, ...optimisticMessages];

  // Get selected agent name
  const selectedAgent = agents.find((a) => a.agentId === effectiveAgentId);

  // Send message mutation
  const sendMutation = useApiPost<SendMessageResponse, SendMessageInput>(
    '/api/chat/message'
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (!effectiveAgentId || isProcessing) return;

      // Add optimistic user message
      const optimisticId = `optimistic-${Date.now()}`;
      const userMessage: ChatMessageData = {
        id: optimisticId,
        direction: 'in',
        content,
        agentId: effectiveAgentId,
        createdAt: new Date().toISOString(),
      };
      setOptimisticMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        const result = await sendMutation.mutateAsync({
          agentId: effectiveAgentId,
          content,
        });

        if (result.response) {
          // Add agent response as optimistic message
          const responseMessage: ChatMessageData = {
            id: `response-${Date.now()}`,
            direction: 'out',
            content: result.response,
            agentId: effectiveAgentId,
            createdAt: new Date().toISOString(),
          };
          setOptimisticMessages((prev) => [...prev, responseMessage]);
        }

        // Invalidate history to sync with server
        queryClient.invalidateQueries({ queryKey: ['chat-history', effectiveAgentId] });
      } catch {
        // Add error message
        const errorMessage: ChatMessageData = {
          id: `error-${Date.now()}`,
          direction: 'out',
          content: 'Failed to send message. Please try again.',
          agentId: effectiveAgentId,
          createdAt: new Date().toISOString(),
        };
        setOptimisticMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
      }
    },
    [effectiveAgentId, isProcessing, sendMutation, queryClient]
  );

  const handleAgentSelect = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setOptimisticMessages([]);
  }, []);

  if (agentsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">
        Loading agents...
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">
        <div className="text-center">
          <p className="text-lg">No agents available</p>
          <p className="mt-1 text-sm">Create an agent identity using the PCP tools first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AgentPicker
        agents={agents}
        selectedAgentId={effectiveAgentId}
        onSelect={handleAgentSelect}
      />
      <ChatMessageList
        messages={allMessages}
        isProcessing={isProcessing}
        agentName={selectedAgent?.name}
      />
      <ChatInput
        onSend={handleSend}
        disabled={isProcessing || !effectiveAgentId}
        placeholder={
          effectiveAgentId
            ? `Message ${selectedAgent?.name || effectiveAgentId}...`
            : 'Select an agent to start chatting'
        }
      />
    </div>
  );
}
