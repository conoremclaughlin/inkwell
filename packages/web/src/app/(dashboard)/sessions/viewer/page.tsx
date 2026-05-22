'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SessionSidebar } from '@/components/session-viewer/session-sidebar';
import { ConversationViewer } from '@/components/session-viewer/conversation-viewer';

export default function SessionViewerPage() {
  const searchParams = useSearchParams();
  const initialSession = searchParams.get('id');
  const [selectedId, setSelectedId] = useState<string | null>(initialSession);

  return (
    <div className="h-[calc(100vh-64px)] flex overflow-hidden -m-8">
      <SessionSidebar selectedId={selectedId} onSelect={setSelectedId} />
      <div className="flex-1 flex flex-col overflow-hidden bg-white">
        {selectedId ? (
          <ConversationViewer sessionId={selectedId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <p className="text-lg font-medium mb-1">Select a session</p>
              <p className="text-sm">Choose a session from the sidebar to view the conversation.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
