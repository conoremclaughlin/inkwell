'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, Info, MessageSquareDashed } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  threadMessagesPath,
  type ThreadMessagesResponse,
  type ThreadSpine,
} from '@inklabs/shared/stories/threads-api';
import { displayTitle, liveAgentsOf, spineStatus } from '@inklabs/shared/stories/thread-browsing';
import {
  creatorLabel,
  formatDayLabel,
  readableThrough,
  sbAuthor,
  toConversationMessage,
  unreadBeyondLoaded,
  useThreadHistory,
  type ConversationMessage,
  type NameFor,
} from '@inklabs/shared/stories/thread-viewing';
import { apiGet, useWorkspaceApiQuery } from '@/lib/api';
import { AvatarStack } from '@/components/conversation/author-avatar';
import { ConversationView } from '@/components/conversation/conversation-view';
import type { ReadCursorStore } from './read-cursors';
import { ReopenThreadButton } from './reopen-button';
import { ReplyComposer } from './reply-composer';
import { ParticipantCluster, TypeChip } from './thread-list';

/** How often an open conversation looks for new messages while the tab is visible. */
const POLL_MS = 5_000;

/**
 * One thread as a conversation: header, timeline, composer. Mount it keyed
 * by thread key — the read cursor it opens on, the older pages it has
 * loaded, and its scroll position all belong to one thread.
 */
export function ThreadConversation({
  spine,
  workspaceId,
  nameFor,
  cursors,
  onBack,
  detailsOpen,
  onToggleDetails,
}: {
  spine: ThreadSpine;
  /** The workspace the thread was opened in. The same key can be another thread elsewhere. */
  workspaceId: string | null;
  nameFor: NameFor;
  cursors: ReadCursorStore;
  onBack: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const key = spine.key;
  const hasThread = spine.sources.includes('thread');

  // Bound to the workspace the thread was opened in, in its cache key and on
  // the request itself, so a refetch racing a switch can never cache
  // another workspace's page as this one's.
  const { data, dataUpdatedAt, isLoading } = useWorkspaceApiQuery<ThreadMessagesResponse>(
    ['thread-messages', key],
    threadMessagesPath(key),
    workspaceId,
    { refetchInterval: hasThread ? POLL_MS : false }
  );

  // Where the reader was when they opened the thread. Held for the whole
  // visit so the divider stays put while they read past it; a send clears it.
  const [unreadAfter, setUnreadAfter] = useState<string | null>(() => cursors.cursorFor(key));

  const fetchOlder = useCallback(
    (beforeId: string) =>
      apiGet<ThreadMessagesResponse>(threadMessagesPath(key, beforeId), { workspaceId }),
    [key, workspaceId]
  );
  const {
    history,
    opening,
    loadingOlder,
    error: olderError,
    loadOlder,
    abandonCatchUp,
  } = useThreadHistory({
    threadKey: key,
    scope: workspaceId,
    newestPage: data,
    newestPageAt: dataUpdatedAt,
    newestPageLoading: isLoading,
    fetchOlder,
    // The history catches up to this cursor on open, whatever happens to
    // the divider meanwhile.
    openingCursor: cursors.cursorFor(key),
  });

  const messages = useMemo<ConversationMessage[]>(
    () => history.messages.map((m) => toConversationMessage(m, nameFor)),
    [history.messages, nameFor]
  );

  // Reading is acknowledged only as far as the history is whole. The
  // callback changes with the gaps, so the view acknowledges again — now
  // further — once repaired history has reached it.
  const gaps = history.gaps;
  const onReadThrough = useCallback(
    (message: ConversationMessage) =>
      cursors.advance(
        key,
        readableThrough(gaps, { createdAt: message.createdAt, id: message.id }).createdAt
      ),
    [cursors, key, gaps]
  );

  // The explicit way past unread messages that were never loaded.
  const markAllRead = useCallback(() => {
    const newest = history.messages[history.messages.length - 1];
    if (newest) cursors.advance(key, newest.createdAt);
    setUnreadAfter(null);
    abandonCatchUp();
  }, [cursors, key, history.messages, abandonCatchUp]);

  const title = displayTitle(spine) ?? key;
  const status = spineStatus(spine);
  const closed = data?.thread?.status === 'closed' || spine.thread?.status === 'closed';
  const liveAgents = liveAgentsOf(spine);
  const creator = data?.thread?.createdBySlug ?? spine.thread?.createdBySlug;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur md:px-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="All threads"
          className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <ParticipantCluster
          participants={spine.participants}
          nameFor={nameFor}
          className="hidden sm:flex"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold leading-tight">{title}</h2>
            {status === 'closed' && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                closed
              </span>
            )}
            {status === 'unannounced' && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400">
                no thread yet
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <TypeChip identity={spine.identity} />
            {title !== key && <span className="truncate font-mono">{key}</span>}
            {liveAgents.length > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                {liveAgents.map(nameFor).join(', ')} working
              </span>
            )}
          </div>
        </div>
        <AvatarStack
          authors={spine.participants.map((slug) => sbAuthor(slug, nameFor))}
          max={4}
          size="xs"
          className="hidden lg:flex"
        />
        {closed && hasThread && <ReopenThreadButton threadKey={key} />}
        <button
          type="button"
          onClick={onToggleDetails}
          aria-label={detailsOpen ? 'Hide details' : 'Show details'}
          aria-pressed={detailsOpen}
          className={cn(
            'rounded-md p-1.5 transition-colors',
            detailsOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <Info className="h-4 w-4" />
        </button>
      </header>

      {olderError && (
        <div className="shrink-0 border-b bg-destructive/10 px-4 py-1.5 text-center text-[11px] text-destructive">
          {olderError}
        </div>
      )}

      <ConversationView
        key={key}
        messages={messages}
        unreadAfter={unreadAfter}
        loading={opening}
        hasOlder={history.started && !history.oldestReached}
        unreadBeyond={history.ready && unreadBeyondLoaded(history)}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        onReadThrough={onReadThrough}
        onMarkAllRead={markAllRead}
        intro={
          <div className="px-4 pb-2 pt-8 md:px-6">
            <ParticipantCluster participants={spine.participants} nameFor={nameFor} />
            <div className="mt-3 text-lg font-semibold tracking-tight">{title}</div>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              This is the start of <span className="font-mono text-[13px]">{key}</span>
              {creator && <>, opened by {creatorLabel(creator, nameFor)}</>}
              {data?.thread?.createdAt && <> · {formatDayLabel(data.thread.createdAt)}</>}
            </p>
            {spine.thread?.summary && (
              <p className="mt-2 max-w-prose text-sm leading-relaxed">{spine.thread.summary}</p>
            )}
          </div>
        }
        empty={
          <div className="max-w-sm text-center">
            <MessageSquareDashed className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">
              {hasThread ? 'No messages yet' : 'Nothing announced on this key yet'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hasThread
                ? 'Replies from you and the SBs on this thread will appear here.'
                : 'Work is underway but nobody has started a thread. The details panel shows who is on it and where.'}
            </p>
          </div>
        }
      />

      {hasThread && (
        <ReplyComposer threadKey={key} closed={closed} onSent={() => setUnreadAfter(null)} />
      )}
    </div>
  );
}
