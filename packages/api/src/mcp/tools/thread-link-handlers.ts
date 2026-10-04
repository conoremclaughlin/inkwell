/**
 * Thread link tools: link_thread, unlink_thread, list_thread_links.
 *
 * A thread names another thread, or a library artifact, as related to it, so
 * an SB that was never in a conversation can still find what it touches: the
 * PRs that implement a spec, the thread a PR continues. Data model and the
 * spec twin join: services/thread-links.ts.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { getEffectiveSlug } from '../../auth/enforce-identity';
import { logger } from '../../utils/logger';
import { assertWriteRole, resolveCallerSb, type CallerSb } from './caller-principal';
import { findThread, isParticipant, type ThreadRow } from './thread-handlers';
import { resolveArtifactRowForUser } from './artifact-handlers';
import {
  THREAD_LINK_NOTE_MAX,
  THREAD_LINK_RELATIONS,
  deleteThreadLink,
  describeThreadLinks,
  listLinksFrom,
  listLinksTo,
  parseLinkTarget,
  specTwin,
  upsertThreadLink,
  type LinkTarget,
  type ResolvedLinkTarget,
  type ThreadLinkRow,
} from '../../services/thread-links';

type SupabaseClient = ReturnType<DataComposer['getClient']>;

// ============== Schemas ==============

const threadKeySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*:[^\s]+$/, 'threadKey must look like "type:identifier"');

const sbSlugSchema = z.string().min(1).max(64);

const targetSchema = z
  .string()
  .min(3)
  .max(500)
  .describe(
    'What to link to: a thread key ("pr:701", "spec:live-agent-surfaces") or a library URI ("ink://specs/live-agent-surfaces"). A thread key need not have a conversation yet.'
  );

const linkThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema.describe('The thread making the link'),
  sbSlug: sbSlugSchema.describe('SB slug making the link (must be a participant)'),
  to: targetSchema,
  relation: z
    .enum(THREAD_LINK_RELATIONS)
    .optional()
    .describe(
      'How the thread relates to the target. relates (default): related work. implements: this thread builds what the target describes (a PR implementing a spec). continues: this thread picks up where the target left off. supersedes: this thread replaces the target. Omitted on a re-link keeps the stored relation.'
    ),
  note: z
    .string()
    .max(THREAD_LINK_NOTE_MAX)
    .nullable()
    .optional()
    .describe(
      `Why the two are linked, max ${THREAD_LINK_NOTE_MAX} chars. Pass null to clear; omit to keep.`
    ),
});

const unlinkThreadSchema = userIdentifierBaseSchema.extend({
  threadKey: threadKeySchema.describe('The thread that made the link'),
  sbSlug: sbSlugSchema.describe('SB slug removing the link (must be a participant)'),
  to: targetSchema,
});

const listThreadLinksSchema = userIdentifierBaseSchema
  .extend({
    sbSlug: sbSlugSchema.describe('SB slug asking. Any SB in the workspace may read links.'),
    threadKey: threadKeySchema
      .optional()
      .describe('List what this thread links to and what links to it'),
    uri: z
      .string()
      .min(7)
      .max(500)
      .optional()
      .describe('List the threads linking to this library artifact ("ink://specs/<slug>")'),
    direction: z
      .enum(['both', 'to', 'from'])
      .optional()
      .default('both')
      .describe('to: what the thread links to. from: what links to it. both (default).'),
    relation: z.enum(THREAD_LINK_RELATIONS).optional().describe('Only links with this relation'),
  })
  .refine((v) => (v.threadKey ? !v.uri : !!v.uri), {
    message: 'Provide exactly one of threadKey or uri',
  });

// ============== Helpers ==============

const reply = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** The caller's thread, checked for write access and participation. */
async function threadForWrite(
  supabase: SupabaseClient,
  userId: string,
  sbSlug: string,
  threadKey: string,
  action: string
): Promise<{ caller: CallerSb; thread: ThreadRow } | { error: string }> {
  const caller = await resolveCallerSb(supabase, userId, sbSlug);
  assertWriteRole(caller.ownerRole, action);
  const thread = await findThread(supabase, caller.workspaceId, threadKey);
  if (!thread) return { error: `Thread not found: ${threadKey}` };
  if (!(await isParticipant(supabase, thread.id, caller))) {
    return { error: `Agent ${sbSlug} is not a participant in thread ${threadKey}` };
  }
  return { caller, thread };
}

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
 * `ink://specs/` artifact, links to its twin count as links to it.
 */
