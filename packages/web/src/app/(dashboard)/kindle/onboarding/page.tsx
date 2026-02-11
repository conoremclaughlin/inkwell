'use client';

import { useState, useCallback, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useApiQuery, useApiPost, useQueryClient } from '@/lib/api';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import { ChatInput } from '@/components/chat/chat-input';
import type { ChatMessageData } from '@/components/chat/chat-message';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles } from 'lucide-react';

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

interface KindleInfo {
  kindle: {
    id: string;
    childAgentId: string;
    onboardingStatus: string;
    chosenName: string | null;
    valueSeed: {
      parentName?: string;
      coreValues?: string[];
    };
  } | null;
}

function KindleOnboardingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const kindleId = searchParams.get('kindleId');
  const agentId = searchParams.get('agentId');

  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessageData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showNaming, setShowNaming] = useState(false);
  const [chosenName, setChosenName] = useState('');

  // Load kindle info
  const { data: kindleData } = useApiQuery<KindleInfo>(
    ['kindle', kindleId],
    `/api/kindle/${kindleId}`,
    { enabled: !!kindleId }
  );

  // Load chat history
  const { data: historyData } = useApiQuery<HistoryResponse>(
    ['chat-history', agentId],
    `/api/chat/history?agentId=${agentId}`,
    { enabled: !!agentId }
  );

  const historyMessages = historyData?.messages ?? [];
  const allMessages = [...historyMessages, ...optimisticMessages];

  // Check if onboarding is already complete
  useEffect(() => {
    if (kindleData?.kindle?.onboardingStatus === 'complete') {
      router.push('/chat');
    }
  }, [kindleData, router]);

  // Send message mutation
  const sendMutation = useApiPost<SendMessageResponse, SendMessageInput>(
    '/api/chat/message'
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (!agentId || isProcessing) return;

      const optimisticId = `optimistic-${Date.now()}`;
      const userMessage: ChatMessageData = {
        id: optimisticId,
        direction: 'in',
        content,
        agentId,
        createdAt: new Date().toISOString(),
      };
      setOptimisticMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        const result = await sendMutation.mutateAsync({ agentId, content });

        if (result.response) {
          const responseMessage: ChatMessageData = {
            id: `response-${Date.now()}`,
            direction: 'out',
            content: result.response,
            agentId,
            createdAt: new Date().toISOString(),
          };
          setOptimisticMessages((prev) => [...prev, responseMessage]);
        }

        queryClient.invalidateQueries({ queryKey: ['chat-history', agentId] });
      } catch {
        const errorMessage: ChatMessageData = {
          id: `error-${Date.now()}`,
          direction: 'out',
          content: 'Something went wrong. Please try again.',
          agentId,
          createdAt: new Date().toISOString(),
        };
        setOptimisticMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
      }
    },
    [agentId, isProcessing, sendMutation, queryClient]
  );

  // Complete onboarding mutation
  const completeMutation = useApiPost<
    { kindle: { childAgentId: string }; agentId: string },
    { chosenName: string }
  >(`/api/kindle/${kindleId}/complete`);

  const handleComplete = async () => {
    if (!chosenName.trim()) return;

    try {
      await completeMutation.mutateAsync({ chosenName: chosenName.trim() });
      router.push('/chat');
    } catch {
      // Show error inline
    }
  };

  if (!kindleId || !agentId) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400">
        <p>Missing kindle or agent information. Please use a valid kindle invite link.</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold text-gray-900">
            <Sparkles className="h-7 w-7 text-amber-500" />
            Meet your SB
          </h1>
          <p className="mt-1 text-gray-600">
            Have a conversation. Discover values. Choose a name.
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowNaming(!showNaming)}>
          {showNaming ? 'Back to chat' : 'Ready to name'}
        </Button>
      </div>

      {showNaming ? (
        <Card className="mx-auto w-full max-w-lg">
          <CardHeader>
            <CardTitle>Choose a name for your SB</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Based on your conversation, what name feels right? This is the
              name your SB will carry forward.
            </p>
            <input
              type="text"
              value={chosenName}
              onChange={(e) => setChosenName(e.target.value)}
              placeholder="Enter a name..."
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-lg focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <Button
              onClick={handleComplete}
              disabled={!chosenName.trim() || completeMutation.isPending}
              className="w-full"
              size="lg"
            >
              {completeMutation.isPending ? 'Creating identity...' : 'Complete the Kindle'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex-1 overflow-hidden rounded-lg border bg-white shadow-sm">
          <div className="flex h-full flex-col">
            <ChatMessageList
              messages={allMessages}
              isProcessing={isProcessing}
              agentName="New SB"
            />
            <ChatInput
              onSend={handleSend}
              disabled={isProcessing}
              placeholder="Talk with your nascent SB..."
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function KindleOnboardingPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-gray-400">Loading...</div>}>
      <KindleOnboardingContent />
    </Suspense>
  );
}
