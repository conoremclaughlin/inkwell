'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Activity,
  AlertTriangle,
  GitBranch,
  Hash,
  ListTodo,
  MessageSquare,
  MonitorDot,
  Workflow,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

// ─── Types mirroring GET /api/admin/threads ───

interface SpineIdentity {
  project: string | null;
  type: string | null;
  id: string | null;
  pinned: boolean;
}

interface SpineSession {
  id: string;
  agentId: string | null;
  lifecycle: string | null;
  status: string | null;
  phase: string | null;
  relation: 'anchor' | 'active' | 'both';
  updatedAt: string;
  studioId: string | null;
}

interface SpineStudio {
  id: string;
  slug: string | null;
  branch: string;
  agentId: string;
  relation: 'affinity' | 'lease' | 'both';
  leaseAgentId: string | null;
  updatedAt: string;
}

interface SpineGroup {
  id: string;
  title: string;
  status: string | null;
  executionModel: string | null;
  executionPhase: string | null;
  updatedAt: string;
}

interface ThreadSpine {
  key: string;
  identity: SpineIdentity | null;
  thread: {
    title: string | null;
    status: string;
    createdByAgentId: string;
    participants: string[];
    closedAt: string | null;
  } | null;
  sessions: SpineSession[];
  studios: SpineStudio[];
  taskGroups: SpineGroup[];
  participants: string[];
  sources: Array<'thread' | 'session' | 'studio' | 'group'>;
  lastActivityAt: string;
}

interface FeedMeta {
  fetched: number;
  total: number;
  truncated: boolean;
}

interface ThreadsResponse {
  spines: ThreadSpine[];
  meta: {
    threads: FeedMeta;
    sessions: FeedMeta;
    taskGroups: FeedMeta;
    parseUnavailable: boolean;
  };
}

interface ThreadMessagesResponse {
  thread: {
    threadKey: string;
    title: string | null;
    status: string;
    createdByAgentId: string;
    createdAt: string;
    closedAt: string | null;
  } | null;
  messages: Array<{
    id: string;
    senderAgentId: string;
    content: string;
    messageType: string;
    priority: string;
    createdAt: string;
  }>;
}

// ─── Helpers ───

function formatRelativeTime(date: string): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function hasLiveSession(spine: ThreadSpine): boolean {
  return spine.sessions.some((s) => s.lifecycle === 'running' || s.lifecycle === 'generating');
}

type StatusFilter = 'all' | 'active' | 'unannounced' | 'closed';

/**
 * Where a spine sits in the work lifecycle, for filtering:
 * - unannounced: someone is on the key but no thread exists — work begun,
 *   nothing said. The state this page exists to surface.
 * - active: open thread, or any live session on the key.
 * - closed: thread closed and nothing live.
 */
function spineStatus(spine: ThreadSpine): Exclude<StatusFilter, 'all'> {
  if (!spine.thread) return 'unannounced';
  if (spine.thread.status === 'closed' && !hasLiveSession(spine)) return 'closed';
  return 'active';
}

const TYPE_COLORS: Record<string, string> = {
  pr: 'bg-purple-500/15 text-purple-500',
  branch: 'bg-blue-500/15 text-blue-500',
  task: 'bg-amber-500/15 text-amber-600',
  issue: 'bg-red-500/15 text-red-500',
  spec: 'bg-emerald-500/15 text-emerald-600',
  debug: 'bg-orange-500/15 text-orange-500',
  deploy: 'bg-cyan-500/15 text-cyan-600',
  thread: 'bg-slate-500/15 text-slate-500',
};

function TypeChip({ identity }: { identity: SpineIdentity | null }) {
  if (!identity?.type) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
        untyped
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        TYPE_COLORS[identity.type] ?? 'bg-slate-500/15 text-slate-500'
      )}
      title={identity.pinned ? 'Identity pinned at thread creation' : 'Provisional (no thread yet)'}
    >
      {identity.project ? `${identity.project}:` : ''}
      {identity.type}
      {identity.pinned ? '' : '?'}
    </span>
  );
}

function displayTitle(spine: ThreadSpine): string | null {
  return spine.thread?.title ?? spine.taskGroups[0]?.title ?? null;
}

// ─── Page ───

