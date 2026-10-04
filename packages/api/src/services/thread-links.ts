/**
 * Thread links: a thread names another thread, or a library artifact, as
 * related to it (thread:thread-links, migration 20261004085434).
 *
 * A link is one directed edge, stored once from the thread that made it and
 * read both ways: the source lists it under `linksTo`, the target under
 * `linkedFrom`. A thread target is a key, resolved to its row when read, so a
 * link can name a thread that has no conversation yet. An artifact target is
 * the artifact's id, resolved through URI aliases when the link is written.
 *
 * One convention join: the thread `spec:<slug>` and the artifact
 * `ink://specs/<slug>` are the same subject, so reads treat a link to either
 * as a link to both. Nothing is written for it.
 */

import type { DataComposer } from '../data/composer';
import { resolveSbsByIds } from './principals';
import { classifyIdentityById } from './inklings/inkling-turn-gate';

type SupabaseClient = ReturnType<DataComposer['getClient']>;
// thread_links is not in the generated types until they are regenerated
// after the migration is applied.
const linksTable = (supabase: SupabaseClient) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from('thread_links');

/**
 * The relations link_thread accepts. Validated here, not by a DB CHECK.
 * `album` is reserved for the media path to write when albums land
 * (spec:thread-media): a system-written link from a thread to its album, which
 * link_thread does not take.
 */
export const THREAD_LINK_RELATIONS = ['relates', 'implements', 'continues', 'supersedes'] as const;
export type ThreadLinkRelation = (typeof THREAD_LINK_RELATIONS)[number];

export const THREAD_LINK_NOTE_MAX = 280;

/** How many links each direction carries in a header (get_thread_messages). */
export const THREAD_LINK_HEADER_MAX = 20;

const THREAD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*:[^\s]+$/;
const ARTIFACT_URI_PREFIX = 'ink://';

export type LinkTarget = { kind: 'thread'; threadKey: string } | { kind: 'artifact'; uri: string };

/**
 * Read a link target as a caller wrote it: an `ink://` URI names a library
 * artifact, anything else must be a thread key. Returns an error message
 * rather than throwing so the tool can answer `success: false` with it.
 */
export function parseLinkTarget(raw: string): LinkTarget | { error: string } {
  const value = raw.trim();
  if (value.startsWith(ARTIFACT_URI_PREFIX)) {
    if (value.length === ARTIFACT_URI_PREFIX.length) {
      return { error: `Not an artifact URI: "${raw}"` };
    }
    return { kind: 'artifact', uri: value };
  }
  // `https://…` has the type:identifier shape. Stored as a thread key it would
  // be a "no thread yet" key that no thread can ever have.
  if (value.includes('://')) {
    return {
      error: `Web links are not link targets: "${raw}". Link a thread key or an ink:// URI; put a web link in the message text.`,
    };
  }
  if (value.length < 3 || value.length > 200 || !THREAD_KEY_PATTERN.test(value)) {
    return {
      error: `Not a thread key or ink:// URI: "${raw}". A thread key looks like "pr:701" or "spec:live-agent-surfaces".`,
    };
  }
  // Stored as written. In-repo `pr:701` and `inkwell:pr:701` are two keys
  // here, as everywhere else, until key-schemes decision 4 settles which
  // spelling is canonical; folding them now would decide it in this table.
  return { kind: 'thread', threadKey: value };
}

const SPEC_THREAD_PREFIX = 'spec:';
const SPEC_URI_PREFIX = 'ink://specs/';

/**
 * The other half of a spec's identity: `spec:<slug>` ↔ `ink://specs/<slug>`.
 * Only the unprefixed form joins. A project-prefixed key (`inktrade:spec:x`)
 * names a spec in another repo, and the library has no per-project URI to
 * pair it with.
 */
