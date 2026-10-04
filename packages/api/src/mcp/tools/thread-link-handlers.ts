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
import { resolveLinkTarget, threadLinkViewsFor, type LinkScope } from './thread-link-views';
import {
  THREAD_LINK_NOTE_MAX,
  THREAD_LINK_RELATIONS,
  deleteThreadLink,
  insertThreadLinkIfAbsent,
  linkReaderForSb,
  parseLinkTarget,
  upsertThreadLink,
  type ResolvedLinkTarget,
  type ThreadLinkWrite,
} from '../../services/thread-links';

type SupabaseClient = ReturnType<DataComposer['getClient']>;

/** The most links one send may carry. */
export const SEND_LINKS_MAX = 20;

export interface SendLinkTarget {
  /** As the sender wrote it. */
  to: string;
  resolved: ResolvedLinkTarget;
}

/**
 * Resolve the links a send carries, before anything is written: a bad target
 * in `links` refuses the send, the same way a wrong address stores nothing.
 *
 * `relatedArtifactUri` joins them, but leniently. The threaded send path took
 * it and dropped it until now, so callers have sent it for months with
 * nothing checking it; an unknown URI there is reported in `skipped`, never
 * a reason to refuse a message that used to go through.
 */
export async function resolveSendLinks(
  supabase: SupabaseClient,
  scope: LinkScope,
  threadKey: string,
  links: string[],
  relatedArtifactUri?: string
): Promise<{ targets: SendLinkTarget[]; skipped: Array<{ to: string; reason: string }> }> {
  const targets: SendLinkTarget[] = [];
  const skipped: Array<{ to: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (to: string, resolved: ResolvedLinkTarget) => {
    const id = resolved.kind === 'thread' ? `t:${resolved.threadKey}` : `a:${resolved.artifactId}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push({ to, resolved });
  };

  for (const to of links) {
    const parsed = parseLinkTarget(to);
    if ('error' in parsed) throw new Error(`links: ${parsed.error}`);
    if (parsed.kind === 'thread' && parsed.threadKey === threadKey) {
      throw new Error(`links: a thread cannot link to itself (${threadKey})`);
    }
    const r = await resolveLinkTarget(supabase, scope, parsed);
    if ('error' in r) throw new Error(`links: ${r.error}`);
    add(to, r.resolved);
  }

  if (relatedArtifactUri) {
    const parsed = parseLinkTarget(relatedArtifactUri);
    if ('error' in parsed || parsed.kind !== 'artifact') {
      skipped.push({ to: relatedArtifactUri, reason: 'relatedArtifactUri is not an ink:// URI' });
    } else {
      const r = await resolveLinkTarget(supabase, scope, parsed);
      if ('error' in r) skipped.push({ to: relatedArtifactUri, reason: r.error });
      else add(relatedArtifactUri, r.resolved);
    }
  }
  return { targets, skipped };
}

/**
 * Write a send's links once its message is stored. The message is already
 * delivered by then, so a failed link does not fail the send; it is reported
 * per target in `failed`, never folded into success.
 */
export async function writeSendLinks(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    sourceThreadId: string;
    messageId: string;
    linkedBy: ThreadLinkWrite['linkedBy'];
    targets: SendLinkTarget[];
  }
): Promise<{
  linked: string[];
  alreadyLinked: string[];
  failed: Array<{ to: string; error: string }>;
}> {
  const linked: string[] = [];
  const alreadyLinked: string[] = [];
  const failed: Array<{ to: string; error: string }> = [];
  for (const t of params.targets) {
    try {
      const row = await insertThreadLinkIfAbsent(supabase, {
        workspaceId: params.workspaceId,
        sourceThreadId: params.sourceThreadId,
        target: t.resolved,
        origin: 'send',
        sourceMessageId: params.messageId,
        linkedBy: params.linkedBy,
      });
      (row ? linked : alreadyLinked).push(t.to);
    } catch (error) {
      failed.push({ to: t.to, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length > 0) {
    logger.warn('[ThreadLinks] Send links failed after the message was stored', {
      sourceThreadId: params.sourceThreadId,
      messageId: params.messageId,
      failed,
    });
  }
  return { linked, alreadyLinked, failed };
}

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
    sbSlug: sbSlugSchema.describe(
      "SB slug asking. The workspace owner's SBs see every link; others see links between threads they take part in."
    ),
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

/** A calling SB's link scope: its workspace, its owner, and what it may see. */
async function scopeOf(supabase: SupabaseClient, caller: CallerSb): Promise<LinkScope> {
  return {
    workspaceId: caller.workspaceId,
    callerUserId: caller.userId,
    reader: await linkReaderForSb(supabase, caller),
  };
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

  const r = await resolveLinkTarget(supabase, await scopeOf(supabase, access.caller), target);
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

  const r = await resolveLinkTarget(supabase, await scopeOf(supabase, access.caller), target);
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
 * Read links. The team (the workspace owner's own SBs) may read any thread's
 * links, participant or not: the point is navigation for an SB that was never
 * in the conversation. Anyone else sees only links between threads it takes
 * part in, because a view carries thread titles and titles carry real content
 * (LinkReader). Never message content, for anyone.
 */
export async function handleListThreadLinks(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = listThreadLinksSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const sbSlug = getEffectiveSlug(parsed.sbSlug) ?? parsed.sbSlug;
  const caller = await resolveCallerSb(supabase, resolved.user.id, sbSlug);
  // Who is asking decides how much they see: the team sees every link, anyone
  // else only links between threads they take part in (LinkReader).
  const scope = await scopeOf(supabase, caller);
  const reader = scope.reader;
  const options = { direction: parsed.direction, relation: parsed.relation };

  if (parsed.threadKey) {
    const thread = await findThread(supabase, caller.workspaceId, parsed.threadKey);
    const views = await threadLinkViewsFor(
      supabase,
      caller.userId,
      caller.workspaceId,
      { threadKey: parsed.threadKey, threadId: thread?.id ?? null },
      reader,
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
  const r = await resolveLinkTarget(supabase, scope, target);
  if ('error' in r) return reply({ success: false, error: r.error });
  if (r.resolved.kind !== 'artifact') {
    return reply({ success: false, error: `Not an ink:// URI: ${parsed.uri}` });
  }
  const views = await threadLinkViewsFor(
    supabase,
    caller.userId,
    caller.workspaceId,
    { artifactId: r.resolved.artifactId, uri: r.uri! },
    reader,
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
      'List what a thread links to (linksTo) and what links to it (linkedFrom), or, given an ink:// URI, every thread linking to that artifact ("which PRs touch this spec?"). The thread spec:<slug> and the artifact ink://specs/<slug> are read as one subject. Returns keys, titles and statuses, never message content. The SBs of the workspace owner see every link, participant or not; any other reader (the SB of a member or viewer, an inkling) sees only links between threads it takes part in.',
    schema: listThreadLinksSchema,
    handler: handleListThreadLinks,
  },
];

export function threadLinkTool(name: string): (typeof threadLinkToolDefinitions)[number] {
  const found = threadLinkToolDefinitions.find((t) => t.name === name);
  if (!found) throw new Error(`Unknown thread link tool: ${name}`);
  return found;
}
