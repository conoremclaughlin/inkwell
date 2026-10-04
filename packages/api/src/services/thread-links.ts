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
 * The subject is some thread keys, an artifact id, or both (a spec, its
 * thread, and the threads of its former URIs). Two queries rather than one
 * `.or()`, so no value is spliced into a PostgREST filter string.
 */
export async function listLinksTo(
  supabase: SupabaseClient,
  workspaceId: string,
  subject: { threadKeys?: string[]; artifactId?: string | null }
): Promise<ThreadLinkRow[]> {
  const rows: ThreadLinkRow[] = [];
  const keys = unique(subject.threadKeys ?? []);
  if (keys.length > 0) {
    const { data, error } = await linksTable(supabase)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('target_kind', 'thread')
      .in('target_thread_key', keys);
    if (error) throw new Error(`Failed to list links to ${keys.join(', ')}: ${error.message}`);
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

/** An artifact as a link sees it: its address and who owns it, never content. */
export interface LinkArtifactRow {
  id: string;
  uri: string;
  title: string;
  artifact_type: string;
  user_id: string;
  workspace_id: string | null;
}

const LINK_ARTIFACT_COLUMNS = 'id, uri, title, artifact_type, user_id, workspace_id';

/**
 * Is this artifact in the link's workspace? An artifact from before artifacts
 * carried a workspace (workspace_id null) counts when it is the caller's
 * user's own.
 */
function artifactInWorkspace(
  artifact: LinkArtifactRow,
  workspaceId: string,
  callerUserId: string
): boolean {
  return (
    artifact.workspace_id === workspaceId ||
    (artifact.workspace_id === null && artifact.user_id === callerUserId)
  );
}

/** May this reader see the artifact at a link's end: its URI and title. */
export function readerSeesArtifact(reader: LinkReader, artifact: { user_id: string }): boolean {
  return reader.kind === 'full' || artifact.user_id === reader.userId;
}

/** Where links are read or written: their workspace, the caller's user, and what it may see. */
export interface LinkScope {
  workspaceId: string;
  /** The caller's user: an SB's owner, or the person. Scopes legacy artifacts. */
  callerUserId: string;
  reader: LinkReader;
}

/**
 * The one artifact predicate (Lumen, #737 round 2): in the link's workspace,
 * legacy rule included, and visible to this reader. Resolving a target and
 * showing a link's end both ask exactly this, so an artifact a caller sees at
 * a link's end is one it can also link and unlink.
 */
export function artifactVisibleTo(scope: LinkScope, artifact: LinkArtifactRow): boolean {
  return (
    artifactInWorkspace(artifact, scope.workspaceId, scope.callerUserId) &&
    readerSeesArtifact(scope.reader, artifact)
  );
}

/**
 * Artifacts by current or former URI, batched: one query for each table.
 * Used to read a `spec:` key's twin at a link's end.
 */
async function artifactsByUri(
  supabase: SupabaseClient,
  uris: string[]
): Promise<Map<string, LinkArtifactRow>> {
  const out = new Map<string, LinkArtifactRow>();
  if (uris.length === 0) return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;
  const { data: direct, error } = await client
    .from('artifacts')
    .select(LINK_ARTIFACT_COLUMNS)
    .in('uri', uris);
  if (error) throw new Error(`Failed to read spec artifacts: ${error.message}`);
  for (const a of (direct ?? []) as LinkArtifactRow[]) out.set(a.uri, a);
  const missing = uris.filter((u) => !out.has(u));
  if (missing.length === 0) return out;
  const { data: aliases, error: aliasError } = await client
    .from('artifact_uri_aliases')
    .select('alias_uri, artifact_id')
    .in('alias_uri', missing);
  if (aliasError) throw new Error(`Failed to read spec aliases: ${aliasError.message}`);
  const aliasRows = (aliases ?? []) as Array<{ alias_uri: string; artifact_id: string }>;
  if (aliasRows.length === 0) return out;
  const { data: aliased, error: aliasedError } = await client
    .from('artifacts')
    .select(LINK_ARTIFACT_COLUMNS)
    .in(
      'id',
      aliasRows.map((a) => a.artifact_id)
    );
  if (aliasedError) throw new Error(`Failed to read spec artifacts: ${aliasedError.message}`);
  const byId = new Map(((aliased ?? []) as LinkArtifactRow[]).map((a) => [a.id, a]));
  for (const a of aliasRows) {
    const row = byId.get(a.artifact_id);
    if (row) out.set(a.alias_uri, row);
  }
  return out;
}

/**
 * Find the artifact a link names, by its URI or a former one, in the link's
 * workspace.
 *
 * One resolver for writing, removing and reading links (Lumen, #737). It
 * used to resolve through the caller's own artifacts, so two SBs with
 * different owners in one workspace saw different backlinks for the same
 * spec, and a participant could see a link it could not remove. URIs and
 * aliases are each globally unique, so the lookup needs no owner; the scope is
 * checked on the row found. Whether a reader may see the artifact is a
 * separate question (readerSeesArtifact).
 */
export async function findLinkArtifact(
  supabase: SupabaseClient,
  workspaceId: string,
  callerUserId: string,
  uri: string
): Promise<{ artifact: LinkArtifactRow; resolvedViaAlias: string | null } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;
  const { data: direct, error } = await client
    .from('artifacts')
    .select(LINK_ARTIFACT_COLUMNS)
    .eq('uri', uri)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve artifact ${uri}: ${error.message}`);
  let artifact = direct as LinkArtifactRow | null;
  let resolvedViaAlias: string | null = null;
  if (!artifact) {
    const { data: alias, error: aliasError } = await client
      .from('artifact_uri_aliases')
      .select('artifact_id')
      .eq('alias_uri', uri)
      .maybeSingle();
    // A lookup failure is infrastructure, not a miss.
    if (aliasError)
      throw new Error(`Failed to resolve artifact alias ${uri}: ${aliasError.message}`);
    if (alias) {
      const { data: aliased, error: aliasedError } = await client
        .from('artifacts')
        .select(LINK_ARTIFACT_COLUMNS)
        .eq('id', (alias as { artifact_id: string }).artifact_id)
        .maybeSingle();
      if (aliasedError) throw new Error(`Failed to resolve artifact: ${aliasedError.message}`);
      artifact = aliased as LinkArtifactRow | null;
      resolvedViaAlias = artifact ? uri : null;
    }
  }
  if (!artifact || !artifactInWorkspace(artifact, workspaceId, callerUserId)) return null;
  return { artifact, resolvedViaAlias };
}

/**
 * Every `spec:` thread key that names this artifact: the twin of its current
 * URI and of each former one. A Library rename leaves links stored under the
 * old `spec:<slug>` key, and they still belong to the same subject (Lumen,
 * #737).
 */
export async function specTwinKeysOf(
  supabase: SupabaseClient,
  artifact: { id: string; uri: string }
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('artifact_uri_aliases')
    .select('alias_uri')
    .eq('artifact_id', artifact.id);
  if (error) throw new Error(`Failed to read former URIs of ${artifact.uri}: ${error.message}`);
  const uris = [
    artifact.uri,
    ...((data ?? []) as Array<{ alias_uri: string }>).map((a) => a.alias_uri),
  ];
  const keys: string[] = [];
  for (const uri of uris) {
    const twin = specTwin({ kind: 'artifact', uri });
    if (twin && twin.kind === 'thread') keys.push(twin.threadKey);
  }
  return unique(keys);
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
  /**
   * open / closed, or null when the key has no thread yet. Threads only, and
   * absent when the end is shown `via: 'spec'`.
   */
  status?: string | null;
  /**
   * 'spec': the reader may see this `spec:` key's end only through the spec
   * it is the twin of, not as a participant of the conversation. The title is
   * then the spec's, and the conversation's own title and status are left
   * out, whether or not that conversation exists.
   */
  via?: 'spec';
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
 * one query per table, never one per row.
 *
 * The scope decides what survives, and it is decided per ROW, at both ends,
 * whichever direction the row is read from (Lumen, #737 round 2). An earlier
 * cut checked only the source for `linkedFrom`, so a restricted reader that
 * saw no outgoing edge from pr:1 could ask the hidden target for its incoming
 * edges and get the same row back, note included. Now a row shows only if
 * the reader may see its source thread and its target:
 *
 * - a thread target: the reader takes part in it, or, for a `spec:` key, it
 *   may see the spec artifact that key is the twin of (the two are one
 *   subject, and a spec key usually has no thread at all);
 * - an artifact target: artifactVisibleTo, the same predicate that resolving
 *   a target uses, so a visible end is always one the caller can unlink.
 *
 * A full reader passes every thread check; artifacts are still held to the
 * workspace and the legacy-owner rule.
 */
export async function describeThreadLinks(
  supabase: SupabaseClient,
  scope: LinkScope,
  rows: { linksTo: ThreadLinkRow[]; linkedFrom: ThreadLinkRow[] }
): Promise<ThreadLinkViews> {
  const { workspaceId, reader } = scope;
  const all = [...rows.linksTo, ...rows.linkedFrom];
  const targetKeys = unique(
    all.filter((r) => r.target_kind === 'thread').map((r) => r.target_thread_key!)
  );
  const artifactIds = unique(
    all.filter((r) => r.target_kind === 'artifact').map((r) => r.target_artifact_id!)
  );
  const sourceIds = unique(all.map((r) => r.source_thread_id));
  const sbIds = unique(all.map((r) => r.linked_by_sb_id).filter((id): id is string => !!id));
  // The spec artifact behind each `spec:` target key, for the twin rule.
  const twinUriByKey = new Map<string, string>();
  for (const key of targetKeys) {
    const twin = specTwin({ kind: 'thread', threadKey: key });
    if (twin && twin.kind === 'artifact') twinUriByKey.set(key, twin.uri);
  }

  const [threadsByKey, artifactsById, sourcesById, slugBySbId, twinArtifacts] = await Promise.all([
    threadsWhere(supabase, workspaceId, 'thread_key', targetKeys),
    artifactsWhereId(supabase, artifactIds),
    threadsWhere(supabase, workspaceId, 'id', sourceIds),
    resolveSbsByIds(supabase, sbIds).then((sbs) => new Map(sbs.map((sb) => [sb.sbId, sb.sbSlug]))),
    reader.kind === 'full'
      ? Promise.resolve(new Map<string, LinkArtifactRow>())
      : artifactsByUri(supabase, unique([...twinUriByKey.values()])),
  ]);

  const visible =
    reader.kind === 'full'
      ? null
      : await participatingThreadIds(
          supabase,
          unique([...sourceIds, ...[...threadsByKey.values()].map((t) => t.id)]),
          reader.principal
        );
  const canSeeThread = (threadId: string | undefined): boolean =>
    visible === null || (threadId !== undefined && visible.has(threadId));
  const canSeeThreadKey = (key: string): boolean => {
    if (visible === null) return true;
    if (canSeeThread(threadsByKey.get(key)?.id)) return true;
    const twinUri = twinUriByKey.get(key);
    const twin = twinUri ? twinArtifacts.get(twinUri) : undefined;
    return twin !== undefined && artifactVisibleTo(scope, twin);
  };
  const rowVisible = (r: ThreadLinkRow): boolean => {
    if (!canSeeThread(r.source_thread_id)) return false;
    if (r.target_kind === 'thread') return canSeeThreadKey(r.target_thread_key!);
    // The FK cascades on delete, so a missing artifact is one deleted between
    // the two reads: left out rather than shown as an id with no address.
    const a = artifactsById.get(r.target_artifact_id!);
    return a !== undefined && artifactVisibleTo(scope, a);
  };

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
    if (!rowVisible(r)) continue;
    if (r.target_kind === 'thread') {
      const t = threadsByKey.get(r.target_thread_key!);
      // Seeing the edge is one permission; seeing the conversation's title
      // and status is another (Lumen, #737 round 3). A restricted reader that
      // sees a `spec:` end through the spec alone gets the spec's title and
      // no status, the same whether the conversation exists or not, so the
      // view does not even say there is one.
      if (visible !== null && !canSeeThread(t?.id)) {
        const twinUri = twinUriByKey.get(r.target_thread_key!);
        const twin = twinUri ? twinArtifacts.get(twinUri) : undefined;
        linksTo.push({
          kind: 'thread',
          threadKey: r.target_thread_key!,
          title: twin?.title ?? null,
          via: 'spec',
          ...common(r),
        });
        continue;
      }
      linksTo.push({
        kind: 'thread',
        threadKey: r.target_thread_key!,
        title: t?.title ?? null,
        status: t?.status ?? null,
        ...common(r),
      });
    } else {
      const a = artifactsById.get(r.target_artifact_id!)!;
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
    if (!rowVisible(r)) continue;
    const t = sourcesById.get(r.source_thread_id);
    if (!t) continue;
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
 * itself and, for a spec, to its `spec:<slug>` threads, former URIs included.
 * Capped at THREAD_LINK_HEADER_MAX with the total beside it. Never throws:
 * links decorate the artifact, so a failure is returned as `error` beside it.
 */
export async function artifactBacklinks(
  supabase: SupabaseClient,
  scope: LinkScope,
  artifact: { id: string; uri: string }
): Promise<{ threads: ThreadLinkView[]; count: number } | { error: string }> {
  try {
    const rows = await listLinksTo(supabase, scope.workspaceId, {
      artifactId: artifact.id,
      threadKeys: await specTwinKeysOf(supabase, artifact),
    });
    const { linkedFrom } = await describeThreadLinks(supabase, scope, {
      linksTo: [],
      linkedFrom: rows,
    });
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

async function artifactsWhereId(
  supabase: SupabaseClient,
  ids: string[]
): Promise<Map<string, LinkArtifactRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('artifacts')
    .select(LINK_ARTIFACT_COLUMNS)
    .in('id', ids);
  if (error) throw new Error(`Failed to read linked artifacts: ${error.message}`);
  return new Map(((data ?? []) as LinkArtifactRow[]).map((a) => [a.id, a]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
