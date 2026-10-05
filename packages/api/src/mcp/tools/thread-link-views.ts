/**
 * Reading thread links: resolve a target, gather both directions for a
 * subject, and the compact header get_thread_messages carries.
 *
 * Kept apart from thread-link-handlers so thread-handlers can show the header
 * without importing the module that imports it back.
 */

import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import type { Principal } from '../../services/principals';
import { roleOfUserIn } from './caller-principal';
import {
  THREAD_LINK_HEADER_MAX,
  artifactVisibleTo,
  describeThreadLinks,
  findLinkArtifact,
  linkReaderForSb,
  linkReaderForUser,
  listLinksFrom,
  listLinksTo,
  specTwin,
  specTwinKeysOf,
  type LinkReader,
  type LinkScope,
  type LinkTarget,
  type ResolvedLinkTarget,
  type ThreadLinkRow,
  type ThreadLinkView,
} from '../../services/thread-links';

type SupabaseClient = ReturnType<DataComposer['getClient']>;

export type { LinkScope };

/**
 * Resolve a parsed target to what is stored. A thread key is stored as
 * written. An artifact URI, current or former, resolves to an artifact in the
 * link's workspace that the caller may see; anything else is refused with the
 * same message, so a refusal does not say whether an artifact exists that the
 * caller cannot see. Linking, unlinking and listing all resolve here, so what
 * a caller sees, it can also link and unlink (Lumen, #737).
 */
export async function resolveLinkTarget(
  supabase: SupabaseClient,
  scope: LinkScope,
  target: LinkTarget
): Promise<
  | { resolved: ResolvedLinkTarget; uri?: string; resolvedViaAlias?: string | null }
  | { error: string }
> {
  if (target.kind === 'thread') {
    return { resolved: { kind: 'thread', threadKey: target.threadKey } };
  }
  const found = await findLinkArtifact(supabase, scope.workspaceId, scope.callerUserId, target.uri);
  if (!found || !artifactVisibleTo(scope, found.artifact)) {
    return { error: `No artifact at ${target.uri}` };
  }
  return {
    resolved: { kind: 'artifact', artifactId: found.artifact.id },
    uri: found.artifact.uri,
    resolvedViaAlias: found.resolvedViaAlias,
  };
}

/**
 * The reader scope of any sending principal, for links that travel with a
 * send: an SB by its owner's role and kind, a person by their role, the
 * system in full.
 */
export async function linkReaderForPrincipal(
  supabase: SupabaseClient,
  workspaceId: string,
  principal: Principal
): Promise<LinkReader> {
  if (principal.kind === 'system') return { kind: 'full' };
  const role = await roleOfUserIn(
    supabase,
    workspaceId,
    principal.userId,
    principal.kind === 'sb' ? `${principal.sbSlug}'s owner` : 'You'
  );
  return principal.kind === 'sb'
    ? linkReaderForSb(supabase, { sbId: principal.sbId, userId: principal.userId, ownerRole: role })
    : linkReaderForUser(role, principal.userId);
}

/**
 * The thread keys and artifact a subject stands for. A `spec:` thread and an
 * `ink://specs/` artifact are one subject, and so are the `spec:` keys of the
 * artifact's former URIs: a Library rename does not split it (Lumen, #737).
 *
 * The twin artifact is found in the workspace whoever asks, so every reader
 * gathers the same rows; what each reader then sees of them is
 * describeThreadLinks' decision.
 */
async function subjectOf(
  supabase: SupabaseClient,
  workspaceId: string,
  callerUserId: string,
  subject: { threadKey: string } | { artifactId: string; uri: string }
): Promise<{ threadKeys: string[]; artifactId: string | null }> {
  if ('artifactId' in subject) {
    return {
      artifactId: subject.artifactId,
      threadKeys: await specTwinKeysOf(supabase, { id: subject.artifactId, uri: subject.uri }),
    };
  }
  const twin = specTwin({ kind: 'thread', threadKey: subject.threadKey });
  if (!twin || twin.kind !== 'artifact')
    return { threadKeys: [subject.threadKey], artifactId: null };
  const found = await findLinkArtifact(supabase, workspaceId, callerUserId, twin.uri);
  if (!found) return { threadKeys: [subject.threadKey], artifactId: null };
  return {
    artifactId: found.artifact.id,
    threadKeys: [subject.threadKey, ...(await specTwinKeysOf(supabase, found.artifact))],
  };
}

/**
 * Every link to and from a subject, as views. For a `spec:` thread or an
 * `ink://specs/` artifact, links to its twin count as links to it. The reader
 * scope is required: its reader decides which links survive (LinkReader).
 */
export async function threadLinkViewsFor(
  supabase: SupabaseClient,
  scope: LinkScope,
  subject: { threadKey: string; threadId: string | null } | { artifactId: string; uri: string },
  options: { direction?: 'both' | 'to' | 'from'; relation?: string } = {}
) {
  const direction = options.direction ?? 'both';
  let linksTo: ThreadLinkRow[] = [];
  let linkedFrom: ThreadLinkRow[] = [];

  if (direction !== 'from' && 'threadKey' in subject && subject.threadId) {
    linksTo = await listLinksFrom(supabase, subject.threadId);
  }
  if (direction !== 'to') {
    const whole = await subjectOf(supabase, scope.workspaceId, scope.callerUserId, subject);
    linkedFrom = await listLinksTo(supabase, scope.workspaceId, whole);
  }

  if (options.relation) {
    linksTo = linksTo.filter((r) => r.relation === options.relation);
    linkedFrom = linkedFrom.filter((r) => r.relation === options.relation);
  }
  return describeThreadLinks(supabase, scope, { linksTo, linkedFrom });
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
  caller: { sbId: string; userId: string; workspaceId: string; ownerRole: string },
  thread: { id: string; thread_key: string }
): Promise<ThreadLinkHeader | { error: string }> {
  try {
    const scope: LinkScope = {
      workspaceId: caller.workspaceId,
      callerUserId: caller.userId,
      reader: await linkReaderForSb(supabase, caller),
    };
    const views = await threadLinkViewsFor(supabase, scope, {
      threadKey: thread.thread_key,
      threadId: thread.id,
    });
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
