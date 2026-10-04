/**
 * Reading thread links: resolve a target, gather both directions for a
 * subject, and the compact header get_thread_messages carries.
 *
 * Kept apart from thread-link-handlers so thread-handlers can show the header
 * without importing the module that imports it back.
 */

import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { resolveArtifactRowForUser } from './artifact-handlers';
import {
  THREAD_LINK_HEADER_MAX,
  describeThreadLinks,
  linkReaderForSb,
  listLinksFrom,
  listLinksTo,
  specTwin,
  type LinkReader,
  type LinkTarget,
  type ResolvedLinkTarget,
  type ThreadLinkRow,
  type ThreadLinkView,
} from '../../services/thread-links';

type SupabaseClient = ReturnType<DataComposer['getClient']>;

/**
 * Resolve a parsed target to what is stored. An artifact URI resolves through
 * aliases to its id; an unknown URI is refused, because a link to nothing is
 * a typo nobody will notice. A thread key is stored as written.
 */
export async function resolveLinkTarget(
  supabase: SupabaseClient,
  userId: string,
  target: LinkTarget
): Promise<
  | { resolved: ResolvedLinkTarget; uri?: string; resolvedViaAlias?: string | null }
  | { error: string }
> {
  if (target.kind === 'thread') {
    return { resolved: { kind: 'thread', threadKey: target.threadKey } };
  }
  const { artifact, resolvedViaAlias } = await resolveArtifactRowForUser(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase as any,
    userId,
    undefined,
    { uri: target.uri }
  );
  if (!artifact) return { error: `No artifact at ${target.uri}` };
  return {
    resolved: { kind: 'artifact', artifactId: artifact.id },
    uri: artifact.uri,
    resolvedViaAlias,
  };
}

/**
 * Every link to and from a subject, as views. For a `spec:` thread or an
 * `ink://specs/` artifact, links to its twin count as links to it. The reader
 * is required: it decides which links survive (LinkReader).
 */
export async function threadLinkViewsFor(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  subject: { threadKey: string; threadId: string | null } | { artifactId: string; uri: string },
  reader: LinkReader,
  options: { direction?: 'both' | 'to' | 'from'; relation?: string } = {}
) {
  const direction = options.direction ?? 'both';
  let linksTo: ThreadLinkRow[] = [];
  let linkedFrom: ThreadLinkRow[] = [];

  if ('threadKey' in subject) {
    if (direction !== 'from' && subject.threadId) {
      linksTo = await listLinksFrom(supabase, subject.threadId);
    }
    if (direction !== 'to') {
      const twin = specTwin({ kind: 'thread', threadKey: subject.threadKey });
      let twinArtifactId: string | null = null;
      if (twin && twin.kind === 'artifact') {
        const r = await resolveLinkTarget(supabase, userId, twin);
        if ('resolved' in r && r.resolved.kind === 'artifact') {
          twinArtifactId = r.resolved.artifactId;
        }
      }
      linkedFrom = await listLinksTo(supabase, workspaceId, {
        threadKey: subject.threadKey,
        artifactId: twinArtifactId,
      });
    }
  } else if (direction !== 'to') {
    const twin = specTwin({ kind: 'artifact', uri: subject.uri });
    linkedFrom = await listLinksTo(supabase, workspaceId, {
      artifactId: subject.artifactId,
      threadKey: twin && twin.kind === 'thread' ? twin.threadKey : null,
    });
  }

  if (options.relation) {
    linksTo = linksTo.filter((r) => r.relation === options.relation);
    linkedFrom = linkedFrom.filter((r) => r.relation === options.relation);
  }
  return describeThreadLinks(supabase, workspaceId, { linksTo, linkedFrom }, reader);
}

export interface ThreadLinkHeader {
  linksTo: ThreadLinkView[];
  linkedFrom: ThreadLinkView[];
  /** Totals before the header's cap, so a cut is visible. */
  linksToCount: number;
  linkedFromCount: number;
}

/**
 * The links block on get_thread_messages: both directions, newest first,
 * capped at THREAD_LINK_HEADER_MAX each with the totals beside them.
 *
 * Returns an error string instead of throwing. Links decorate a read whose
 * job is the messages; a links failure (the table not migrated yet, say) is
 * reported beside them, never in place of them.
 */
export async function threadLinkHeader(
  supabase: SupabaseClient,
  userId: string,
  caller: { sbId: string; userId: string; workspaceId: string; ownerRole: string },
  thread: { id: string; thread_key: string }
): Promise<ThreadLinkHeader | { error: string }> {
  try {
    const reader = await linkReaderForSb(supabase, caller);
    const views = await threadLinkViewsFor(
      supabase,
      userId,
      caller.workspaceId,
      { threadKey: thread.thread_key, threadId: thread.id },
      reader
    );
    return {
      linksTo: views.linksTo.slice(0, THREAD_LINK_HEADER_MAX),
      linkedFrom: views.linkedFrom.slice(0, THREAD_LINK_HEADER_MAX),
      linksToCount: views.linksTo.length,
      linkedFromCount: views.linkedFrom.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[ThreadLinks] Header read failed', { threadKey: thread.thread_key, message });
    return { error: message };
  }
}
