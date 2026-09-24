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
/** Longest a smooth scroll to the end is expected to take. */
const FOLLOW_MS = 1_000;

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
  /**
   * Not ready to show: the view renders a skeleton and holds its opening
   * position until this clears, so it positions exactly once, on the
   * messages it was meant to open on.
   */
  loading?: boolean;
  /** There is history before the first message. */
  hasOlder?: boolean;
  /**
   * Unread messages exist before the first loaded one: the source stopped
   * short of the reader's cursor. The older-history control and the divider
   * say so instead of presenting what loaded as the whole of it.
   */
  unreadBeyond?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The viewer has seen through this message: at the end, with the page visible. */
  onReadThrough?: (message: ConversationMessage) => void;
  /** Offered while unread messages remain above: skip them, explicitly. */
  onMarkAllRead?: () => void;
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
  unreadBeyond = false,
  loadingOlder = false,
  onLoadOlder,
  onReadThrough,
  onMarkAllRead,
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
  const seen = useRef<{ lastId?: string }>({});
  // The message at the top of the view and where it sat. A change above it
  // — older history, a filled gap, an image loading — moves the content,
  // never the reader.
  const anchor = useRef<{ id: string; top: number } | null>(null);

  const captureAnchor = useCallback(() => {
    const el = scrollerRef.current;
    anchor.current = el ? topVisibleMessage(el) : null;
  }, []);

  const holdAnchor = useCallback(() => {
    const el = scrollerRef.current;
    const held = anchor.current;
    if (!el || !held) return;
    const node = messageNode(el, held.id);
    const moved = node ? node.getBoundingClientRect().top - held.top : 0;
    // Only write when something moved: any write cancels a smooth scroll.
    if (moved !== 0) el.scrollTop += moved;
  }, []);

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

  // A smooth scroll to the end is under way until this time. Content that
  // grows mid-animation re-pins rather than holding the anchor: writing the
  // scroll position cancels the animation short of the end.
  const followingUntil = useRef(0);
  const pinned = useCallback(() => atBottomRef.current || Date.now() < followingUntil.current, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const el = scrollerRef.current;
    if (!el) return;
    if (behavior === 'smooth') followingUntil.current = Date.now() + FOLLOW_MS;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Everything that moves the scroll position in response to the messages
  // themselves runs before paint, so the reader never sees a jump.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !first || !last || loading) return;

    if (!positioned.current) {
      positioned.current = true;
      const divider = unreadRef.current;
      if (unreadBeyond) {
        // The unread run starts above what loaded: open at the very top, on
        // the control that loads the rest.
        el.scrollTop = 0;
      } else if (divider) {
        el.scrollTop +=
          divider.getBoundingClientRect().top - el.getBoundingClientRect().top - UNREAD_OFFSET_PX;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else {
      const newAtEnd = last.id !== seen.current.lastId;
      if (newAtEnd && last.author.isOwn) {
        // The reader just sent this: take them to it wherever they were.
        scrollToEnd('smooth');
      } else if (pinned()) {
        // Pinned stays pinned, whatever changed — including a gap filling
        // in above, which grows the content without touching its end.
        el.scrollTop = el.scrollHeight;
      } else {
        holdAnchor();
        if (newAtEnd) {
          const lastSeenIndex = ordered.findIndex((m) => m.id === seen.current.lastId);
          const arrived = ordered.slice(lastSeenIndex + 1);
          setNewCount((count) => count + arrived.filter((m) => !m.author.isOwn).length);
        }
      }
    }
    seen.current = { lastId: last.id };
    measure();
    captureAnchor();
  }, [
    first,
    last,
    ordered,
    loading,
    unreadBeyond,
    measure,
    scrollToEnd,
    pinned,
    holdAnchor,
    captureAnchor,
  ]);

  // Growth that is not a new message — an image loading, a code block
  // laying out, a streaming body getting longer — keeps a pinned view pinned.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned()) el.scrollTop = el.scrollHeight;
      else holdAnchor();
      captureAnchor();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinned, holdAnchor, captureAnchor]);

  const onScroll = useCallback(() => {
    measure();
    captureAnchor();
    const el = scrollerRef.current;
    // Not while unread messages remain above: opening on the first loaded
    // one lands inside this zone, and loading on arrival would slide the
    // real boundary in above the reader, out of view. The explicit control
    // continues it instead.
    if (
      el &&
      el.scrollTop < TOP_LOAD_PX &&
      hasOlder &&
      !unreadBeyond &&
      !loadingOlder &&
      positioned.current
    ) {
      onLoadOlder?.();
    }
  }, [measure, captureAnchor, hasOlder, unreadBeyond, loadingOlder, onLoadOlder]);

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
          {loading ? (
            <ConversationSkeleton />
          ) : ordered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8">{empty}</div>
          ) : (
            <>
              {hasOlder ? (
                <div className="flex items-center justify-center gap-2 py-3">
                  <button
                    type="button"
                    onClick={onLoadOlder}
                    disabled={loadingOlder}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs shadow-sm transition-colors disabled:opacity-70',
                      unreadBeyond
                        ? 'border-rose-500/40 text-rose-600 hover:bg-rose-500/5 dark:text-rose-400'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
                    {loadingOlder
                      ? 'Loading earlier messages…'
                      : unreadBeyond
                        ? 'Load earlier unread messages'
                        : 'Load earlier messages'}
                  </button>
                  {unreadBeyond && onMarkAllRead && (
                    <button
                      type="button"
                      onClick={onMarkAllRead}
                      className="rounded-full px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Mark all read
                    </button>
                  )}
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
                        {unreadBeyond
                          ? `${item.count}+ new messages`
                          : item.count === 1
                            ? '1 new message'
                            : `${item.count} new messages`}
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

      {!atBottom && !loading && ordered.length > 0 && (
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

function messageNodes(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
}

function messageNode(scroller: HTMLElement, id: string): HTMLElement | null {
  return messageNodes(scroller).find((node) => node.dataset.messageId === id) ?? null;
}

/**
 * The first message whose bottom is below the top of the view, and where
 * its top sits. Binary search: rows are in document order, so their
 * bottoms only increase, and a long conversation should not measure every
 * row on every scroll event.
 */
function topVisibleMessage(scroller: HTMLElement): { id: string; top: number } | null {
  const nodes = messageNodes(scroller);
  const viewTop = scroller.getBoundingClientRect().top;
  let low = 0;
  let high = nodes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom > viewTop) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (found < 0) return null;
  const node = nodes[found];
  return { id: node.dataset.messageId ?? '', top: node.getBoundingClientRect().top };
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