export default function ThreadsPage() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, error } = useApiQuery<ThreadsResponse>(
    ['thread-spines'],
    '/api/admin/threads',
    { refetchInterval: 30000 }
  );

  const spines = useMemo(() => data?.spines ?? [], [data]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const spine of spines) {
      const type = spine.identity?.type ?? 'untyped';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [spines]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return spines.filter((spine) => {
      if (typeFilter && (spine.identity?.type ?? 'untyped') !== typeFilter) return false;
      if (statusFilter !== 'all' && spineStatus(spine) !== statusFilter) return false;
      if (q) {
        const haystack = [spine.key, displayTitle(spine) ?? '', ...spine.participants]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [spines, search, typeFilter, statusFilter]);

  const selected = useMemo(
    () => spines.find((s) => s.key === selectedKey) ?? null,
    [spines, selectedKey]
  );

  const stats = useMemo(() => {
    let active = 0;
    let unannounced = 0;
    let closed = 0;
    for (const spine of spines) {
      const s = spineStatus(spine);
      if (s === 'active') active += 1;
      else if (s === 'unannounced') unannounced += 1;
      else closed += 1;
    }
    return { total: spines.length, active, unannounced, closed };
  }, [spines]);

  const warnings: string[] = [];
  if (data?.meta.threads.truncated) {
    warnings.push(
      `Showing ${data.meta.threads.fetched} of ${data.meta.threads.total} threads — older threads are not listed.`
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

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Threads</h1>
        <p className="text-sm text-muted-foreground">
          Every threadKey the system knows — who is on it, which sessions, where, and what work it
          drives. Keys someone is working but never announced show as “no thread yet”.
        </p>
      </div>

      {warnings.map((w) => (
        <div
          key={w}
          className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {w}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ['Keys', stats.total, 'all'],
            ['Active', stats.active, 'active'],
            ['No thread yet', stats.unannounced, 'unannounced'],
            ['Closed', stats.closed, 'closed'],
          ] as Array<[string, number, StatusFilter]>
        ).map(([label, value, filter]) => (
          <button key={label} type="button" onClick={() => setStatusFilter(filter)}>
            <Card
              className={clsx(
                'transition-colors hover:border-primary/50',
                statusFilter === filter && 'border-primary'
              )}
            >
              <CardContent className="p-3 text-left">
                <div className="text-2xl font-semibold tabular-nums">{value}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search key, title, participant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-64"
        />
        {typeCounts.map(([type, count]) => (
          <button
            key={type}
            type="button"
            onClick={() => setTypeFilter(typeFilter === type ? null : type)}
            className={clsx(
              'rounded-full border px-2.5 py-0.5 text-xs',
              typeFilter === type
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50'
            )}
          >
            {type} <span className="tabular-nums">{count}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load threads.
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-[380px] shrink-0 overflow-y-auto rounded-md border">
          {isLoading && (
            <div className="p-4 text-sm text-muted-foreground">Loading thread spines…</div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No threads match.</div>
          )}
          {filtered.map((spine) => {
            const status = spineStatus(spine);
            const live = hasLiveSession(spine);
            const title = displayTitle(spine);
            return (
              <button
                key={spine.key}
                type="button"
                onClick={() => setSelectedKey(spine.key)}
                className={clsx(
                  'block w-full border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/50',
                  selectedKey === spine.key && 'bg-muted'
                )}
              >
                <div className="flex items-center gap-2">
                  <TypeChip identity={spine.identity} />
                  <span className="truncate font-mono text-xs font-medium">{spine.key}</span>
                  {live && (
                    <span
                      className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-green-500"
                      title="Live session on this key"
                    />
                  )}
                </div>
                {title && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{title}</div>
                )}
                <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  {status === 'unannounced' && (
                    <span className="rounded bg-amber-500/15 px-1 py-0.5 font-medium text-amber-600">
                      no thread yet
                    </span>
                  )}
                  {spine.thread && spine.thread.status === 'closed' && (
                    <span className="rounded bg-muted px-1 py-0.5">closed</span>
                  )}
                  {spine.sources.includes('thread') && <MessageSquare className="h-3 w-3" />}
                  {spine.sources.includes('session') && <MonitorDot className="h-3 w-3" />}
                  {spine.sources.includes('studio') && <GitBranch className="h-3 w-3" />}
                  {spine.sources.includes('group') && <ListTodo className="h-3 w-3" />}
                  <span className="truncate">{spine.participants.join(' · ')}</span>
                  <span className="ml-auto shrink-0">
                    {formatRelativeTime(spine.lastActivityAt)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto rounded-md border">
          {selected ? (
            <SpineDetail spine={selected} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Select a thread to see everything on its key.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Detail pane ───

function SpineDetail({ spine }: { spine: ThreadSpine }) {
  const { data: messagesData, isLoading: messagesLoading } = useApiQuery<ThreadMessagesResponse>(
    ['thread-messages', spine.key],
    `/api/admin/threads/messages?key=${encodeURIComponent(spine.key)}`,
    { enabled: spine.sources.includes('thread') }
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold">{spine.key}</span>
          <TypeChip identity={spine.identity} />
          {spine.thread ? (
            <Badge variant={spine.thread.status === 'open' ? 'default' : 'secondary'}>
              {spine.thread.status}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-500/50 text-amber-600">
              no thread yet
            </Badge>
          )}
        </div>
        {displayTitle(spine) && <div className="mt-1 text-sm">{displayTitle(spine)}</div>}
        <div className="mt-1 text-xs text-muted-foreground">
          {spine.participants.length > 0 && <>Participants: {spine.participants.join(', ')} · </>}
          Last activity {formatRelativeTime(spine.lastActivityAt)}
        </div>
      </div>

      {spine.taskGroups.length > 0 && (
        <section>
          <SectionLabel icon={Workflow} label="Work" />
          <div className="flex flex-col gap-1.5">
            {spine.taskGroups.map((g) => (
              <Link
                key={g.id}
                href={`/missions/${g.id}`}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs hover:border-primary/50"
              >
                <span className="truncate font-medium">{g.title}</span>
                {g.executionModel === 'graph' && (
                  <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-500">
                    graph · {g.executionPhase ?? 'idle'}
                  </span>
                )}
                {g.status && (
                  <span className="ml-auto shrink-0 text-muted-foreground">{g.status}</span>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}

      {spine.sessions.length > 0 && (
        <section>
          <SectionLabel icon={Activity} label={`Sessions (${spine.sessions.length})`} />
          <div className="flex flex-col gap-1.5">
            {spine.sessions.map((s) => (
              <Link
                key={`${s.id}-${s.relation}`}
                href={`/sessions/${s.id}`}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs hover:border-primary/50"
              >
                <span
                  className={clsx(
                    'h-2 w-2 shrink-0 rounded-full',
                    s.lifecycle === 'running' || s.lifecycle === 'generating'
                      ? 'animate-pulse bg-green-500'
                      : 'bg-muted-foreground/40'
                  )}
                />
                <span className="font-medium">{s.agentId ?? 'unknown'}</span>
                {s.phase && <span className="truncate text-muted-foreground">{s.phase}</span>}
                <span
                  className="rounded bg-muted px-1 py-0.5 text-[10px]"
                  title="anchor = routed here at creation · active = current focus"
                >
                  {s.relation}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {formatRelativeTime(s.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {spine.studios.length > 0 && (
        <section>
          <SectionLabel icon={GitBranch} label="Studios" />
          <div className="flex flex-col gap-1.5">
            {spine.studios.map((st) => (
              <div
                key={st.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
              >
                <span className="font-medium">{st.slug ?? st.branch}</span>
                <span className="truncate font-mono text-muted-foreground">{st.branch}</span>
                <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">
                  {st.relation === 'affinity'
                    ? 'dedicated'
                    : `leased by ${st.leaseAgentId ?? st.agentId}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionLabel icon={MessageSquare} label="Conversation" />
        {!spine.sources.includes('thread') ? (
          <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
            No messages on this key yet — work is underway but nothing has been announced.
          </div>
        ) : messagesLoading ? (
          <div className="p-2 text-xs text-muted-foreground">Loading messages…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {(messagesData?.messages ?? []).map((m) => (
              <div key={m.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">{m.senderAgentId}</span>
                  {m.messageType !== 'message' && (
                    <span className="rounded bg-muted px-1 py-0.5">{m.messageType}</span>
                  )}
                  <span className="ml-auto">{formatRelativeTime(m.createdAt)}</span>
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionLabel({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}
