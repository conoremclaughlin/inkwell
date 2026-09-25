'use client';

import { useState } from 'react';
import { useApiPost, useQueryClient } from '@/lib/api';
import { Composer } from '@/components/conversation/composer';

export interface ReplyResponse {
  success: boolean;
  messageId: string;
  threadId: string;
}

export { senderLabel } from '@inklabs/shared/stories/thread-viewing';

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
export function ReplyComposer({
  threadKey,
  closed,
  onSent,
}: {
  threadKey: string;
  closed: boolean;
  /** The reply landed. Called for the thread it was sent to. */
  onSent?: (reply: ReplyResponse) => void;
}) {
  return (
    <ThreadReplyComposer key={threadKey} threadKey={threadKey} closed={closed} onSent={onSent} />
  );
}

function ThreadReplyComposer({
  threadKey,
  closed,
  onSent,
}: {
  threadKey: string;
  closed: boolean;
  onSent?: (reply: ReplyResponse) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const reply = useApiPost<ReplyResponse, { key: string; content: string }>(
    '/api/admin/threads/reply',
    {
      // Hook-level callbacks belong to the mutation, not the observer, so
      // they still run if the person has already moved to another thread
      // by the time the reply lands.
      onSuccess: (result) => {
        setDraft('');
        // Both the conversation and the spine list changed: a new message,
        // and a new last-activity time on the key.
        void queryClient.invalidateQueries({ queryKey: ['thread-messages', threadKey] });
        void queryClient.invalidateQueries({ queryKey: ['thread-spines'] });
        onSent?.(result);
      },
    }
  );

  const content = draft.trim();
  const send = () => {
    if (!content || reply.isPending) return;
    reply.mutate({ key: threadKey, content });
  };

  return (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={send}
      sending={reply.isPending}
      placeholder={`Reply to ${threadKey}…`}
      ariaLabel={`Reply to ${threadKey}`}
      error={reply.isError ? reply.error.message : null}
      notice={
        closed
          ? 'This thread is closed. A reply still lands and wakes its participants; it does not reopen the thread — Reopen, in the header, is how you say the work is back on.'
          : undefined
      }
    />
  );
}