export function specTwin(target: LinkTarget): LinkTarget | null {
  if (target.kind === 'thread') {
    if (!target.threadKey.startsWith(SPEC_THREAD_PREFIX)) return null;
    const slug = target.threadKey.slice(SPEC_THREAD_PREFIX.length);
    return slug && !slug.includes(':')
      ? { kind: 'artifact', uri: `${SPEC_URI_PREFIX}${slug}` }
      : null;
  }
  if (!target.uri.startsWith(SPEC_URI_PREFIX)) return null;
  const slug = target.uri.slice(SPEC_URI_PREFIX.length);
  return slug && !slug.includes('/')
    ? { kind: 'thread', threadKey: `${SPEC_THREAD_PREFIX}${slug}` }
    : null;
}

export interface ThreadLinkRow {
  id: string;
  workspace_id: string;
  source_thread_id: string;
  target_kind: 'thread' | 'artifact';
  target_thread_key: string | null;
  target_artifact_id: string | null;
  target_ref: string;
  relation: string;
  note: string | null;
  origin: 'explicit' | 'send' | 'mention';
  source_message_id: string | null;
  linked_by_kind: 'sb' | 'user' | 'system';
  linked_by_sb_id: string | null;
  linked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A resolved target, ready to write: an artifact is its id by now. */
export type ResolvedLinkTarget =
  | { kind: 'thread'; threadKey: string }
  | { kind: 'artifact'; artifactId: string };

export interface ThreadLinkWrite {
  workspaceId: string;
  sourceThreadId: string;
  target: ResolvedLinkTarget;
  /** Omitted on a re-link keeps the stored value: undefined is "not provided". */
  relation?: ThreadLinkRelation;
  /** null clears the note; undefined keeps it. */
  note?: string | null;
  origin: 'explicit' | 'send';
  sourceMessageId?: string | null;
  linkedBy: { kind: 'sb'; sbId: string } | { kind: 'user'; userId: string } | { kind: 'system' };
}

function linkRow(write: ThreadLinkWrite): Record<string, unknown> {
  const row: Record<string, unknown> = {
    workspace_id: write.workspaceId,
    source_thread_id: write.sourceThreadId,
    target_kind: write.target.kind,
    target_thread_key: write.target.kind === 'thread' ? write.target.threadKey : null,
    target_artifact_id: write.target.kind === 'artifact' ? write.target.artifactId : null,
    origin: write.origin,
    linked_by_kind: write.linkedBy.kind,
    linked_by_sb_id: write.linkedBy.kind === 'sb' ? write.linkedBy.sbId : null,
    linked_by_user_id: write.linkedBy.kind === 'user' ? write.linkedBy.userId : null,
  };
  if (write.relation !== undefined) row.relation = write.relation;
  if (write.note !== undefined) row.note = write.note;
  if (write.sourceMessageId !== undefined) row.source_message_id = write.sourceMessageId;
  return row;
}

const LINK_CONFLICT_TARGET = 'source_thread_id,target_kind,target_ref';

/**
 * Write a link only if the pair is not linked yet (ON CONFLICT DO NOTHING).
 * Used for links that arrive with a message: a send naming a target the
 * thread already links must not overwrite the relation, note and author
 * someone chose with link_thread. Returns the row when one was written, null
 * when the pair was already linked.
 */
export async function insertThreadLinkIfAbsent(
  supabase: SupabaseClient,
  write: ThreadLinkWrite
): Promise<ThreadLinkRow | null> {
  const { data, error } = await linksTable(supabase)
    .upsert(linkRow(write), { onConflict: LINK_CONFLICT_TARGET, ignoreDuplicates: true })
    .select('*');
  if (error) {
    throw new Error(`Failed to write thread link: ${error.message}`);
  }
  const rows = (data ?? []) as ThreadLinkRow[];
  return rows[0] ?? null;
}

/**
 * Write a link, or update the one already there for the same source and
 * target. One statement: INSERT ... ON CONFLICT on the
 * (source_thread_id, target_kind, target_ref) constraint, so two SBs linking
 * the same pair at once leave one row.
 *
 * Optional fields are left out of the payload when not provided, so a re-link
 * without a relation keeps the stored relation instead of resetting it.
 */
export async function upsertThreadLink(
  supabase: SupabaseClient,
  write: ThreadLinkWrite
): Promise<ThreadLinkRow> {
  const { data, error } = await linksTable(supabase)
    .upsert(linkRow(write), { onConflict: LINK_CONFLICT_TARGET })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to write thread link: ${error?.message ?? 'no row returned'}`);
  }
  return data as ThreadLinkRow;
}

/** Remove one link. Returns how many rows went (0 or 1). */
export async function deleteThreadLink(
  supabase: SupabaseClient,
  sourceThreadId: string,
  target: ResolvedLinkTarget
): Promise<number> {
  const ref = target.kind === 'thread' ? target.threadKey : target.artifactId;
  const { data, error } = await linksTable(supabase)
    .delete()
    .eq('source_thread_id', sourceThreadId)
    .eq('target_kind', target.kind)
    .eq('target_ref', ref)
    .select('id');
  if (error) {
    throw new Error(`Failed to remove thread link: ${error.message}`);
  }
  return (data ?? []).length;
}

/** Links a thread makes, newest first. */
export async function listLinksFrom(
  supabase: SupabaseClient,
  sourceThreadId: string
): Promise<ThreadLinkRow[]> {
  const { data, error } = await linksTable(supabase)
    .select('*')
    .eq('source_thread_id', sourceThreadId)
    .order('updated_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to list thread links: ${error.message}`);
  }
  return (data ?? []) as ThreadLinkRow[];
}

