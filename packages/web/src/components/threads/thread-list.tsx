'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, MessagesSquare, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AuthorAvatar } from '@/components/conversation/author-avatar';
import { formatShortAgo } from '@/components/conversation/format';
import { hasUnread, type ReadCursorStore } from './read-cursors';
import { previewLine, sbAuthor, type NameFor } from './to-conversation';
import type { SpineIdentity, SpineSession, ThreadSpine } from './thread-types';

export type StatusFilter = 'all' | 'unread' | 'active' | 'closed';

/** The server decides liveness (isSessionLive); lifecycle is the fallback for older payloads. */
export function isSessionLive(session: SpineSession): boolean {
  return session.live ?? (session.lifecycle === 'running' || session.lifecycle === 'generating');
}

export function hasLiveSession(spine: ThreadSpine): boolean {
  return spine.sessions.some(isSessionLive);
}

/** SBs working on the key right now, each once. */
export function liveAgentsOf(spine: ThreadSpine): string[] {
  return [
    ...new Set(spine.sessions.filter(isSessionLive).flatMap((s) => (s.sbSlug ? [s.sbSlug] : []))),
  ];
}

/**
 * Where a spine sits in the work lifecycle:
 * - unannounced: someone is on the key but no thread exists — work begun,
 *   nothing said. The state this page exists to surface.
 * - active: open thread, or any live session on the key.
 * - closed: thread closed and nothing live.
 */
export function spineStatus(spine: ThreadSpine): 'active' | 'unannounced' | 'closed' {
  if (!spine.thread) return 'unannounced';
  if (spine.thread.status === 'closed' && !hasLiveSession(spine)) return 'closed';
  return 'active';
}

export function displayTitle(spine: ThreadSpine): string | null {
  return spine.thread?.title ?? spine.taskGroups[0]?.title ?? null;
}

const TYPE_COLORS: Record<string, string> = {
  pr: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  branch: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  task: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  issue: 'bg-red-500/15 text-red-600 dark:text-red-400',
  spec: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  debug: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  deploy: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
  thread: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
};

export function TypeChip({ identity }: { identity: SpineIdentity | null }) {
  if (!identity?.type) {
    return (
      <span className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium bg-muted text-muted-foreground">
        untyped
      </span>
    );
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
        TYPE_COLORS[identity.type] ?? 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
      )}
      title={identity.pinned ? 'Identity pinned at thread creation' : 'Provisional (no thread yet)'}
    >
      {identity.project ? `${identity.project}:` : ''}
      {identity.type}
      {identity.pinned ? '' : '?'}
    </span>
  );
}

/**
 * A thread's face in the list: one avatar for a single participant, two
 * overlapping ones for a group.
 */
export function ParticipantCluster({
  participants,
  nameFor,
  className,
}: {
  participants: string[];
  nameFor: NameFor;
  className?: string;
}) {
  const authors = participants.map((slug) => sbAuthor(slug, nameFor));
  if (authors.length === 0) {
    return (
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground',
          className
        )}
      >
        <MessagesSquare className="h-4 w-4" />
      </span>
    );
  }
  if (authors.length === 1) {
    return <AuthorAvatar author={authors[0]} size="md" className={cn('m-0.5', className)} />;
  }
  return (
    <span className={cn('relative h-10 w-10 shrink-0', className)}>
      <AuthorAvatar author={authors[0]} size="sm" className="absolute left-0 top-0" />
      <AuthorAvatar
        author={authors[1]}
        size="sm"
        className="absolute bottom-0 right-0 ring-2 ring-background"
      />
      {authors.length > 2 && (
        <span className="absolute -bottom-1 -left-1 rounded-full bg-background px-1 text-[9px] font-semibold text-muted-foreground ring-1 ring-border">
          +{authors.length - 2}
        </span>
      )}
    </span>
  );
}

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
];