export async function threadLinkViewsFor(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  subject: { threadKey: string; thread: ThreadRow | null } | { artifactId: string; uri: string },
  options: { direction?: 'both' | 'to' | 'from'; relation?: string } = {}
) {
  const direction = options.direction ?? 'both';
  let linksTo: ThreadLinkRow[] = [];
  let linkedFrom: ThreadLinkRow[] = [];

  if ('threadKey' in subject) {
    if (direction !== 'from' && subject.thread) {
      linksTo = await listLinksFrom(supabase, subject.thread.id);
    }
    if (direction !== 'to') {
      const twin = specTwin({ kind: 'thread', threadKey: subject.threadKey });
      let twinArtifactId: string | null = null;
      if (twin && twin.kind === 'artifact') {
        const r = await resolveLinkTarget(supabase, userId, twin);
        if ('resolved' in r && r.resolved.kind === 'artifact')
          twinArtifactId = r.resolved.artifactId;
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
  return describeThreadLinks(supabase, workspaceId, { linksTo, linkedFrom });
}

// ============== Handlers ==============

/**
 * Link a thread to another thread or to a library artifact. Re-linking the
 * same pair updates the existing link, so the call is safe to repeat.
 *
 * Any participant may link, as with update_thread: the SB doing the work is
 * usually not the one who opened the thread.
 */
export async function handleLinkThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = linkThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;

  const target = parseLinkTarget(parsed.to);
  if ('error' in target) return reply({ success: false, error: target.error });
  if (target.kind === 'thread' && target.threadKey === parsed.threadKey) {
    return reply({ success: false, error: 'A thread cannot link to itself' });
  }

  const access = await threadForWrite(
    supabase,
    resolved.user.id,
    sbSlug,
    parsed.threadKey,
    'link a thread'
  );
  if ('error' in access) return reply({ success: false, error: access.error });

  const r = await resolveLinkTarget(supabase, resolved.user.id, target);
  if ('error' in r) return reply({ success: false, error: r.error });

  const row = await upsertThreadLink(supabase, {
    workspaceId: access.caller.workspaceId,
    sourceThreadId: access.thread.id,
    target: r.resolved,
    relation: parsed.relation,
    note: parsed.note,
    origin: 'explicit',
    linkedBy: { kind: 'sb', sbId: access.caller.sbId },
  });

  logger.info('[ThreadLinks] Linked', {
    threadKey: parsed.threadKey,
    to: r.resolved.kind === 'thread' ? r.resolved.threadKey : r.uri,
    relation: row.relation,
    sbSlug,
  });

  return reply({
    success: true,
    threadKey: parsed.threadKey,
    link: {
      kind: row.target_kind,
      ...(r.resolved.kind === 'thread' ? { threadKey: r.resolved.threadKey } : { uri: r.uri }),
      relation: row.relation,
      note: row.note,
      linkedBy: sbSlug,
      linkedAt: row.updated_at,
    },
    // created_at == updated_at only on the insert; a re-link moves updated_at.
    created: row.created_at === row.updated_at,
    // The URI given was an old name; the link is stored against the artifact,
    // whose canonical address is link.uri.
    ...(r.resolvedViaAlias ? { resolvedViaAlias: r.resolvedViaAlias } : {}),
  });
}

export async function handleUnlinkThread(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = unlinkThreadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;

  const target = parseLinkTarget(parsed.to);
  if ('error' in target) return reply({ success: false, error: target.error });

  const access = await threadForWrite(
    supabase,
    resolved.user.id,
    sbSlug,
    parsed.threadKey,
    'unlink a thread'
  );
  if ('error' in access) return reply({ success: false, error: access.error });

  const r = await resolveLinkTarget(supabase, resolved.user.id, target);
  if ('error' in r) return reply({ success: false, error: r.error });

  const removed = await deleteThreadLink(supabase, access.thread.id, r.resolved);
  if (removed === 0) {
    return reply({
      success: false,
      error: `${parsed.threadKey} has no link to ${parsed.to}`,
    });
  }
  logger.info('[ThreadLinks] Unlinked', { threadKey: parsed.threadKey, to: parsed.to, sbSlug });
  return reply({ success: true, threadKey: parsed.threadKey, removed: parsed.to });
}

/**
 * Read links. Any SB in the workspace may, participant or not: the point is
 * navigation for an SB that was never in the conversation. A view carries
 * keys, titles and statuses, never message content.
 */
export async function handleListThreadLinks(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = listThreadLinksSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
  const caller = await resolveCallerSb(supabase, resolved.user.id, sbSlug);
  const options = { direction: parsed.direction, relation: parsed.relation };

  if (parsed.threadKey) {
    const thread = await findThread(supabase, caller.workspaceId, parsed.threadKey);
    const views = await threadLinkViewsFor(
      supabase,
      resolved.user.id,
      caller.workspaceId,
      { threadKey: parsed.threadKey, thread },
      options
    );
    return reply({
      success: true,
      threadKey: parsed.threadKey,
      threadExists: !!thread,
      ...views,
    });
  }

  const target = parseLinkTarget(parsed.uri!);
  if ('error' in target || target.kind !== 'artifact') {
    return reply({ success: false, error: `Not an ink:// URI: ${parsed.uri}` });
  }
  const r = await resolveLinkTarget(supabase, resolved.user.id, target);
  if ('error' in r) return reply({ success: false, error: r.error });
  if (r.resolved.kind !== 'artifact') {
    return reply({ success: false, error: `Not an ink:// URI: ${parsed.uri}` });
  }
  const views = await threadLinkViewsFor(
    supabase,
    resolved.user.id,
    caller.workspaceId,
    { artifactId: r.resolved.artifactId, uri: r.uri! },
    options
  );
  return reply({
    success: true,
    uri: r.uri,
    ...(r.resolvedViaAlias ? { resolvedViaAlias: r.resolvedViaAlias } : {}),
    // An artifact makes no links of its own; it is only ever a target.
    linkedFrom: views.linkedFrom,
  });
}

// ============== Tool Registration ==============

export const threadLinkToolDefinitions = [
  {
    name: 'link_thread',
    description:
      'Link a thread to another thread or to a library artifact, so anyone can see what it touches: a PR thread to the spec it implements (to: "spec:live-agent-surfaces" or "ink://specs/live-agent-surfaces"), a follow-up to the thread it continues. Stored once and read from both ends: the target shows it under linkedFrom. A thread key need not have a conversation yet; an unknown ink:// URI is refused. Re-linking the same pair updates relation and note. Any participant of the thread may link.',
    schema: linkThreadSchema,
    handler: handleLinkThread,
  },
  {
    name: 'unlink_thread',
    description:
      'Remove a link this thread made to another thread or library artifact. Any participant of the thread may unlink.',
    schema: unlinkThreadSchema,
    handler: handleUnlinkThread,
  },
  {
    name: 'list_thread_links',
    description:
      'List what a thread links to (linksTo) and what links to it (linkedFrom), or, given an ink:// URI, every thread linking to that artifact ("which PRs touch this spec?"). The thread spec:<slug> and the artifact ink://specs/<slug> are read as one subject. Readable by any SB in the workspace, participant or not; returns keys, titles and statuses, never message content.',
    schema: listThreadLinksSchema,
    handler: handleListThreadLinks,
  },
];

export function threadLinkTool(name: string): (typeof threadLinkToolDefinitions)[number] {
  const found = threadLinkToolDefinitions.find((t) => t.name === name);
  if (!found) throw new Error(`Unknown thread link tool: ${name}`);
  return found;
}
