'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApiPost, useQueryClient } from '@/lib/api';

export interface ReplyResponse {
  success: boolean;
  messageId: string;
  threadId: string;
}

export { senderLabel } from './sender-label';

/**
 * A person's way into a thread from the dashboard. Posts through the same
 * route the phone uses — POST /api/admin/threads/reply — which delegates to
 * the send_to_inbox handler, so the reply is stored, counted as unread, and
 * wakes every participant exactly as an SB's reply would. A closed thread
 * takes a reply too: closed is a work-state signal, not a lock, so a
 * dangling PR can be nudged along without hunting down the session that
 * owned it.
 *
 * Every thread gets its own composer instance: this wrapper keys the inner
 * component on the thread key, so a draft typed for one thread is never
 * shown against — or sent to — another, and a send still in flight for the
 * previous thread cannot disable or pre-fill the composer for the next one.
 * (Lumen, PR #613: without the key, selecting thread B kept thread A's
 * draft in the box.)
 */
export function ReplyComposer({ threadKey, closed }: { threadKey: string; closed: boolean }) {
  return <ThreadReplyComposer key={threadKey} threadKey={threadKey} closed={closed} />;
}

function ThreadReplyComposer({ threadKey, closed }: { threadKey: string; closed: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const reply = useApiPost<ReplyResponse, { key: string; content: string }>(
    '/api/admin/threads/reply',
    {
      // Hook-level callbacks belong to the mutation, not the observer, so
      // they still run if the person has already moved to another thread
      // by the time the reply lands.
      onSuccess: () => {
        setDraft('');
        // Both the conversation and the spine list changed: a new message,
        // and a new last-activity time on the key.
        void queryClient.invalidateQueries({ queryKey: ['thread-messages', threadKey] });
        void queryClient.invalidateQueries({ queryKey: ['thread-spines'] });
      },
    }
  );

  const content = draft.trim();
  const canSend = content.length > 0 && !reply.isPending;
  const send = () => {
    if (!canSend) return;
    reply.mutate({ key: threadKey, content });
  };

  return (
    <div className="flex flex-col gap-2">
      {closed && (
        <div className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
          This thread is closed. A reply still lands and wakes its participants; it does not reopen
          the thread. Reopen, next to the status badge, is how you say the work is back on.
        </div>
      )}
      <textarea
        className="min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        placeholder={`Reply to ${threadKey}… (⌘↩ to send)`}
        aria-label={`Reply to ${threadKey}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        disabled={reply.isPending}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={send} disabled={!canSend}>
          <Send className="mr-1 h-3 w-3" />
          {reply.isPending ? 'Sending…' : 'Send'}
        </Button>
        <span className="text-[11px] text-muted-foreground">Wakes every participant.</span>
        {reply.isError && (
          <span className="text-[11px] text-destructive">{reply.error.message}</span>
        )}
      </div>
    </div>
  );
}