/**
 * Links naming a subject, from any thread in the workspace, newest first.
 * The subject is a thread key, an artifact id, or both (a spec and its
 * thread). Two queries rather than one `.or()`, so neither value is spliced
 * into a PostgREST filter string.
 */
export async function listLinksTo(
  supabase: SupabaseClient,
  workspaceId: string,
  subject: { threadKey?: string | null; artifactId?: string | null }
): Promise<ThreadLinkRow[]> {
  const rows: ThreadLinkRow[] = [];
  if (subject.threadKey) {
    const { data, error } = await linksTable(supabase)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('target_kind', 'thread')
      .eq('target_thread_key', subject.threadKey);
    if (error) throw new Error(`Failed to list links to ${subject.threadKey}: ${error.message}`);
    rows.push(...((data ?? []) as ThreadLinkRow[]));
  }
  if (subject.artifactId) {
    const { data, error } = await linksTable(supabase)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('target_kind', 'artifact')
      .eq('target_artifact_id', subject.artifactId);
    if (error) throw new Error(`Failed to list links to artifact: ${error.message}`);
    rows.push(...((data ?? []) as ThreadLinkRow[]));
  }
  return rows.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** One link as a reader sees it, from either end. */
export interface ThreadLinkView {
  kind: 'thread' | 'artifact';
  /** The thread at the other end, when `kind` is thread. */
  threadKey?: string;
  /** The artifact at the other end, when `kind` is artifact. */
  uri?: string;
  artifactId?: string;
  artifactType?: string;
  title: string | null;
  /** open / closed, or null when the key has no thread yet. Threads only. */
  status?: string | null;
  relation: string;
  note: string | null;
  origin: string;
  /** The SB slug that last wrote the link, or "user" / "system". */
  linkedBy: string;
  linkedAt: string;
}

export interface ThreadLinkViews {
  linksTo: ThreadLinkView[];
  linkedFrom: ThreadLinkView[];
}

/**
 * Who is reading links, and so how much of them they see. Every read names
 * one; there is no default (Myra, thread:thread-links). A link view shows the
 * title and status of a thread the reader may not be in, and thread titles
 * carry real content, so "anyone in the workspace" must never be what a read
 * falls back to.
 *
 * - `full`: the team. The workspace owner in person, and the owner's own SBs
 *   that are not inklings.
 * - `participant`: everyone else (members, viewers, inklings, an identity that
 *   cannot be classified). They see a link only when they take part in the
 *   thread at both ends, which is what they could already list, and an
 *   artifact end only when the artifact is their own user's.
 */
export type LinkReader =
  | { kind: 'full' }
  | {
      kind: 'participant';
      principal: { kind: 'sb'; sbId: string } | { kind: 'user'; userId: string };
      userId: string;
    };

/**
 * The reader scope of an SB caller. Full only for a non-inkling SB whose owner
 * owns the workspace. An identity that cannot be classified (a transient read
 * failure included) is read as restricted: the narrower view is the safe one.
 */
export async function linkReaderForSb(
  supabase: SupabaseClient,
  caller: { sbId: string; userId: string; ownerRole: string }
): Promise<LinkReader> {
  if (caller.ownerRole === 'owner') {
    const identity = await classifyIdentityById(
      supabase as unknown as Parameters<typeof classifyIdentityById>[0],
      caller.sbId
    );
    if (identity.kind === 'other') return { kind: 'full' };
  }
  return {
    kind: 'participant',
    principal: { kind: 'sb', sbId: caller.sbId },
    userId: caller.userId,
  };
}

/** The reader scope of a person acting as themselves. */
export function linkReaderForUser(role: string, userId: string): LinkReader {
  return role === 'owner'
    ? { kind: 'full' }
    : { kind: 'participant', principal: { kind: 'user', userId }, userId };
}

/** Which of these threads the principal takes part in. */
async function participatingThreadIds(
  supabase: SupabaseClient,
  threadIds: string[],
  principal: { kind: 'sb'; sbId: string } | { kind: 'user'; userId: string }
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from('inbox_thread_participants')
    .select('thread_id')
    .in('thread_id', threadIds);
  q = principal.kind === 'sb' ? q.eq('sb_id', principal.sbId) : q.eq('user_id', principal.userId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to check thread participation: ${error.message}`);
  return new Set(((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id));
}

/**
 * Turn rows into views: `linksTo` describes each row's target, `linkedFrom`
 * each row's source thread. Titles and statuses come from batched lookups,
 * one query per table, never one per row. The reader decides what survives:
 * see LinkReader.
 */
export async function describeThreadLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  rows: { linksTo: ThreadLinkRow[]; linkedFrom: ThreadLinkRow[] },
  reader: LinkReader
): Promise<ThreadLinkViews> {
  const targetKeys = unique(
    rows.linksTo.filter((r) => r.target_kind === 'thread').map((r) => r.target_thread_key!)
  );
  const artifactIds = unique(
    rows.linksTo.filter((r) => r.target_kind === 'artifact').map((r) => r.target_artifact_id!)
  );
  const sourceIds = unique(rows.linkedFrom.map((r) => r.source_thread_id));
  const sbIds = unique(
    [...rows.linksTo, ...rows.linkedFrom]
      .map((r) => r.linked_by_sb_id)
      .filter((id): id is string => !!id)
  );

  const [threadsByKey, artifactsById, sourcesById, slugBySbId] = await Promise.all([
    threadsWhere(supabase, workspaceId, 'thread_key', targetKeys),
    artifactsWhereId(supabase, artifactIds),
    threadsWhere(supabase, workspaceId, 'id', sourceIds),
    resolveSbsByIds(supabase, sbIds).then((sbs) => new Map(sbs.map((sb) => [sb.sbId, sb.sbSlug]))),
  ]);

  // A restricted reader sees a link only between threads it takes part in.
  // Both ends are checked: the source of every row (the subject thread, for
  // linksTo) and the thread at the other end.
  const visible =
    reader.kind === 'full'
      ? null
      : await participatingThreadIds(
          supabase,
          unique([
            ...rows.linksTo.map((r) => r.source_thread_id),
            ...[...threadsByKey.values()].map((t) => t.id),
            ...sourceIds,
          ]),
          reader.principal
        );
  const canSee = (threadId: string | undefined): boolean =>
    visible === null || (threadId !== undefined && visible.has(threadId));

  const linkedBy = (r: ThreadLinkRow): string =>
    r.linked_by_kind === 'sb'
      ? ((r.linked_by_sb_id && slugBySbId.get(r.linked_by_sb_id)) ?? 'unknown-sb')
      : r.linked_by_kind;
  const common = (r: ThreadLinkRow) => ({
    relation: r.relation,
    note: r.note,
    origin: r.origin,
    linkedBy: linkedBy(r),
    linkedAt: r.updated_at,
  });

  const linksTo: ThreadLinkView[] = [];
  for (const r of rows.linksTo) {
    if (!canSee(r.source_thread_id)) continue;
    if (r.target_kind === 'thread') {
      const t = threadsByKey.get(r.target_thread_key!);
      // A restricted reader cannot list a key with no thread either, so it
      // stays hidden with the rest.
      if (visible !== null && !canSee(t?.id)) continue;
      linksTo.push({
        kind: 'thread',
        threadKey: r.target_thread_key!,
        title: t?.title ?? null,
        status: t?.status ?? null,
        ...common(r),
      });
    } else {
      const a = artifactsById.get(r.target_artifact_id!);
      // The FK cascades on delete, so a miss here is an artifact deleted
      // between the two reads. Leave it out rather than show an id with no
      // address.
      if (!a) continue;
      // Artifacts are owned by a user; a restricted reader sees its own.
      if (reader.kind === 'participant' && a.user_id !== reader.userId) continue;
      linksTo.push({
        kind: 'artifact',
        uri: a.uri,
        artifactId: a.id,
        artifactType: a.artifact_type,
        title: a.title,
        ...common(r),
      });
    }
  }

  const linkedFrom: ThreadLinkView[] = [];
  const seenSources = new Set<string>();
  for (const r of rows.linkedFrom) {
    const t = sourcesById.get(r.source_thread_id);
    if (!t || !canSee(t.id)) continue;
    // A thread that linked both a spec and its thread appears once.
    if (seenSources.has(r.source_thread_id)) continue;
    seenSources.add(r.source_thread_id);
    linkedFrom.push({
      kind: 'thread',
      threadKey: t.thread_key,
      title: t.title,
      status: t.status,
      ...common(r),
    });
  }

  return { linksTo, linkedFrom };
}

/**
 * The threads linking to an artifact, for get_artifact: links to the artifact
 * itself and, for a spec, to its `spec:<slug>` thread. Capped at
 * THREAD_LINK_HEADER_MAX with the total beside it. Never throws: links
 * decorate the artifact, so a failure is returned as `error` beside it.
 */
export async function artifactBacklinks(
  supabase: SupabaseClient,
  workspaceId: string,
  artifact: { id: string; uri: string },
  reader: LinkReader
): Promise<{ threads: ThreadLinkView[]; count: number } | { error: string }> {
  try {
    const twin = specTwin({ kind: 'artifact', uri: artifact.uri });
    const rows = await listLinksTo(supabase, workspaceId, {
      artifactId: artifact.id,
      threadKey: twin && twin.kind === 'thread' ? twin.threadKey : null,
    });
    const { linkedFrom } = await describeThreadLinks(
      supabase,
      workspaceId,
      { linksTo: [], linkedFrom: rows },
      reader
    );
    return { threads: linkedFrom.slice(0, THREAD_LINK_HEADER_MAX), count: linkedFrom.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

interface ThreadSummaryRow {
  id: string;
  thread_key: string;
  title: string | null;
  status: string;
}

async function threadsWhere(
  supabase: SupabaseClient,
  workspaceId: string,
  column: 'id' | 'thread_key',
  values: string[]
): Promise<Map<string, ThreadSummaryRow>> {
  if (values.length === 0) return new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('inbox_threads')
    .select('id, thread_key, title, status')
    .eq('workspace_id', workspaceId)
    .in(column, values);
  if (error) throw new Error(`Failed to read linked threads: ${error.message}`);
  const rows = (data ?? []) as ThreadSummaryRow[];
  return new Map(rows.map((t) => [column === 'id' ? t.id : t.thread_key, t]));
}

interface ArtifactSummaryRow {
  id: string;
  uri: string;
  title: string;
  artifact_type: string;
  user_id: string;
}

async function artifactsWhereId(
  supabase: SupabaseClient,
  ids: string[]
): Promise<Map<string, ArtifactSummaryRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('artifacts')
    .select('id, uri, title, artifact_type, user_id')
    .in('id', ids);
  if (error) throw new Error(`Failed to read linked artifacts: ${error.message}`);
  return new Map(((data ?? []) as ArtifactSummaryRow[]).map((a) => [a.id, a]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
