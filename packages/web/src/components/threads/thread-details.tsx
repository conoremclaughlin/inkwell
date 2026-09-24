'use client';

import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  GitBranch,
  Hash,
  History,
  ShieldCheck,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useApiQuery } from '@/lib/api';
import { AuthorAvatar } from '@/components/conversation/author-avatar';
import { formatRelativeTime } from '@/components/conversation/format';
import { EvidenceNodeCard, type GraphEvidenceResponse } from './evidence';
import { sbAuthor, type NameFor } from './to-conversation';
import { displayTitle, isSessionLive, TypeChip } from './thread-list';
import type { ThreadMessagesResponse, ThreadSpine } from './thread-types';

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

/**
 * Everything on a thread's key besides the conversation: the work it
 * drives, the evidence behind its gates, the sessions and studios on it.
 */
export function ThreadDetails({
  spine,
  nameFor,
  onClose,
}: {
  spine: ThreadSpine;
  nameFor: NameFor;
  onClose?: () => void;
}) {
  // Same query as the conversation — shared from the cache, not refetched.
  const { data: messagesData } = useApiQuery<ThreadMessagesResponse>(
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <span className="text-sm font-semibold">Details</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-2">
          {displayTitle(spine) && (
            <h3 className="text-base font-semibold leading-snug">{displayTitle(spine)}</h3>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="break-all font-mono text-xs font-medium">{spine.key}</span>
            <TypeChip identity={spine.identity} />
          </div>
          {spine.thread?.summary && (
            <p className="text-sm leading-relaxed text-foreground/90">{spine.thread.summary}</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {spine.thread ? (
                <span title="Conversation status — whether this inbox thread is open or closed, not the state of the PR/issue it references">
                  thread {spine.thread.status}
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">no thread yet</span>
              )}
            </dd>
            {spine.thread && (
              <>
                <dt className="text-muted-foreground">Started by</dt>
                <dd>{nameFor(spine.thread.createdBySlug)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Last activity</dt>
            <dd>{formatRelativeTime(spine.lastActivityAt)}</dd>
          </dl>
        </section>

        {spine.participants.length > 0 && (
          <section>
            <SectionLabel icon={Users} label={`Participants (${spine.participants.length})`} />
            <div className="flex flex-col gap-1">
              {spine.participants.map((slug) => (
                <div key={slug} className="flex items-center gap-2 text-sm">
                  <AuthorAvatar author={sbAuthor(slug, nameFor)} size="sm" />
                  <span className="font-medium">{nameFor(slug)}</span>
                  {nameFor(slug) !== slug && (
                    <span className="text-xs text-muted-foreground">@{slug}</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

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
                    <span className="shrink-0 whitespace-nowrap rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-500">
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
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {group.title}
                    </div>
                  )}
                  {group.nodes.map((node) => (
                    <EvidenceNodeCard key={node.id} node={node} />
                  ))}
                </div>
              ))}
              {evidenceData?.meta?.groups?.truncated && (
                <Truncated>
                  Showing the newest {evidenceData.meta.groups.fetched} of{' '}
                  {evidenceData.meta.groups.total} workflow graphs on this key.
                </Truncated>
              )}
              {evidenceData?.meta?.events?.truncated && (
                <Truncated>
                  Showing the oldest {evidenceData.meta.events.fetched} of{' '}
                  {evidenceData.meta.events.total} ledger events.
                </Truncated>
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
                      isSessionLive(s) ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40'
                    )}
                  />
                  <span className="font-medium">{s.sbSlug ? nameFor(s.sbSlug) : 'unknown'}</span>
                  {s.phase && <span className="truncate text-muted-foreground">{s.phase}</span>}
                  <span
                    className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]"
                    title={RELATION_TOOLTIP}
                  >
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
                      : `leased by ${st.leaseSlug ?? st.sbSlug}`}
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
                  <span className="font-medium">
                    {h.slug ?? h.branch ?? h.studioId.slice(0, 8)}
                  </span>
                  {h.slug && h.branch && (
                    <span className="truncate font-mono text-muted-foreground">{h.branch}</span>
                  )}
                  <span className="truncate text-muted-foreground">{h.agents.join(' · ')}</span>
                  <span
                    className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]"
                    title={`Last lease event: ${h.lastEvent} · ${new Date(h.lastAt).toLocaleString()}`}
                  >
                    {h.status === 'cleaned' ? 'closed' : h.lastEvent} ·{' '}
                    {formatRelativeTime(h.lastAt)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

function Truncated({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      {children}
    </div>
  );
}