export function ThreadList({
  spines,
  selectedKey,
  onSelect,
  cursors,
  nameFor,
  loading,
  error,
  warnings,
}: {
  spines: ThreadSpine[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  cursors: ReadCursorStore;
  nameFor: NameFor;
  loading: boolean;
  error: boolean;
  warnings: string[];
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string>('');

  // Recomputed per render on purpose: cursors move without the spines changing.
  const unreadKeys = new Set(
    spines
      .filter((s) => hasUnread(s.thread?.lastMessage, cursors.cursorFor(s.key)))
      .map((s) => s.key)
  );

  const counts = useMemo(() => {
    const byStatus = { all: spines.length, active: 0, unannounced: 0, closed: 0 };
    const byType = new Map<string, number>();
    for (const spine of spines) {
      byStatus[spineStatus(spine)] += 1;
      const type = spine.identity?.type ?? 'untyped';
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    return { byStatus, byType: [...byType.entries()].sort((a, b) => b[1] - a[1]) };
  }, [spines]);

  const q = search.trim().toLowerCase();
  const filtered = spines.filter((spine) => {
    if (typeFilter && (spine.identity?.type ?? 'untyped') !== typeFilter) return false;
    if (statusFilter === 'unread' && !unreadKeys.has(spine.key)) return false;
    if (
      statusFilter !== 'all' &&
      statusFilter !== 'unread' &&
      spineStatus(spine) !== statusFilter
    ) {
      return false;
    }
    if (q) {
      const haystack = [
        spine.key,
        displayTitle(spine) ?? '',
        spine.thread?.lastMessage?.preview ?? '',
        ...spine.participants,
        ...spine.participants.map(nameFor),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const countFor = (value: StatusFilter): number =>
    value === 'unread' ? unreadKeys.size : counts.byStatus[value];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Threads</h1>
          <span className="text-xs tabular-nums text-muted-foreground">
            {loading ? '' : `${spines.length} threads`}
          </span>
        </div>
        <div className="flex gap-2">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search threads, people, messages"
              aria-label="Search threads"
              className="h-8 w-full rounded-lg border bg-muted/40 pl-8 pr-2 text-sm placeholder:text-muted-foreground focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
          </label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter by key type"
            className="h-8 max-w-[7.5rem] rounded-lg border bg-muted/40 px-2 text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30"
          >
            <option value="">All types</option>
            {counts.byType.map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(({ value, label }) => {
            const count = countFor(value);
            const active = statusFilter === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                aria-pressed={active}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors',
                  active
                    ? 'bg-foreground text-background'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {label}
                {value !== 'all' && count > 0 && (
                  <span
                    className={cn(
                      'tabular-nums',
                      value === 'unread' &&
                        !active &&
                        'font-semibold text-sky-600 dark:text-sky-400'
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Threads">
        {error && (
          <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load threads.
          </div>
        )}
        {loading && <ThreadListSkeleton />}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            {spines.length === 0 ? 'No threads yet.' : 'No threads match.'}
          </div>
        )}
        {filtered.map((spine) => (
          <ThreadRow
            key={spine.key}
            spine={spine}
            selected={spine.key === selectedKey}
            unread={unreadKeys.has(spine.key)}
            nameFor={nameFor}
            onSelect={onSelect}
          />
        ))}
        {warnings.length > 0 && (
          <div className="space-y-1.5 p-3">
            {warnings.map((w) => (
              <div
                key={w}
                className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadRow({
  spine,
  selected,
  unread,
  nameFor,
  onSelect,
}: {
  spine: ThreadSpine;
  selected: boolean;
  unread: boolean;
  nameFor: NameFor;
  onSelect: (key: string) => void;
}) {
  const status = spineStatus(spine);
  const live = hasLiveSession(spine);
  const title = displayTitle(spine);
  const last = spine.thread?.lastMessage;
  const line = last ? previewLine(last, nameFor) : null;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(spine.key)}
      className={cn(
        'relative flex w-full gap-3 px-4 py-3 text-left transition-colors',
        selected ? 'bg-sky-500/10' : 'hover:bg-muted/60',
        status === 'closed' && !selected && 'opacity-75'
      )}
    >
      {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-sky-500" />}
      <ParticipantCluster participants={spine.participants} nameFor={nameFor} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'
            )}
          >
            {title ?? spine.key}
          </span>
          <span
            className={cn(
              'shrink-0 text-[11px] tabular-nums',
              unread ? 'font-semibold text-sky-600 dark:text-sky-400' : 'text-muted-foreground'
            )}
          >
            {formatShortAgo(last?.createdAt ?? spine.lastActivityAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              unread ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {line ? (
              <>
                <span className={cn(unread && 'font-medium')}>{line.sender}:</span> {line.text}
              </>
            ) : (
              <span className="italic">No messages yet</span>
            )}
          </span>
          {unread && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-sky-500" />}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <TypeChip identity={spine.identity} />
          {title && <span className="min-w-0 truncate font-mono">{spine.key}</span>}
          {status === 'closed' && (
            <span className="shrink-0 rounded bg-muted px-1 py-px">closed</span>
          )}
          {live && (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400"
              title="A session is working on this key right now"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              live
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function ThreadListSkeleton() {
  return (
    <div aria-label="Loading threads">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-3 px-4 py-3">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
