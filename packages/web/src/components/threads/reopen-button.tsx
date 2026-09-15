'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApiPost, useQueryClient } from '@/lib/api';

export interface ReopenResponse {
  success: boolean;
  threadKey: string;
  reopened: boolean;
  alreadyOpen: boolean;
}

/**
 * Puts a closed thread's work back on — explicitly. A reply to a closed
 * thread never reopens it (spec inkmail-thread-scope §2); this button is
 * the one place a person says "this isn't done after all". It wakes nobody:
 * once the thread is open again, a reply is how the participants hear.
 *
 * Keyed per thread, like the composer: a reopen still in flight for one
 * thread cannot disable the button on the next one.
 */
export function ReopenThreadButton({ threadKey }: { threadKey: string }) {
  return <ThreadReopenButton key={threadKey} threadKey={threadKey} />;
}

function ThreadReopenButton({ threadKey }: { threadKey: string }) {
  const queryClient = useQueryClient();
  const reopen = useApiPost<ReopenResponse, { key: string }>('/api/admin/threads/reopen', {
    onSuccess: () => {
      // The thread's status lives in both the detail and the spine list.
      void queryClient.invalidateQueries({ queryKey: ['thread-messages', threadKey] });
      void queryClient.invalidateQueries({ queryKey: ['thread-spines'] });
    },
  });

  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => reopen.mutate({ key: threadKey })}
        disabled={reopen.isPending}
        title="Put this thread's work back on. Wakes nobody — send a reply to wake the participants."
        aria-label={`Reopen ${threadKey}`}
      >
        <RotateCcw className="mr-1 h-3 w-3" />
        {reopen.isPending ? 'Reopening…' : 'Reopen'}
      </Button>
      {reopen.isError && (
        <span className="text-[11px] text-destructive">{reopen.error.message}</span>
      )}
    </span>
  );
}
