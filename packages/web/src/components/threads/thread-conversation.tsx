'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Info, MessageSquareDashed } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiGet, useApiQuery } from '@/lib/api';
import { AvatarStack } from '@/components/conversation/author-avatar';
import { ConversationView } from '@/components/conversation/conversation-view';
import { formatDayLabel } from '@/components/conversation/format';
import type { ConversationMessage } from '@/components/conversation/types';
import type { ReadCursorStore } from './read-cursors';
import { ReopenThreadButton } from './reopen-button';
import { ReplyComposer } from './reply-composer';
import { sbAuthor, toConversationMessage, type NameFor } from './to-conversation';
import {
  displayTitle,
  liveAgentsOf,
  ParticipantCluster,
  spineStatus,
  TypeChip,
} from './thread-list';
import {
  absorbNewest,
  absorbOlder,
  dropGap,
  EMPTY_HISTORY,
  type ThreadHistory,
} from './thread-history';
import type { ThreadMessagesResponse, ThreadSpine } from './thread-types';

/** How often an open conversation looks for new messages while the tab is visible. */
const POLL_MS = 5_000;

const pagePath = (key: string, beforeId?: string) =>
  `/api/admin/threads/messages?key=${encodeURIComponent(key)}${beforeId ? `&before=${beforeId}` : ''}`;

/**
 * One thread as a conversation: header, timeline, composer. Mount it keyed
 * by thread key — the read cursor it opens on, the older pages it has
 * loaded, and its scroll position all belong to one thread.
 */
export function ThreadConversation({
  spine,
  nameFor,
  cursors,
  onBack,
  detailsOpen,
  onToggleDetails,
}: {
  spine: ThreadSpine;
  nameFor: NameFor;
  cursors: ReadCursorStore;
  onBack: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const key = spine.key;
  const hasThread = spine.sources.includes('thread');

  const { data, isLoading } = useApiQuery<ThreadMessagesResponse>(
    ['thread-messages', key],
    pagePath(key),
    { refetchInterval: hasThread ? POLL_MS : false }
  );

  // Where the reader was when they opened the thread. Held for the whole
  // visit so the divider stays put while they read past it; a send clears it.
  const [unreadAfter, setUnreadAfter] = useState<string | null>(() => cursors.cursorFor(key));
  // The same cursor, kept for the history to catch up to on open whatever
  // happens to the divider meanwhile.
  const [openingCursor] = useState(() => cursors.cursorFor(key));

  // Every newest page is merged into the history in the render it arrives,
  // so no poll ever shows the conversation without rows it had a moment ago.
  const [history, setHistory] = useState<ThreadHistory>(EMPTY_HISTORY);
  const [absorbed, setAbsorbed] = useState<ThreadMessagesResponse | undefined>(undefined);
  if (data && data !== absorbed) {
    setAbsorbed(data);
    setHistory((current) => absorbNewest(current, data, openingCursor));
  }

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  // Work the history's gaps one at a time: the catch-up to the read cursor
  // on open, and any stretch a poll skipped.
  const gap = history.gaps[0] ?? null;
  useEffect(() => {
    if (!gap) return;
    let cancelled = false;
    apiGet<ThreadMessagesResponse>(pagePath(key, gap.beforeId))
      .then((page) => {
        if (!cancelled) setHistory((current) => absorbOlder(current, page, gap));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOlderError(error instanceof Error ? error.message : 'Failed to load messages');
        setHistory((current) => dropGap(current, gap));
      });
    return () => {
      cancelled = true;
    };
  }, [gap, key]);

  const messages = useMemo<ConversationMessage[]>(
    () => history.messages.map((m) => toConversationMessage(m, nameFor)),
    [history.messages, nameFor]
  );

  const loadOlder = useCallback(async () => {
    const oldest = history.messages[0];
    if (loadingOlder || !oldest) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await apiGet<ThreadMessagesResponse>(pagePath(key, oldest.id));
      setHistory((current) => absorbOlder(current, page, null));
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : 'Failed to load earlier messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, history.messages, key]);

  // Not ready to show until the history reaches the read cursor: the view
  // positions once, on the real first unread message.
  const opening = history.started ? !history.ready : isLoading;

  const onReadThrough = useCallback(
    (message: ConversationMessage) => cursors.advance(key, message.createdAt),
    [cursors, key]
  );

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
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        onReadThrough={onReadThrough}
        intro={
          <div className="px-4 pb-2 pt-8 md:px-6">
            <ParticipantCluster participants={spine.participants} nameFor={nameFor} />
            <div className="mt-3 text-lg font-semibold tracking-tight">{title}</div>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              This is the start of <span className="font-mono text-[13px]">{key}</span>
              {creator && <>, opened by {nameFor(creator)}</>}
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
