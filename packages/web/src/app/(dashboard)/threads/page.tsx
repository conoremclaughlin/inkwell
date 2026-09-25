'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import { getSelectedWorkspaceId, subscribeSelectedWorkspace } from '@/lib/workspace-selection';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useReadCursors } from '@/components/threads/read-cursors';
import { ThreadConversation } from '@/components/threads/thread-conversation';
import { ThreadDetails } from '@/components/threads/thread-details';
import { ThreadList } from '@/components/threads/thread-list';
import type { ThreadsResponse } from '@inklabs/shared/stories/threads-api';
import { isConversation } from '@inklabs/shared/stories/thread-browsing';
import { nameLookup } from '@inklabs/shared/stories/thread-viewing';

const DETAILS_STORAGE_KEY = 'ink.threads.details-open';
/** Wide enough for list, conversation, and details side by side (Tailwind's xl). */
const DETAILS_COLUMN_QUERY = '(min-width: 1280px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(DETAILS_STORAGE_KEY) === '1');
    } catch {
      // Storage unavailable: the panel starts closed.
    }
  }, []);
  const update = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(DETAILS_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Remembered for this visit only.
    }
  }, []);
  return [open, update];
}

export default function ThreadsPage() {
  return (
    <Suspense>
      <ThreadsChat />
    </Suspense>
  );
}

/**
 * Threads as a chat: every threadKey in a list on the left, the selected
 * one's conversation in the middle, and everything else on its key — work,
 * evidence, sessions, studios — in a details panel on the right. The
 * selection lives in the URL (?key=), so a thread can be linked to and
 * survives a reload. On a phone the list and the conversation take turns.
 */
function ThreadsChat() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedKey = searchParams.get('key');

  const cursors = useReadCursors();
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const detailsAsColumn = useMediaQuery(DETAILS_COLUMN_QUERY);

  const { data, isLoading, error } = useApiQuery<ThreadsResponse>(
    ['thread-spines'],
    '/api/admin/threads',
    { refetchInterval: 15_000 }
  );
  // The same identities every dashboard page reads; names SBs in messages.
  const { data: identities } = useApiQuery<{
    individuals: Array<{ sbSlug: string; name?: string | null }>;
  }>(['individuals'], '/api/admin/individuals', { staleTime: 5 * 60_000 });
  const nameFor = useMemo(() => nameLookup(identities?.individuals), [identities]);

  const spines = useMemo(() => data?.spines ?? [], [data]);
  // The list is conversations. A key only a session, studio or task group
  // references has nothing to read yet; it stays reachable by link.
  const threads = useMemo(() => spines.filter(isConversation), [spines]);
  const selected = useMemo(
    () => spines.find((spine) => spine.key === selectedKey) ?? null,
    [spines, selectedKey]
  );
  // The same key can be another thread in another workspace, so an open
  // conversation belongs to one workspace and starts over on a switch.
  const workspaceId = useSyncExternalStore(
    subscribeSelectedWorkspace,
    getSelectedWorkspaceId,
    () => null
  );

  const select = useCallback(
    (key: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (key) params.set('key', key);
      else params.delete('key');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const warnings: string[] = [];
  if (data?.meta.threads.truncated) {
    warnings.push(
      `Showing ${data.meta.threads.fetched} of ${data.meta.threads.total} threads — older conversations without live sessions, leases, or task groups are not listed.`
    );
  }
  if (data?.meta.sessions.truncated) {
    warnings.push(
      `Showing ${data.meta.sessions.fetched} of ${data.meta.sessions.total} keyed sessions — older session activity may be missing.`
    );
  }
  if (data?.meta.taskGroups.truncated) {
    warnings.push(
      `Showing ${data.meta.taskGroups.fetched} of ${data.meta.taskGroups.total} keyed task groups.`
    );
  }
  if (data?.meta.parseUnavailable) {
    warnings.push('Project registry unavailable — provisional key identities are not shown.');
  }

  const conversationShown = selectedKey !== null;

  return (
    // Bleeds to the edges of the dashboard's padded main, and fills it.
    <div className="-m-4 flex h-[calc(100%+2rem)] overflow-hidden bg-background md:-m-8 md:h-[calc(100%+4rem)]">
      <aside
        className={
          conversationShown
            ? 'hidden w-[340px] shrink-0 flex-col border-r bg-muted/20 md:flex lg:w-[360px]'
            : 'flex w-full shrink-0 flex-col border-r bg-muted/20 md:w-[340px] lg:w-[360px]'
        }
      >
        <ThreadList
          spines={threads}
          selectedKey={selectedKey}
          onSelect={select}
          cursors={cursors}
          nameFor={nameFor}
          loading={isLoading}
          error={!!error}
          warnings={warnings}
        />
      </aside>

      <section
        className={
          conversationShown
            ? 'flex min-w-0 flex-1 flex-col'
            : 'hidden min-w-0 flex-1 flex-col md:flex'
        }
      >
        {selected ? (
          <ThreadConversation
            key={JSON.stringify([workspaceId, selected.key])}
            workspaceId={workspaceId}
            spine={selected}
            nameFor={nameFor}
            cursors={cursors}
            onBack={() => select(null)}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen(!detailsOpen)}
          />
        ) : (
          <NoConversation
            state={
              selectedKey && !isLoading
                ? 'missing'
                : threads.length === 0 && !isLoading
                  ? 'empty'
                  : 'idle'
            }
            onBack={() => select(null)}
          />
        )}
      </section>

      {selected && detailsOpen && detailsAsColumn && (
        <aside className="flex w-[340px] shrink-0 flex-col border-l">
          <ThreadDetails
            spine={selected}
            workspaceId={workspaceId}
            nameFor={nameFor}
            onClose={() => setDetailsOpen(false)}
          />
        </aside>
      )}
      {selected && !detailsAsColumn && (
        <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
          <SheetContent side="right" className="flex w-full max-w-sm flex-col p-0 sm:max-w-sm">
            <SheetTitle className="sr-only">Thread details</SheetTitle>
            <ThreadDetails spine={selected} workspaceId={workspaceId} nameFor={nameFor} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function NoConversation({
  state,
  onBack,
}: {
  state: 'idle' | 'empty' | 'missing';
  onBack: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/15 to-violet-500/15">
          <MessagesSquare className="h-6 w-6 text-sky-600 dark:text-sky-400" />
        </div>
        {state === 'missing' ? (
          <>
            <p className="mt-4 text-sm font-medium">That thread isn’t in the list</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              It may be older than the newest window of threads, or the key may be mistyped.
            </p>
            <button
              type="button"
              onClick={onBack}
              className="mt-3 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              Back to all threads
            </button>
          </>
        ) : (
          <>
            <p className="mt-4 text-sm font-medium">
              {state === 'empty' ? 'No threads yet' : 'Pick a thread'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Every conversation between you and the SBs is on the left, newest activity first.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
