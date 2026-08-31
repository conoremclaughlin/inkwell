'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  GitBranch,
  Hash,
  History,
  ListTodo,
  MessageSquare,
  MonitorDot,
  ShieldCheck,
  Workflow,
  Wrench,
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

interface StudioHistoryItem {
  studioId: string;
  slug: string | null;
  branch: string | null;
  status: string;
  agents: string[];
  firstAt: string;
  lastAt: string;
  lastEvent: string;
}

interface ThreadMessagesResponse {
  studioHistory?: StudioHistoryItem[];
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
  meta?: FeedMeta;
}

// ─── Types mirroring GET /api/admin/threads/graph-evidence ───

type EvidenceField =
  | { label: string; kind: 'text'; text: string }
  | { label: string; kind: 'sha'; sha: string }
  | { label: string; kind: 'link'; href: string; text: string }
  | { label: string; kind: 'chips'; items: string[] }
  | { label: string; kind: 'media'; path: string; mediaType: 'image' | 'video' | 'pdf' }
  | { label: string; kind: 'group'; fields: EvidenceField[] }
  | { label: string; kind: 'json'; json: string };

interface ReasonPart {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

interface EvidenceGateEvent {
  event: string;
  attempt: number;
  actorAgentSlug: string | null;
  actorIsUser: boolean;
  reasonParts: ReasonPart[];
  evidenceFields: EvidenceField[];
  createdAt: string;
}

interface EvidenceAttempt {
  attempt: number;
  verdict: 'passed' | 'failed' | null;
  events: EvidenceGateEvent[];
}

interface EvidenceNode {
  id: string;
  title: string;
  nodeSlug: string | null;
  taskType: string;
  status: string | null;
  outcome: string | null;
  gateState: string | null;
  gateAttempt: number | null;
  assigneeAgentSlug: string | null;
  assigneeIsUser: boolean;
  attempts: EvidenceAttempt[];
}

interface EvidenceGroup {
  id: string;
  title: string;
  status: string | null;
  executionModel: string | null;
  executionPhase: string | null;
  nodes: EvidenceNode[];
}

interface GraphEvidenceResponse {
  groups: EvidenceGroup[];
  meta?: {
    groups: { fetched: number; total: number; truncated?: boolean };
    events?: { fetched: number; total: number; truncated: boolean };
  };
}

// ─── Helpers ───

/**
 * Session→key relations, in words a reader shouldn't have to decode:
 * "routed here" = this key is the session's immutable routing anchor (where
 * inbox triggers landed it); "working now" = the session's mutable current
 * focus; both when they coincide. These are session facts, not studios.
 */
const RELATION_LABELS: Record<'anchor' | 'active' | 'both', string> = {
  anchor: 'routed here',
  active: 'working now',
  both: 'routed · working',
};

const RELATION_TOOLTIP =
  'Session relation to this key — "routed here": the key this session was originally routed/spawned for; "working now": the session\'s current focus (its activeThreadKey)';

function formatDayLabel(date: string): string {
  const d = new Date(date);
  const today = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(today) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function formatClockTime(date: string): string {
  return new Date(date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

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

  return (
    <div className="flex h-full flex-col gap-4 p-0 md:p-6">
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
          className="h-8 w-full sm:w-64"
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

      {/* Mobile drills into the detail pane; desktop shows both side by side. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <div
          className={clsx(
            'w-full overflow-y-auto rounded-md border md:block md:w-[380px] md:shrink-0',
            selectedKey && 'hidden'
          )}
        >
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

        <div
          className={clsx(
            'min-w-0 flex-1 overflow-y-auto rounded-md border md:block',
            !selectedKey && 'hidden'
          )}
        >
          {selected ? (
            <SpineDetail spine={selected} onBack={() => setSelectedKey(null)} />
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

function SpineDetail({ spine, onBack }: { spine: ThreadSpine; onBack: () => void }) {
  // Always fetched — a key nobody ever messaged about can still have studio
  // history worth showing (the endpoint answers { thread: null } for those).
  const { data: messagesData, isLoading: messagesLoading } = useApiQuery<ThreadMessagesResponse>(
    ['thread-messages', spine.key],
    `/api/admin/threads/messages?key=${encodeURIComponent(spine.key)}`
  );

  // The evidence trail behind this key's workflow graphs — verdicts,
  // remediation reasons, and attached artifacts, straight from the
  // gate-event ledger. Groups with no graph answer { groups: [] }.
  const { data: evidenceData } = useApiQuery<GraphEvidenceResponse>(
    ['thread-graph-evidence', spine.key],
    `/api/admin/threads/graph-evidence?key=${encodeURIComponent(spine.key)}`
  );
  const evidenceGroups = (evidenceData?.groups ?? []).filter((group) => group.nodes.length > 0);

  // History complements the live STUDIOS section rather than repeating it:
  // only studios no longer in the live feed (closed ephemerals, released
  // holds) appear here. This is how "which studio did the review happen in"
  // stays answerable after the reviewer cleans up.
  const liveStudioIds = new Set(spine.studios.map((st) => st.id));
  const pastStudios = (messagesData?.studioHistory ?? []).filter(
    (h) => !liveStudioIds.has(h.studioId)
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground md:hidden"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        All threads
      </button>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold">{spine.key}</span>
          <TypeChip identity={spine.identity} />
          {spine.thread ? (
            <Badge
              variant={spine.thread.status === 'open' ? 'default' : 'secondary'}
              title="Conversation status — whether this inbox thread is open or closed, not the state of the PR/issue it references"
            >
              thread {spine.thread.status}
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

      {evidenceGroups.length > 0 && (
        <section>
          <SectionLabel icon={ShieldCheck} label="Evidence" />
          <div className="flex flex-col gap-2">
            {evidenceGroups.map((group) => (
              <div key={group.id} className="flex flex-col gap-1.5">
                {evidenceGroups.length > 1 && (
                  <div className="text-[11px] font-medium text-muted-foreground">{group.title}</div>
                )}
                {group.nodes.map((node) => (
                  <EvidenceNodeCard key={node.id} node={node} />
                ))}
              </div>
            ))}
            {evidenceData?.meta?.groups?.truncated && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Showing the newest {evidenceData.meta.groups.fetched} of{' '}
                {evidenceData.meta.groups.total} workflow graphs on this key.
              </div>
            )}
            {evidenceData?.meta?.events?.truncated && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Showing the oldest {evidenceData.meta.events.fetched} of{' '}
                {evidenceData.meta.events.total} ledger events.
              </div>
            )}
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
                <span className="rounded bg-muted px-1 py-0.5 text-[10px]" title={RELATION_TOOLTIP}>
                  {RELATION_LABELS[s.relation]}
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

      {pastStudios.length > 0 && (
        <section>
          <SectionLabel icon={History} label="Past studios" />
          <div className="flex flex-col gap-1.5">
            {pastStudios.map((h) => (
              <div
                key={h.studioId}
                className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs opacity-70"
              >
                <span className="font-medium">{h.slug ?? h.branch ?? h.studioId.slice(0, 8)}</span>
                {h.slug && h.branch && (
                  <span className="truncate font-mono text-muted-foreground">{h.branch}</span>
                )}
                <span className="truncate text-muted-foreground">{h.agents.join(' · ')}</span>
                <span
                  className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]"
                  title={`Last lease event: ${h.lastEvent} · ${new Date(h.lastAt).toLocaleString()}`}
                >
                  {h.status === 'cleaned' ? 'closed' : h.lastEvent} · {formatRelativeTime(h.lastAt)}
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
            {messagesData?.meta?.truncated && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Showing the latest {messagesData.meta.fetched} of {messagesData.meta.total}{' '}
                messages.
              </div>
            )}
            {(messagesData?.messages ?? []).map((m, i, all) => {
              const prev = i > 0 ? all[i - 1] : null;
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              return (
                <div key={m.id} className="flex flex-col gap-2">
                  {newDay && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {formatDayLabel(m.createdAt)}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <div className="rounded-md border px-3 py-2">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground">{m.senderAgentId}</span>
                      {m.messageType !== 'message' && (
                        <span className="rounded bg-muted px-1 py-0.5">{m.messageType}</span>
                      )}
                      <span className="ml-auto" title={new Date(m.createdAt).toLocaleString()}>
                        {formatClockTime(m.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
                      {m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content}
                    </div>
                  </div>
                </div>
              );
            })}
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

// ─── Evidence rendering ───

const NODE_STATE_COLORS: Record<string, string> = {
  passed: 'bg-emerald-500/15 text-emerald-600',
  completed: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-red-500/15 text-red-500',
  blocked: 'bg-red-500/15 text-red-500',
  open: 'bg-amber-500/15 text-amber-600',
  in_progress: 'bg-blue-500/15 text-blue-500',
  not_ready: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground',
};

/** The single state chip a node shows: gate state for gates, status for work. */
function nodeState(node: EvidenceNode): string {
  if (node.taskType === 'verification') return node.gateState ?? 'not_ready';
  return node.status ?? 'pending';
}

const EVENT_LABELS: Record<string, string> = {
  opened: 'gate opened',
  scheduled: 'scheduled',
  claimed: 'claimed',
  claim_released: 'released',
  claim_reclaimed: 'claim reclaimed',
  retry_requested: 'retry requested',
  reassigned: 'reassigned',
  passed: 'passed',
  failed: 'failed',
};

function EvidenceNodeCard({ node }: { node: EvidenceNode }) {
  const isGate = node.taskType === 'verification';
  const NodeIcon = isGate ? ShieldCheck : Wrench;
  const state = nodeState(node);
  const totalAttempts = node.attempts.length;

  return (
    <div className="rounded-md border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <NodeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{node.title}</span>
        <span
          className={clsx(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            NODE_STATE_COLORS[state] ?? 'bg-muted text-muted-foreground'
          )}
        >
          {state.replace('_', ' ')}
        </span>
        {isGate && totalAttempts > 1 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {totalAttempts} attempts
          </span>
        )}
        {node.assigneeAgentSlug && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            assignee {node.assigneeAgentSlug}
          </span>
        )}
        {node.assigneeIsUser && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">assignee: you</span>
        )}
      </div>

      {node.attempts.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {node.attempts.map((attempt) => (
            <div key={attempt.attempt} className="flex flex-col gap-1">
              {(totalAttempts > 1 || attempt.verdict) && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {totalAttempts > 1 && (
                    <span className="font-medium uppercase tracking-wide">
                      Attempt {attempt.attempt}
                    </span>
                  )}
                  {attempt.verdict && (
                    <span
                      className={clsx(
                        'rounded px-1 py-0.5 font-medium',
                        NODE_STATE_COLORS[attempt.verdict]
                      )}
                    >
                      {attempt.verdict}
                    </span>
                  )}
                </div>
              )}
              {attempt.events.map((gateEvent, eventIndex) => (
                <GateEventRow key={`${gateEvent.createdAt}-${eventIndex}`} gateEvent={gateEvent} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GateEventRow({ gateEvent }: { gateEvent: EvidenceGateEvent }) {
  const isVerdict = gateEvent.event === 'passed' || gateEvent.event === 'failed';
  const isRemediation = gateEvent.event === 'retry_requested';
  const actor = gateEvent.actorIsUser ? 'you' : gateEvent.actorAgentSlug;
  const clock = (
    <span
      className="ml-auto shrink-0 text-[10px] text-muted-foreground"
      title={new Date(gateEvent.createdAt).toLocaleString()}
    >
      {formatDayLabel(gateEvent.createdAt)} {formatClockTime(gateEvent.createdAt)}
    </span>
  );

  // Lifecycle events stay one quiet line; verdicts and remediations carry
  // the story and get room for their reasons and evidence.
  if (!isVerdict && !isRemediation) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{EVENT_LABELS[gateEvent.event] ?? gateEvent.event}</span>
        {actor && <span>· {actor}</span>}
        {gateEvent.reasonParts.length > 0 && (
          <span className="truncate">
            · <ReasonText parts={gateEvent.reasonParts} />
          </span>
        )}
        {clock}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'rounded-md border px-2.5 py-2',
        gateEvent.event === 'failed' && 'border-red-500/30 bg-red-500/5',
        gateEvent.event === 'passed' && 'border-emerald-500/30 bg-emerald-500/5',
        isRemediation && 'border-dashed'
      )}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={clsx(
            'font-medium',
            gateEvent.event === 'failed' && 'text-red-500',
            gateEvent.event === 'passed' && 'text-emerald-600'
          )}
        >
          {EVENT_LABELS[gateEvent.event] ?? gateEvent.event}
        </span>
        {actor && <span className="text-muted-foreground">by {actor}</span>}
        {clock}
      </div>
      {gateEvent.reasonParts.length > 0 && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
          <ReasonText parts={gateEvent.reasonParts} />
        </div>
      )}
      {gateEvent.evidenceFields.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {gateEvent.evidenceFields.map((field, fieldIndex) => (
            <EvidenceFieldView key={`${field.label}-${fieldIndex}`} field={field} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReasonText({ parts }: { parts: ReasonPart[] }) {
  return (
    <>
      {parts.map((part, partIndex) =>
        part.kind === 'link' && part.href ? (
          <a
            key={partIndex}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline-offset-2 hover:underline"
          >
            {part.text}
          </a>
        ) : (
          <span key={partIndex}>{part.text}</span>
        )
      )}
    </>
  );
}

function mediaUrl(evidencePath: string): string {
  return `/api/admin/media?path=${encodeURIComponent(evidencePath)}`;
}

function EvidenceFieldView({ field, nested }: { field: EvidenceField; nested?: boolean }) {
  const label = (
    <span className="w-28 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
      {field.label}
    </span>
  );

  switch (field.kind) {
    case 'sha':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]" title={field.sha}>
            {field.sha.slice(0, 12)}
          </span>
        </div>
      );
    case 'link':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <a
            href={field.href}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[11px] text-primary underline-offset-2 hover:underline"
            title={field.href}
          >
            {field.text}
          </a>
        </div>
      );
    case 'chips':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <span className="flex flex-wrap gap-1">
            {field.items.map((item, itemIndex) => (
              <span key={itemIndex} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                {item}
              </span>
            ))}
          </span>
        </div>
      );
    case 'media':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          <MediaPreview path={field.path} mediaType={field.mediaType} />
        </div>
      );
    case 'group':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          {field.fields.map((innerField, innerIndex) => (
            <EvidenceFieldView
              key={`${innerField.label}-${innerIndex}`}
              field={innerField}
              nested
            />
          ))}
        </div>
      );
    case 'json':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          <pre className="overflow-x-auto rounded bg-muted p-2 text-[10px]">{field.json}</pre>
        </div>
      );
    default:
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          {/* min-w-0 lets the value shrink inside the flex row; break-all
              handles unbroken tokens like github:owner/repo#547@sha. */}
          <span className="min-w-0 break-all text-[11px]">{field.text}</span>
        </div>
      );
  }
}

/**
 * Inline preview for a file referenced by evidence, served through the
 * allowlisted media endpoint. A missing/expired file degrades to the bare
 * path (the reference is still information) instead of a broken tile.
 */
function MediaPreview({ path, mediaType }: { path: string; mediaType: 'image' | 'video' | 'pdf' }) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(path);

  if (failed || mediaType === 'pdf') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={clsx(
          'break-all font-mono text-[10px] underline-offset-2 hover:underline',
          failed ? 'text-muted-foreground' : 'text-primary'
        )}
        title={failed ? 'File not available — showing the recorded path' : 'Open'}
      >
        {path}
      </a>
    );
  }

  if (mediaType === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-64 max-w-full rounded-md border"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" title={path}>
      {/* eslint-disable-next-line @next/next/no-img-element -- authed same-origin endpoint; next/image cannot optimize it */}
      <img
        src={url}
        alt={path}
        loading="lazy"
        className="max-h-64 max-w-full rounded-md border object-contain"
        onError={() => setFailed(true)}
      />
    </a>
  );
}
