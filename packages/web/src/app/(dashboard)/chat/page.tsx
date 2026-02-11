'use client';

import { ChatContainer } from '@/components/chat/chat-container';

export default function ChatPage() {
  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <div className="mb-4">
        <h1 className="text-3xl font-bold text-gray-900">Chat</h1>
        <p className="mt-1 text-gray-600">
          Talk with your SBs directly in the browser.
        </p>
      </div>
      <div className="flex-1 overflow-hidden rounded-lg border bg-white shadow-sm">
        <ChatContainer />
      </div>
    </div>
  );
}
