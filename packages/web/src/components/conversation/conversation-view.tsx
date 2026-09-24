'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MessageRow } from './message-row';
import { buildTimeline } from './timeline';
import type { ConversationMessage } from './types';

/** Within this many pixels of the end counts as "at the latest message". */
const BOTTOM_SLACK_PX = 64;
/** Within this many pixels of the top, older history starts loading. */
const TOP_LOAD_PX = 120;
/** Room left above the new-messages divider when a conversation opens on it. */
const UNREAD_OFFSET_PX = 56;

export interface ConversationViewProps {
  /** Any order; the view sorts by time. */
  messages: ConversationMessage[];
  /**
   * The viewer's read cursor when they opened the conversation (ISO). The
   * view opens on the first message after it, marked by a divider. Hold it
   * steady while the conversation is open — a cursor that follows the
   * reader would pull the divider out from under them.
   */
  unreadAfter?: string | null;
  loading?: boolean;
  /** There is history before the first message. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The viewer has seen through this message: at the end, with the page visible. */
  onReadThrough?: (message: ConversationMessage) => void;
  /** Shown above the first message once there is no older history. */
  intro?: ReactNode;
  /** Shown when there are no messages at all. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A scrolling conversation that behaves like a chat. It opens at the first
 * unread message, or at the end. It stays pinned to the end while new
 * messages (or a streaming message's growing body) arrive — unless the
 * reader has scrolled up, in which case it counts what arrived and offers a
 * way back. Older history loads as the reader nears the top, without moving
 * what they are looking at.
 *
 * Positioning is per mount: key the view by conversation, so switching
 * conversations starts fresh rather than inheriting another one's scroll.
 */
export function ConversationView({
  messages,
  unreadAfter,
  loading = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onReadThrough,
  intro,
  empty,
  className,
}: ConversationViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildTimeline(messages, { unreadAfter }), [messages, unreadAfter]);
  const ordered = useMemo(
    () => items.flatMap((item) => (item.type === 'message' ? [item.message] : [])),
    [items]
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  // Not "at the end" until the view has positioned itself: reading is only
  // acknowledged once the reader is actually looking at the end.
  const [atBottom, setAtBottom] = useState(false);
  const atBottomRef = useRef(false);
  const [newCount, setNewCount] = useState(0);

  const positioned = useRef(false);
  const seen = useRef<{ firstId?: string; lastId?: string; height: number }>({ height: 0 });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom;
      setAtBottom(bottom);
    }
    if (bottom) setNewCount(0);
  }, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Everything that moves the scroll position in response to the messages
  // themselves runs before paint, so the reader never sees a jump.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !first || !last) return;

    if (!positioned.current) {
      positioned.current = true;
      const divider = unreadRef.current;
      if (divider) {
        el.scrollTop +=
          divider.getBoundingClientRect().top - el.getBoundingClientRect().top - UNREAD_OFFSET_PX;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else {
      // Older history arrived above: hold what the reader is looking at
      // still by moving down exactly as far as the content grew.
      if (first.id !== seen.current.firstId && last.id === seen.current.lastId) {
        el.scrollTop += el.scrollHeight - seen.current.height;
      }
      // New messages at the end.
      if (last.id !== seen.current.lastId) {
        const lastSeenIndex = ordered.findIndex((m) => m.id === seen.current.lastId);
        const arrived = ordered.slice(lastSeenIndex + 1);
        if (last.author.isOwn) {
          // The reader just sent this: take them to it wherever they were.
          scrollToEnd('smooth');
        } else if (atBottomRef.current) {
          el.scrollTop = el.scrollHeight;
        } else {
          setNewCount((count) => count + arrived.filter((m) => !m.author.isOwn).length);
        }
      }
    }
    seen.current = { firstId: first.id, lastId: last.id, height: el.scrollHeight };
    measure();
  }, [first, last, ordered, measure, scrollToEnd]);

  // Growth that is not a new message — an image loading, a code block
  // laying out, a streaming body getting longer — keeps a pinned view pinned.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      seen.current.height = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    measure();
    const el = scrollerRef.current;
    if (el && el.scrollTop < TOP_LOAD_PX && hasOlder && !loadingOlder && positioned.current) {
      onLoadOlder?.();
    }
  }, [measure, hasOlder, loadingOlder, onLoadOlder]);

  // Seen means at the end with the page in front of the reader. A hidden
  // tab polling in new messages must not mark them read.
  useEffect(() => {
    if (!onReadThrough || !atBottom || !last) return;
    const acknowledge = () => {
      if (document.visibilityState === 'visible') onReadThrough(last);
    };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [atBottom, last, onReadThrough]);

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        // Manual anchoring below; the browser's own would correct twice.
        style={{ overflowAnchor: 'none' }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-4">
          {loading && ordered.length === 0 ? (
            <ConversationSkeleton />
          ) : ordered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8">{empty}</div>
          ) : (
            <>
              {hasOlder ? (
                <div className="flex justify-center py-3">
                  <button
                    type="button"
                    onClick={onLoadOlder}
                    disabled={loadingOlder}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground disabled:opacity-70"
                  >
                    {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
                    {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                  </button>
                </div>
              ) : (
                intro
              )}
              {items.map((item) => {
                if (item.type === 'day') {
                  return (
                    <div key={item.key} className="flex items-center gap-3 px-4 pb-1 pt-5 md:px-6">
                      <div className="h-px flex-1 bg-border" />
                      <span className="rounded-full border bg-background px-3 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {item.label}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  );
                }
                if (item.type === 'unread') {
                  return (
                    <div
                      key={item.key}
                      ref={unreadRef}
                      className="flex items-center gap-2 px-4 pb-1 pt-4 md:px-6"
                      data-unread-divider
                    >
                      <div className="h-px flex-1 bg-rose-500/70" />
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                        {item.count === 1 ? '1 new message' : `${item.count} new messages`}
                      </span>
                    </div>
                  );
                }
                return (
                  <MessageRow
                    key={item.key}
                    message={item.message}
                    continuation={item.continuation}
                  />
                );
              })}
            </>
          )}
        </div>
      </div>

      {!atBottom && ordered.length > 0 && (
        <button
          type="button"
          onClick={() => scrollToEnd('smooth')}
          className={cn(
            'absolute bottom-4 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium shadow-lg transition-colors',
            newCount > 0
              ? 'border-sky-600 bg-sky-600 text-white hover:bg-sky-700'
              : 'bg-background text-foreground hover:bg-muted'
          )}
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {newCount > 0
            ? newCount === 1
              ? '1 new message'
              : `${newCount} new messages`
            : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="flex flex-col gap-5 px-4 py-6 md:px-6" aria-label="Loading conversation">
      {[72, 48, 88, 60].map((width, i) => (
        <div key={i} className="flex gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
