/**
 * Agent Inbox Handlers
 *
 * MCP tools for cross-agent messaging. Allows AI beings to send messages
 * to each other asynchronously for coordination and task handoff.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { resolveIdentityId, resolveAgentSlug } from '../../auth/resolve-identity';
import { advanceThreadReadPointer, advanceAgentInboxReadPointer } from './read-state.js';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { logger } from '../../utils/logger';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../data/supabase/types';
import { ThreadKeyService } from '../../services/thread-key/thread-key.service';
import {
  detectUnregisteredProjectPrefix,
  describeUnregisteredProjectPrefix,
} from '../../services/thread-key/unregistered-prefix';
import {
  getRequestContext,
  getSessionContext,
  getPinnedAgentId,
} from '../../utils/request-context';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway.js';
import {
  senderRoutingContext,
  isBridgeIdentity,
  senderSbId as senderSbIdFromContext,
} from './sender-context.js';
import {
  findThread as findExistingThread,
  getParticipants,
  resolveTriggeredAgents,
  handleGetThreadMessages,
} from './thread-handlers.js';
import { resolveStudioHint } from '../../services/sessions/index.js';

// The thread tables are new and not yet in generated Supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const threadTable = (supabase: ReturnType<DataComposer['getClient']>, table: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from(table);

// ============== Schemas ==============

const sendToInboxSchema = userIdentifierBaseSchema.extend({
  recipientAgentId: z
    .string()
    .optional()
    .describe('Agent ID to send message to. Required unless recipients[] is provided.'),
  recipients: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(16)
    .optional()
    .describe('Multiple recipient agent IDs for group thread creation. Requires threadKey.'),
  senderAgentId: z.string().optional().describe('Agent ID of sender (optional if from human)'),
  subject: z.string().optional().describe('Message subject'),
  content: z.string().describe('Message content'),
  messageType: z
    .enum(['message', 'task_request', 'session_resume', 'notification', 'permission_grant'])
    .optional()
    .default('message')
    .describe('Type of message'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .default('normal')
    .describe('Message priority'),
  recipientSessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Recipient session ID to resume/route to (preferred)'),
  recipientStudioId: z
    .string()
    .uuid()
    .optional()
    .describe('Recipient studio ID hint for session routing'),
  recipientStudioSlug: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Recipient studio slug for routing (matches studios.slug). Pass "main" to target the user\'s root-repo studio. Preferred over recipientStudioHint — accepts any studio slug, not just "main".'
    ),
  recipientStudioHint: z
    .enum(['main'])
    .optional()
    .describe(
      'DEPRECATED — use recipientStudioSlug instead. Kept for backward compatibility with callers that pass the literal string "main".'
    ),
  sessionAlias: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Target a recipient session by alias (e.g., "main", "review"). The recipient agent must have an active session with this alias.'
    ),
  relatedArtifactUri: z.string().optional().describe('Related artifact URI'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  expiresAt: z.string().datetime().optional().describe('When this message expires'),
  threadKey: z
    .string()
    .optional()
    .describe(
      'Thread key for conversation continuity (e.g., "pr:32", "spec:cli-hooks"). When provided, messages are stored in thread tables and all participants see the full history. Without it, messages go to the simple agent_inbox. Format: <type>:<identifier>.'
    ),
  // Trigger options - automatically trigger the recipient after sending
  trigger: z
    .boolean()
    .optional()
    .describe(
      'Whether to trigger (wake) recipient agents after sending. Defaults to true. When false, overrides triggerAll and triggerAgents — no agents are triggered. Only set to false if the message can genuinely wait 5+ hours. Most agents do not have heartbeats — untriggered messages may never be seen.'
    ),
  triggerType: z
    .enum(['task_complete', 'approval_needed', 'message', 'error', 'custom'])
    .optional()
    .describe('Type of trigger (only used if trigger=true)'),
  triggerSummary: z
    .string()
    .optional()
    .describe('Brief summary for the trigger (only used if trigger=true)'),
  triggerAll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Trigger all thread participants (except sender). Only applies to thread messages. Overridden by triggerAgents.'
    ),
  triggerAgents: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe(
      'Trigger specific thread participants by agent ID. Takes highest precedence. Non-participants are silently ignored.'
    ),
});

export interface ThreadPageRow {
  id: string;
  thread_key: string;
  title: string | null;
  user_id: string;
  created_by_agent_id: string;
  updated_at: string | null;
}

/**
 * Check if a thread is owned by a specific studio based on the agent's
 * message metadata. Used by channelPoll filtering.
 *
 * Returns true (accept) when:
 * - Agent has no messages on the thread (new/broadcast — accept in any studio)
 * - Agent's messages include one sent FROM this studioId
 * - Agent's messages include one with recipient.studioId matching this studio
 *   (cross-studio self-message targeting this studio)
 *
 * Returns false (skip) when:
 * - Agent has messages but none match this studioId as sender or recipient
 */
export function isThreadOwnedByStudio(
  agentMessages: Array<{ metadata: unknown }>,
  callerStudioId: string
): boolean {
  if (!agentMessages.length) return true; // no messages from us — broadcast

  return agentMessages.some((m) => {
    const pcp = (m.metadata as Record<string, unknown>)?.pcp as Record<string, unknown> | undefined;
    // Check sender studioId (standard ownership)
    const sender = pcp?.sender as Record<string, unknown> | undefined;
    if (sender?.studioId === callerStudioId) return true;
    // Check recipient studioId (cross-studio self-message targeting this studio)
    const recipient = pcp?.recipient as Record<string, unknown> | undefined;
    if (recipient?.studioId === callerStudioId) return true;
    return false;
  });
}

const getInboxSchema = userIdentifierBaseSchema
  .extend({
    agentId: z
      .string()
      .optional()
      .describe(
        'Agent ID to get inbox for. Omit to get inbox across ALL agents (useful for unified timelines).'
      ),
    status: z
      .enum(['unread', 'read', 'acknowledged', 'completed', 'all'])
      .optional()
      .default('unread')
      .describe(
        "Filter by status. 'unread' (default) means UNSEEN — messages newer than your " +
          'read pointer — not rows whose status column happens to say "unread". The other ' +
          'values filter the status column, which records explicit workflow actions ' +
          '(read/acknowledged/completed) and is never cleared by reading.'
      ),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Filter by priority'),
    messageType: z
      .enum(['message', 'task_request', 'session_resume', 'notification', 'permission_grant'])
      .optional(),
    limit: z.number().min(1).max(200).optional().default(20).describe('Max messages'),
    since: z
      .string()
      .datetime()
      .optional()
      .describe('Only return messages created after this ISO timestamp'),
    threadKey: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*:[^\s]+$/)
      .optional()
      .describe(
        'Filter to a conversation thread. Aliases through to get_thread_messages ' +
          '(thread messages are stored separately from the legacy inbox; participant ' +
          'membership and read-state are respected). Requires agentId. status "all" ' +
          'maps to the full thread history; priority/messageType/since do not apply.'
      ),
    channelPoll: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'When true, filter threads by studio ownership using the studioId from request context. ' +
          'Used by channel plugins to only receive threads belonging to their studio. ' +
          'Threads with no studio affinity (new, unrouted) are included as broadcast.'
      ),
    markRead: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Whether this read advances your inbox read pointer. Pass false to observe without ' +
          'draining — watchers and pollers that manage their own cursor MUST do this ' +
          '(spec inkmail-read-state §7: observing is not delivering). Mirrors ' +
          'get_thread_messages. The pointer only ever advances over messages this call ' +
          'actually returned: a filtered or truncated page never advances it.'
      ),
    // .strict(): unknown keys are REJECTED with their names in the error, not
    // silently stripped. The callers here are LLMs — a plausible-but-wrong
    // parameter silently ignored produces confident wrong conclusions (Myra
    // concluded her inbox was empty), while a named rejection self-corrects on
    // the next attempt. Conor-approved for this scenario (2026-08-10).
  })
  .strict();

const updateInboxMessageSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().uuid().describe('Message ID to update'),
  agentId: z.string().describe('Agent ID making the update (must be recipient)'),
  status: z.enum(['read', 'acknowledged', 'completed']).describe('New status'),
});

const markInboxReadSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID whose inbox to mark as read'),
  before: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Mark messages as read up to this timestamp (ISO 8601). Defaults to now — marks all current messages as read.'
    ),
  throughMessageId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Exact-id acknowledgement: advance the pointer through this specific message. ' +
        'The delivery ack for legacy inbox consumers (mirrors mark_thread_read). Takes precedence over `before`.'
    ),
});

const getAgentStatusSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID to check status for'),
});

const getAgentSummariesSchema = userIdentifierBaseSchema.extend({
  agentIds: z
    .array(z.string())
    .optional()
    .describe(
      'Specific agent IDs to summarize. Omit to auto-discover all agents from agent_identities.'
    ),
});

// ============== Handlers ==============

/**
 * Warn when a thread key is about to pin an intended project prefix as a type.
 *
 * Advisory only. An unregistered first segment is legal — the parsers accept
 * unknown types deliberately — so this must not block a send. It exists
 * because the alternative is silence: the key records a different identity
 * than the sender meant, permanently, and nothing reports it.
 *
 * Never throws. A registry that cannot be read is a reason to stay quiet, not
 * a reason to fail someone's message.
 */
async function warnOnUnregisteredProjectPrefix(
  supabase: SupabaseClient<Database>,
  userId: string,
  threadKey: string
): Promise<string | undefined> {
  try {
    const service = new ThreadKeyService(supabase);
    const [slugLookup, knownTypes] = await Promise.all([
      service.projectSlugLookup(userId),
      service.knownTypeNames(userId),
    ]);

    const found = detectUnregisteredProjectPrefix(threadKey, slugLookup, knownTypes);
    if (!found) return undefined;

    const message = describeUnregisteredProjectPrefix(threadKey, found);
    logger.warn('Thread key uses an unregistered project prefix', {
      userId,
      threadKey,
      suspectedProject: found.suspectedProject,
      pinnedAsType: found.pinnedAsType,
    });
    return message;
  } catch (error) {
    logger.debug('Could not check thread key prefix', {
      threadKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function handleSendToInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = sendToInboxSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    recipientAgentId,
    recipients,
    subject,
    content,
    messageType = 'message',
    priority = 'normal',
    recipientSessionId,
    recipientStudioId,
    recipientStudioSlug,
    recipientStudioHint,
    relatedArtifactUri,
    metadata = {},
    expiresAt,
    triggerType,
    triggerSummary,
    threadKey,
    triggerAll,
    triggerAgents,
    sessionAlias,
  } = parsed;

  // Merge recipientStudioSlug (preferred) and recipientStudioHint (legacy alias).
  // Downstream code treats these uniformly — both resolve via resolveStudioHint,
  // which does isMainStudio + slug lookup. If both are provided, slug wins.
  const recipientStudioSlugOrHint: string | undefined =
    recipientStudioSlug || recipientStudioHint || undefined;

  // Validate: exactly one of recipientAgentId or recipients
  const hasSingle = !!recipientAgentId;
  const hasMany = !!recipients?.length;
  if (hasSingle === hasMany) {
    throw new Error('Provide exactly one of recipientAgentId or recipients');
  }
  if (hasMany && !threadKey) {
    throw new Error('threadKey is required when using recipients[]');
  }
  if (
    recipients &&
    (recipientSessionId || recipientStudioId || recipientStudioSlugOrHint || sessionAlias)
  ) {
    throw new Error(
      'recipientSessionId/recipientStudioId/recipientStudioSlug/recipientStudioHint/sessionAlias are only valid for single-recipient sends'
    );
  }

  // Resolve sender identity: pinned/explicit → request context sbId → context agentId → unknown
  let senderAgentId = getEffectiveAgentId(parsed.senderAgentId);
  if (!senderAgentId) {
    const reqCtx = getRequestContext() || getSessionContext();
    if (reqCtx?.sbId) {
      senderAgentId =
        (await resolveAgentSlug(dataComposer.getClient(), reqCtx.sbId)) || reqCtx.agentId;
    } else if (reqCtx?.agentId) {
      senderAgentId = reqCtx.agentId;
    }
  }
  const triggerSenderId = senderAgentId || 'unknown';

  // SECURITY: permission_grant messages can only originate from the system layer
  // (platform listeners verifying human identity), never from agents.
  // See ink://specs/2fa-permission-grants for the full design.
  if (messageType === 'permission_grant' && senderAgentId) {
    throw new Error(
      'permission_grant messages cannot be sent by agents — must originate from platform verification'
    );
  }
  const effectiveRecipientSessionId = recipientSessionId;

  // Default trigger behavior:
  // All message types trigger by default. Most agents don't have heartbeats,
  // so untriggered messages may sit unread for hours. Only set trigger=false
  // for messages that can genuinely wait 5+ hours.
  const trigger = parsed.trigger ?? true;

  // ── Resolve sender session context (shared by both thread and legacy paths) ──
  // This must happen BEFORE the thread/legacy branch so thread messages also
  // capture the sender's session ID for reply-routing.
  const reqCtx = getRequestContext();
  const sessCtx = getSessionContext();
  let senderSessionId: string | null = reqCtx?.sessionId || sessCtx?.sessionId || null;
  const senderStudioId = reqCtx?.studioId || sessCtx?.studioId || null;

  // When the caller's session ID wasn't provided via request context headers
  // (x-ink-context token, or legacy x-ink-session-id), try threadKey-scoped
  // lookup as a deterministic fallback.
  // We intentionally do NOT fall back to "most recent active session" — that's
  // non-deterministic and can route replies to the wrong worktree/studio.
  if (!senderSessionId && senderAgentId && threadKey) {
    try {
      const threadSession = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
        resolved.user.id,
        senderAgentId,
        threadKey,
        senderStudioId
      );
      if (threadSession) {
        senderSessionId = threadSession.id;
        logger.debug('Resolved sender session from threadKey match (no header)', {
          senderAgentId,
          threadKey,
          senderSessionId,
        });
      }
    } catch (err) {
      logger.warn('Failed to resolve sender session from threadKey', {
        error: err instanceof Error ? err.message : String(err),
        senderAgentId,
        threadKey,
      });
    }
  }

  // Track whether session context is missing — used to suppress triggers
  // and warn the sender. Without session context, reply routing is broken
  // (recipients can't auto-resolve back to the sender's session/studio).
  //
  // 'system' and 'unknown' are exempt: they are canonical senders for
  // heartbeat/watchdog/platform-originated sends that run outside a request
  // context (no x-ink-context token, no session). Suppressing those triggers
  // silently broke the strategy watchdog. Since they have no reply session
  // anyway, the routing concerns that justify suppression don't apply.
  // Relay identities are excluded from caller-repo inference (spec §Tier 7).
  // Resolved here, beside the other sender context, so every dispatch site
  // below gets it without repeating the lookup.
  // Canonical identity from the SAME context token, so classification is not
  // slug-ambiguous: two ordinary agents sharing a slug were both being
  // classified as bridges and losing caller-repo inference entirely
  // (Lumen, PR #514 round 3).
  const senderIsBridge = await isBridgeIdentity(
    supabase,
    resolved.user.id,
    senderAgentId,
    senderSbIdFromContext()
  );

  const nonAgentSender = triggerSenderId === 'system' || triggerSenderId === 'unknown';
  const missingSenderSession = !senderSessionId && !!senderAgentId && !nonAgentSender;

  // ── Thread-first path: when threadKey is provided, route to thread tables ──
  // Unified handler for both new thread creation and replies to existing threads.
  // Single-recipient with threadKey creates a 2-participant thread (spec invariant #5).
  // recipients[] creates a multi-participant thread.
  // Without threadKey, falls through to legacy agent_inbox path.
  let prefixWarning: string | undefined;

  if (threadKey) {
    const allRecipients = recipients || [recipientAgentId!];

    // Check if thread already exists — determines reply vs create behavior
    const existingThread = await findExistingThread(supabase, resolved.user.id, threadKey);

    // Only meaningful before creation: an existing thread's identity was pinned
    // when it was made and cannot be revised now.
    if (!existingThread) {
      prefixWarning = await warnOnUnregisteredProjectPrefix(supabase, resolved.user.id, threadKey);
    }

    // ── Reply semantics: enforce participant membership and closed-thread rejection ──
    if (existingThread) {
      // Reject replies on closed threads
      if (existingThread.status === 'closed') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Thread ${threadKey} is closed. Cannot send to closed threads.`,
              }),
            },
          ],
        };
      }

      // If sender is already a participant, this is a reply — enforce membership
      // If sender is NOT a participant, auto-add them (join-on-send)
    }

    // Find or create thread
    let thread = await findOrCreateThread(supabase, {
      userId: resolved.user.id,
      threadKey,
      creatorAgentId: triggerSenderId,
      title: subject || null,
      participants: senderAgentId ? [...new Set([senderAgentId, ...allRecipients])] : allRecipients,
    });

    // Include sender as participant if they have an identity
    const allParticipants = senderAgentId
      ? [...new Set([senderAgentId, ...allRecipients])]
      : allRecipients;

    // Cross-studio self-message: sender targets themselves in a different studio.
    // The PK is (thread_id, agent_id) so there's only ONE participant row — stamping
    // session_id would scope it to one studio and hide it from the other. Leave null
    // so both sessions see the thread.
    const isCrossStudioSelf = !!(
      senderAgentId &&
      senderAgentId === recipientAgentId &&
      (recipientStudioId || recipientStudioSlugOrHint)
    );

    // Ensure all participants are registered (recipients + sender for existing threads).
    // Stamp session_id so channel plugins can filter threads to their session.
    for (const participantAgentId of allParticipants) {
      const isSender = participantAgentId === senderAgentId;
      const participantSessionId =
        isCrossStudioSelf && participantAgentId === senderAgentId
          ? null
          : isSender
            ? senderSessionId
            : recipientSessionId || null;

      const { data: existing } = await threadTable(supabase, 'inbox_thread_participants')
        .select('agent_id, session_id')
        .eq('thread_id', thread.id)
        .eq('agent_id', participantAgentId)
        .maybeSingle();

      if (!existing) {
        await threadTable(supabase, 'inbox_thread_participants').insert({
          thread_id: thread.id,
          agent_id: participantAgentId,
          ...(participantSessionId ? { session_id: participantSessionId } : {}),
        });
      } else if (participantSessionId) {
        // Sender's session is authoritative (they know their own session).
        // Recipient's session is a hint — only backfill null; the trigger
        // handler stamps the real session after getOrCreateSession().
        const shouldUpdate = isSender
          ? existing.session_id !== participantSessionId
          : !existing.session_id;
        if (shouldUpdate) {
          await threadTable(supabase, 'inbox_thread_participants')
            .update({ session_id: participantSessionId })
            .eq('thread_id', thread.id)
            .eq('agent_id', participantAgentId);
        }
      }
    }

    // Enrich thread message metadata with sender session context so replies
    // can route back to the correct session/studio.
    const rawMeta =
      metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    const existingPcpMeta =
      rawMeta.pcp && typeof rawMeta.pcp === 'object'
        ? (rawMeta.pcp as Record<string, unknown>)
        : {};
    // Cross-studio self-messaging: stamp recipient studio on the message
    // so the channelPoll filter can recognize the target studio as an owner.
    // Resolve recipientStudioSlug/Hint to a studioId if needed.
    let resolvedRecipientStudioId: string | undefined = recipientStudioId || undefined;
    const resolveAgentForStudio = recipientAgentId || senderAgentId;
    if (!resolvedRecipientStudioId && recipientStudioSlugOrHint && resolveAgentForStudio) {
      try {
        // Resolve in the recipient's scope so cross-agent sends (sender=wren,
        // recipient=myra) find the recipient's studio, not the sender's.
        const reqCtxForHint = getRequestContext();
        resolvedRecipientStudioId = await resolveStudioHint(
          supabase,
          resolved.user.id,
          recipientStudioSlugOrHint,
          resolveAgentForStudio,
          reqCtxForHint?.repoRoot
        );
      } catch {
        // Best-effort resolution — proceed without stamping
      }
    }

    const selfStudioRecipient = !!(
      senderAgentId &&
      resolvedRecipientStudioId &&
      allRecipients.includes(senderAgentId)
    );
    const threadMessageMetadata = {
      ...rawMeta,
      pcp: {
        ...existingPcpMeta,
        sender: {
          agentId: triggerSenderId,
          sessionId: senderSessionId,
          studioId: senderStudioId,
        },
        ...(selfStudioRecipient ? { recipient: { studioId: resolvedRecipientStudioId } } : {}),
      },
    };

    // Insert thread message
    const { data: threadMessage, error: tmError } = await threadTable(
      supabase,
      'inbox_thread_messages'
    )
      .insert({
        thread_id: thread.id,
        sender_agent_id: triggerSenderId,
        content,
        message_type: messageType === 'permission_grant' ? 'message' : messageType,
        priority,
        metadata: threadMessageMetadata as Json,
      })
      .select()
      .single();

    if (tmError) {
      throw new Error(`Failed to send thread message: ${tmError.message}`);
    }

    // Update thread updated_at
    await threadTable(supabase, 'inbox_threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', thread.id);

    // Update sender's read status — through the just-inserted message via the
    // atomic RPC, never wall-clock (spec: ink://specs/inkmail-read-state §1-2).
    //
    // Self-addressing exemption: when the sender targets ANOTHER of their own
    // sessions/studios (senderAgentId is a recipient + explicit studio/session
    // target), do NOT advance. There is only one (thread_id, agent_id)
    // pointer; advancing at insert would make the target instance see the
    // message as already read before delivery. The target's delivery advances
    // the shared pointer instead.
    // Explicit self-target: the sender addresses ANOTHER of their own
    // sessions/studios — by studio id/slug, session id, OR session alias.
    // ONE predicate drives both the sender-advance exemption and trigger
    // self-inclusion so the two can never disagree (Lumen, PR #454 review:
    // alias self-sends were advanced before fetch while session-id self-sends
    // were filtered out of triggering).
    const explicitSelfTarget = !!(
      senderAgentId &&
      allRecipients.includes(senderAgentId) &&
      (recipientStudioId || recipientStudioSlugOrHint || recipientSessionId || sessionAlias)
    );
    if (senderAgentId && threadMessage?.id && !explicitSelfTarget) {
      await advanceThreadReadPointer(supabase, {
        threadId: thread.id,
        agentId: senderAgentId,
        throughMessageId: threadMessage.id,
        source: 'send_to_inbox:sender',
      });
    }

    // ── Trigger resolution ──
    // For existing threads (replies), use smart trigger rules from resolveTriggeredAgents.
    // For new threads, trigger all recipients (existing behavior).
    let agentsToTrigger: string[] = [];

    // Cross-studio/session self-messaging must not exclude self from trigger
    // resolution — same predicate as the sender-advance exemption above.
    const selfStudioTarget = explicitSelfTarget;

    if (trigger !== false && !missingSenderSession) {
      if (existingThread && senderAgentId) {
        // Reply: fetch current participants from DB for accurate trigger resolution
        const currentParticipants = await getParticipants(supabase, thread.id);
        agentsToTrigger = resolveTriggeredAgents({
          senderAgentId,
          participants: currentParticipants,
          creatorAgentId: existingThread.created_by_agent_id,
          triggerAgents,
          triggerAll,
          messageType,
          recipients: allRecipients,
          selfStudioTarget,
        });
      } else {
        // New thread: trigger all recipients (exclude sender unless cross-studio
        // self-message or actionable self-target like strategy kickoff)
        const actionableSelf = new Set(['task_request', 'session_resume']);
        const allowSelf = selfStudioTarget || (!!messageType && actionableSelf.has(messageType));
        agentsToTrigger = allRecipients.filter((a) => allowSelf || a !== senderAgentId);
      }
    }

    logger.info('Thread message sent', {
      messageId: threadMessage.id,
      threadKey,
      to: allRecipients,
      from: triggerSenderId,
      type: messageType,
      isNewThread: thread.isNew,
      triggering: agentsToTrigger,
      recipientStudioId: recipientStudioId || null,
      recipientStudioHint: recipientStudioHint || null,
      resolvedRecipientStudioId: resolvedRecipientStudioId || null,
      effectiveRecipientSessionId: effectiveRecipientSessionId || null,
    });

    // Dispatch: assignment is wake-independent (§3a). EVERY recipient gets a
    // dispatch — wake only for agentsToTrigger; the rest go routeOnly so their
    // session is still assigned/stamped (trigger:false / missingSenderSession
    // must never mean unaddressed).
    const triggeredAgents: string[] = [];
    // Assignment failures per recipient (Lumen, PR #460 round 2): a send whose
    // routing stamp did not persist must NOT return unqualified success —
    // for trigger:false recipients no wake follows, so an unstamped thread
    // is invisible to stamped-only polling with no retry coming.
    const routingFailures: Array<{ agentId: string; error: string }> = [];
    // Union with agentsToTrigger: actionable self-sends (session_resume /
    // task_request strategy kickoffs) wake self without an explicit
    // studio/session target and must keep dispatching.
    const routingSet = [
      ...new Set([
        ...allRecipients.filter((a) => a !== senderAgentId || explicitSelfTarget),
        ...agentsToTrigger,
      ]),
    ];
    if (routingSet.length > 0) {
      const gateway = getAgentGateway();

      for (const toAgentId of routingSet) {
        const wake = agentsToTrigger.includes(toAgentId);
        // Auto-resolve recipientSessionId: find the recipient's most recent
        // message on this thread to extract their sender session. This ensures
        // replies route back to the session that originated the conversation,
        // not whatever session happens to be most recently updated.
        //
        // Cross-studio self-message: when sender === recipient, skip auto-resolve
        // from thread history (it would find our own session). The trigger system
        // will use recipientStudioId to route to the correct studio session.
        let resolvedRecipientSessionId: string | undefined =
          effectiveRecipientSessionId || undefined;
        const isSelfStudioMessage = selfStudioTarget && toAgentId === senderAgentId;
        if (!resolvedRecipientSessionId && !isSelfStudioMessage) {
          try {
            const { data: recipientMsg } = await threadTable(supabase, 'inbox_thread_messages')
              .select('metadata')
              .eq('thread_id', thread.id)
              .eq('sender_agent_id', toAgentId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            const recipientPcp = (recipientMsg?.metadata as Record<string, unknown>)?.pcp as
              | Record<string, unknown>
              | undefined;
            const recipientSender = recipientPcp?.sender as Record<string, unknown> | undefined;
            if (recipientSender?.sessionId && typeof recipientSender.sessionId === 'string') {
              resolvedRecipientSessionId = recipientSender.sessionId;
              logger.debug('[ThreadTrigger] Auto-resolved recipientSessionId from thread history', {
                threadKey,
                toAgentId,
                recipientSessionId: resolvedRecipientSessionId,
              });
            }
          } catch (err) {
            logger.warn('[ThreadTrigger] Failed to resolve recipientSessionId from thread', {
              threadKey,
              toAgentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Targeted studio routing: propagate studioId/Hint to the trigger
        // payload for the agent the caller specifically addressed. Covers
        // both self-studio sends (sender == recipient, different worktree)
        // and cross-agent delegation (e.g., strategy service → owner agent
        // in group.metadata.studioId). Incidental trigger participants —
        // like a thread creator auto-woken on reply — do NOT inherit the
        // routing, since the caller only explicitly targeted recipientAgentId.
        //
        // Before this fix, studio was only forwarded when `isSelfStudioMessage`
        // was true, so system/human → owner delegation lost the assigned
        // studio and fell back to route patterns / default studio.
        const isAddressedRecipient = !recipients && toAgentId === recipientAgentId;
        // Anchor provenance (spec §3b.1): only CALLER-passed targeting counts
        // as the deliberate-retarget signal. History-inferred
        // recipientSessionId is a continuity hint, never an overwrite.
        const explicitRecipientTarget = !!(
          isAddressedRecipient &&
          (recipientSessionId || sessionAlias || recipientStudioId || recipientStudioSlugOrHint)
        );
        const payload: AgentTriggerPayload = {
          fromAgentId: triggerSenderId,
          toAgentId,
          threadId: thread.id,
          threadMessageId: threadMessage.id,
          triggerType: triggerType || 'message',
          summary:
            triggerSummary ||
            subject ||
            `New ${messageType} in thread ${threadKey} from ${triggerSenderId}`,
          priority,
          threadKey,
          recipientSessionId: resolvedRecipientSessionId,
          // Server-derived, from the same context token that stamps
          // metadata.pcp.sender.studioId — never caller body data.
          ...senderRoutingContext(senderIsBridge),
          ...(explicitRecipientTarget ? { explicitRecipientTarget } : {}),
          ...(isAddressedRecipient && sessionAlias ? { sessionAlias } : {}),
          ...(isAddressedRecipient && resolvedRecipientStudioId
            ? { studioId: resolvedRecipientStudioId }
            : {}),
          ...(isAddressedRecipient && !resolvedRecipientStudioId && recipientStudioSlugOrHint
            ? { studioHint: recipientStudioSlugOrHint }
            : {}),
          ...(Object.keys(rawMeta).length > 0 ? { metadata: rawMeta } : {}),
        };

        // 1) Assignment — SYNCHRONOUS (spec §3a): processTrigger awaits the
        //    handler, so the participant stamp is durable before send returns.
        //    A crash after this line cannot orphan the message. A FAILED
        //    assignment (success:false or throw) is captured per recipient
        //    and surfaced in the response — never swallowed into success.
        try {
          const assignResult = await gateway.processTrigger({ ...payload, routeOnly: true });
          if (!assignResult.success) {
            routingFailures.push({
              agentId: toAgentId,
              error: assignResult.error || 'assignment failed',
            });
            logger.warn('[ThreadTrigger] Synchronous assignment failed', {
              threadKey,
              toAgentId,
              error: assignResult.error || 'assignment failed',
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          routingFailures.push({ agentId: toAgentId, error: message });
          logger.warn('[ThreadTrigger] Synchronous assignment failed', {
            threadKey,
            toAgentId,
            error: message,
          });
        }

        // 2) Wake — optional, fire-and-forget, rides the fresh stamp via
        //    thread continuity. Still attempted after an assignment failure:
        //    the wake handler re-runs assignment (a transient DB error may
        //    clear) and the wake itself surfaces the message to the agent.
        if (wake) {
          const result = gateway.dispatchTrigger(payload);
          if (result.accepted) {
            triggeredAgents.push(toAgentId);
          }
        }
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: routingFailures.length === 0,
            message:
              routingFailures.length === 0
                ? `Thread message sent to ${threadKey}`
                : `Thread message stored in ${threadKey}, but session routing FAILED for: ${routingFailures
                    .map((f) => f.agentId)
                    .join(
                      ', '
                    )}. Untriggered recipients will NOT see it via inbox polling until routing succeeds — resend or re-trigger to retry assignment.`,
            ...(routingFailures.length > 0 ? { routingFailures } : {}),
            messageId: threadMessage.id,
            threadKey,
            threadId: thread.id,
            isNewThread: thread.isNew,
            // Distinct from `warning` below so a key problem and a session
            // problem can both be reported on the same send.
            ...(prefixWarning ? { threadKeyWarning: prefixWarning } : {}),
            recipients: allRecipients,
            participants: allParticipants,
            messageType,
            priority,
            triggered: triggeredAgents,
            createdAt: threadMessage.created_at,
            ...(missingSenderSession
              ? {
                  warning:
                    'Session context missing (no x-ink-context token or x-ink-session-id header). Triggers suppressed — recipients will not be woken. They will see this message on their next inbox check. To fix: set the x-ink-context header on your MCP connection (the ink CLI does this automatically). For unsupported runtimes, use a heartbeat cron to periodically call get_inbox and process pending messages.',
                }
              : {}),
          }),
        },
      ],
    };
  }

  // ── Legacy path: simple inbox message (no threadKey) ──
  const hasRoutingAnchor = Boolean(
    effectiveRecipientSessionId || recipientStudioId || recipientStudioSlugOrHint
  );
  const requiresRoutingAnchor = Boolean(senderAgentId) && messageType !== 'message';
  const missingRoutingAnchor = requiresRoutingAnchor && !hasRoutingAnchor;
  if (missingRoutingAnchor) {
    logger.warn('send_to_inbox missing routing anchor for actionable handoff', {
      messageType,
      recipientAgentId,
      senderAgentId,
    });
  }

  // senderSessionId and senderStudioId already resolved above (shared with thread path)
  const metadataRecord =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const existingPcp =
    metadataRecord.pcp && typeof metadataRecord.pcp === 'object'
      ? (metadataRecord.pcp as Record<string, unknown>)
      : {};
  const enrichedMetadata = {
    ...metadataRecord,
    pcp: {
      ...existingPcp,
      sender: {
        agentId: triggerSenderId,
        sessionId: senderSessionId,
        studioId: senderStudioId,
      },
      recipient: {
        sessionId: effectiveRecipientSessionId || null,
        studioId: recipientStudioId || null,
        // Metadata field is `studioHint` for backward compat with mission.ts
        // and other consumers that read this blob. recipientStudioSlug feeds
        // into the same slot since both resolve via resolveStudioHint.
        studioHint: recipientStudioSlugOrHint || null,
      },
    },
  };

  // Resolve canonical identity UUIDs for sender and recipient
  const recipientSbId = await resolveIdentityId(supabase, resolved.user.id, recipientAgentId!);
  const senderSbId = senderAgentId
    ? await resolveIdentityId(supabase, resolved.user.id, senderAgentId)
    : null;

  const { data: message, error } = await supabase
    .from('agent_inbox')
    .insert({
      recipient_user_id: resolved.user.id,
      recipient_agent_id: recipientAgentId!,
      recipient_sb_id: recipientSbId,
      sender_user_id: senderAgentId ? null : resolved.user.id,
      sender_agent_id: senderAgentId || null,
      sender_sb_id: senderSbId,
      subject,
      content,
      message_type: messageType,
      priority,
      recipient_session_id: effectiveRecipientSessionId || null,
      related_artifact_uri: relatedArtifactUri || null,
      metadata: enrichedMetadata as Json,
      expires_at: expiresAt || null,
      thread_key: null, // threadKey messages route to thread tables above
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to send inbox message', { error, recipientAgentId });
    throw new Error(`Failed to send message: ${error.message}`);
  }

  logger.info('Inbox message sent', {
    messageId: message.id,
    to: recipientAgentId,
    from: senderAgentId || 'user',
    type: messageType,
    priority,
    trigger,
  });

  // Optionally trigger the recipient agent
  let triggerResult: {
    triggered: boolean;
    triggerId?: string;
    processed?: boolean;
    accepted?: boolean;
    error?: string;
  } = {
    triggered: false,
  };

  if (trigger && !missingSenderSession) {
    const gateway = getAgentGateway();
    const payload: AgentTriggerPayload = {
      fromAgentId: triggerSenderId,
      toAgentId: recipientAgentId!,
      inboxMessageId: message.id,
      triggerType: triggerType || 'message',
      summary: triggerSummary || subject || `New ${messageType} from ${triggerSenderId}`,
      priority,
      recipientSessionId: effectiveRecipientSessionId,
      ...senderRoutingContext(senderIsBridge),
      sessionAlias,
      studioId: recipientStudioId,
      studioHint: recipientStudioSlugOrHint,
      ...(Object.keys(metadataRecord).length > 0 ? { metadata: metadataRecord } : {}),
    };

    logger.info('Inbox message trigger dispatched (async)', {
      messageId: message.id,
      recipientAgentId,
    });

    const result = gateway.dispatchTrigger(payload);

    logger.info('Inbox message trigger accepted', {
      messageId: message.id,
      triggerId: result.triggerId,
      accepted: result.accepted,
      processed: result.processed,
      error: result.error,
    });

    triggerResult = {
      triggered: true,
      triggerId: result.triggerId,
      processed: result.processed,
      accepted: result.accepted,
      error: result.error,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: `Message sent to ${recipientAgentId}${triggerResult.triggered ? ' and triggered' : ''}`,
          messageId: message.id,
          recipientAgentId,
          messageType,
          priority,
          threadKey: null,
          recipientSessionId: effectiveRecipientSessionId || null,
          recipientStudioId: recipientStudioId || null,
          recipientStudioSlug: recipientStudioSlugOrHint || null,
          createdAt: message.created_at,
          trigger: triggerResult,
          ...(missingRoutingAnchor
            ? {
                routingHint:
                  'Actionable handoff is missing a routing anchor. Add one of: threadKey, recipientSessionId, recipientStudioId, or recipientStudioSlug.',
              }
            : {}),
          ...(missingSenderSession
            ? {
                warning:
                  'Session context missing (no x-ink-context token or x-ink-session-id header). Triggers suppressed — recipient will not be woken. They will see this message on their next inbox check. To fix: set the x-ink-context header on your MCP connection (the ink CLI does this automatically). For unsupported runtimes, use a heartbeat cron to periodically call get_inbox and process pending messages.',
              }
            : {}),
          hint: 'Consider adding a threadKey (e.g., "pr:32", "spec:cli-hooks") to route this message to a group thread.',
        }),
      },
    ],
  };
}

/**
 * Find or create a thread. Returns the thread row with an `isNew` flag.
 */
async function findOrCreateThread(
  supabase: ReturnType<DataComposer['getClient']>,
  opts: {
    userId: string;
    threadKey: string;
    creatorAgentId: string;
    title: string | null;
    participants: string[];
  }
): Promise<{ id: string; isNew: boolean }> {
  // Try to find existing
  const { data: existing } = await threadTable(supabase, 'inbox_threads')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('thread_key', opts.threadKey)
    .maybeSingle();

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  // Create new thread
  // Key identity (key_project/key_type/key_id) is pinned by the DB trigger
  // pin_thread_key_before_insert — the DB, not the app, is the pinning
  // authority, so no deploy gap can create an unpinned thread (grammar v4;
  // Lumen PR #516 round 2 conditions 1/4/6).
  const { data: thread, error } = await threadTable(supabase, 'inbox_threads')
    .insert({
      thread_key: opts.threadKey,
      user_id: opts.userId,
      created_by_agent_id: opts.creatorAgentId,
      title: opts.title,
    })
    .select()
    .single();

  if (error) {
    // Race condition: another request may have created it
    if (error.code === '23505') {
      const { data: retry } = await threadTable(supabase, 'inbox_threads')
        .select('id')
        .eq('user_id', opts.userId)
        .eq('thread_key', opts.threadKey)
        .single();
      if (retry) return { id: retry.id, isNew: false };
    }
    throw new Error(`Failed to create thread: ${error.message}`);
  }

  // Add all participants
  const participantRows = opts.participants.map((agentId) => ({
    thread_id: thread.id,
    agent_id: agentId,
  }));
  await threadTable(supabase, 'inbox_thread_participants').insert(participantRows);

  return { id: thread.id, isNew: true };
}

export async function handleGetInbox(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getInboxSchema.parse(args);

  // threadKey aliases through to get_thread_messages (Conor, 2026-08-10):
  // thread messages live in the thread tables, not agent_inbox, and a
  // threadKey is effectively the conversation's title — callers reaching for
  // the inbox with one want the thread timeline, not a silently-empty legacy
  // query. Participant membership and read-state checks are the delegate's.
  if (parsed.threadKey) {
    if (!parsed.agentId) {
      throw new Error(
        'get_inbox with threadKey requires agentId — thread access is participant-scoped. ' +
          'Pass your agentId, or use get_thread_messages directly.'
      );
    }
    // Discovery filters that don't map onto thread reads must reject
    // actionably, not silently return wrong results — e.g. status:'completed'
    // would otherwise return unread-pointer messages AND advance the pointer.
    // Supported: status 'unread' (default → messages since your read pointer)
    // and 'all' (full history).
    const incompatible: string[] = [];
    if (parsed.status !== 'unread' && parsed.status !== 'all') {
      incompatible.push(`status:'${parsed.status}'`);
    }
    if (parsed.priority) incompatible.push('priority');
    if (parsed.messageType) incompatible.push('messageType');
    if (parsed.since) incompatible.push('since');
    if (parsed.channelPoll) incompatible.push('channelPoll');
    if (incompatible.length > 0) {
      throw new Error(
        `get_inbox threadKey mode does not support: ${incompatible.join(', ')}. ` +
          "Thread reads support status 'unread' (default) or 'all'; " +
          'use get_thread_messages for cursor-based paging.'
      );
    }
    return handleGetThreadMessages(
      {
        ...(parsed.userId ? { userId: parsed.userId } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.phone ? { phone: parsed.phone } : {}),
        ...(parsed.platform ? { platform: parsed.platform } : {}),
        ...(parsed.platformId ? { platformId: parsed.platformId } : {}),
        agentId: parsed.agentId,
        threadKey: parsed.threadKey,
        limit: parsed.limit ?? 20,
        // markRead carries through: an observer that must not drain the legacy
        // inbox must not drain a thread either (spec §7).
        markRead: parsed.markRead ?? true,
        // The inbox's "unread by default" maps to the thread read pointer;
        // status 'all' maps to the full timeline.
        ...(parsed.status === 'all' ? { fullHistory: true } : {}),
      },
      dataComposer
    );
  }

  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    status = 'unread',
    priority,
    messageType,
    limit = 20,
    since,
    channelPoll,
    markRead = true,
  } = parsed;
  // Enforce identity: pinned agents can only read their own inbox.
  // When agentId is omitted, return inbox across ALL agents (unified timeline)
  // — EXCEPT for channelPoll, where the gate below derives it from the
  // session so an agent-less poll can never read the all-agent surface.
  let agentId = parsed.agentId
    ? (getEffectiveAgentId(parsed.agentId) ?? parsed.agentId)
    : undefined;

  // Fail-closed (spec inkmail-read-state §3) — FIRST, before ANY read or
  // pointer advance: a channelPoll caller must present BOTH scopes — a
  // resolvable session AND an agent that matches that session — or it gets
  // nothing and touches nothing. agentId is derived from the session row
  // when omitted and validated against it when provided (Lumen, PR #460
  // round 2: an agent-less channelPoll previously passed the gate and read
  // the all-agent legacy inbox). Unlike thread-assignment's liveness check,
  // a session lookup ERROR here fails CLOSED: this is a read-authorization
  // decision, and an unverifiable scope must not widen into a read.
  let callerSessionId: string | null = null;
  if (channelPoll) {
    const reqCtx = getRequestContext();
    const sessCtx = getSessionContext();
    callerSessionId = reqCtx?.sessionId || sessCtx?.sessionId || null;
    let failClosedReason: string | null = null;
    if (!callerSessionId) {
      failClosedReason = 'no session context';
    } else {
      // Scope the lookup to the RESOLVED USER — a session id belonging to a
      // different user must read as not-found, never as a scope source.
      const { data: sessionRow, error: sessionErr } = await supabase
        .from('sessions')
        .select('id, agent_id')
        .eq('id', callerSessionId)
        .eq('user_id', resolved.user.id)
        .maybeSingle();
      const sessionAgentId: string | null = sessionRow?.agent_id ?? null;
      // Pinned identity must agree with the session's agent — otherwise a
      // pinned caller can present another agent's session id, omit agentId,
      // and switch the derived read scope to that agent (Lumen, round 3).
      const pinnedAgentId = getPinnedAgentId();
      if (sessionErr) {
        failClosedReason = `session lookup failed: ${sessionErr.message}`;
      } else if (!sessionRow || !sessionAgentId) {
        failClosedReason = 'session not found for this user or has no agent';
      } else if (pinnedAgentId && pinnedAgentId !== sessionAgentId) {
        failClosedReason = `session agent '${sessionAgentId}' does not match pinned identity '${pinnedAgentId}'`;
      } else if (agentId && agentId !== sessionAgentId) {
        failClosedReason = `agentId '${agentId}' does not match session agent '${sessionAgentId}'`;
      } else {
        agentId = sessionAgentId;
      }
    }
    if (failClosedReason) {
      logger.warn('channel_poll_unscoped', {
        agentId: agentId || null,
        sessionId: callerSessionId,
        userId: resolved.user.id,
        hint: `channelPoll scope invalid (${failClosedReason}) — returning empty (fail-closed)`,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              agentId: agentId || null,
              unreadCount: 0,
              threadUnreadCount: 0,
              totalUnreadCount: 0,
              count: 0,
              messages: [],
              threadsWithUnread: [],
              warning: `channel_poll_unscoped: ${failClosedReason} — delivery disabled (fail-closed)`,
            }),
          },
        ],
      };
    }
  }

  // ── Read state: the pointer is the single source of truth ────────────
  // `agent_inbox` carries two representations of "unread": the per-row `status`
  // column, and the (user, agent) read pointer that migration 20260317 added to
  // REPLACE it. Nothing reconciled them, and this handler used to select the
  // page by one and count by the other — so `unreadCount: 0` sat beside five
  // rows reading `status: "unread"` (Myra, 2026-08-17).
  //
  // They are reconciled here by demoting the column: reading no longer clears
  // it, so `status='unread'` only ever meant "nobody ran an explicit action on
  // this row", which is a workflow fact, not a delivery fact. Unseen-ness is
  // the pointer's job, and `status: 'unread'` now asks the pointer.
  //
  // The floor is captured BEFORE the page query and before any advance. Reading
  // it afterwards is what made the count structurally zero: the same call moved
  // the pointer past everything it was about to count.
  let unreadFloor: string | null = null;
  if (agentId) {
    const { data: readStatus, error: pointerErr } = await threadTable(
      supabase,
      'agent_inbox_read_status'
    )
      .select('last_read_at')
      .eq('user_id', resolved.user.id)
      .eq('agent_id', agentId)
      .maybeSingle();
    if (pointerErr) {
      // Fail LOUD but open: a missing floor over-reports (every message looks
      // unseen), which is the safe direction — the opposite silently empties
      // the mailbox, which is the bug being fixed.
      logger.error('[ReadState] Failed to read inbox pointer; treating inbox as fully unread', {
        agentId,
        userId: resolved.user.id,
        error: pointerErr.message,
      });
    }
    unreadFloor = readStatus?.last_read_at ?? null;
  } else {
    // All-agent timeline: no single pointer applies, so use the OLDEST across
    // agents. Over-counts (a message read by one agent still counts for the
    // aggregate) and is documented as such — "does anyone have unread mail".
    //
    // But ONLY over-counts if every recipient with mail HAS a pointer row. A
    // recipient represented in agent_inbox with no pointer (Echo: July mail,
    // no row) would be hidden behind the other agents' aggregate floor — an
    // under-count to zero, the exact bug class this handler fixes. Any such
    // recipient forces a NULL floor (everything counts). Fail open on lookup
    // errors for the same reason.
    const { data: readStatuses } = await threadTable(supabase, 'agent_inbox_read_status')
      .select('agent_id, last_read_at')
      .eq('user_id', resolved.user.id);
    const pointerAgents = (readStatuses || []).map((rs: { agent_id: string }) => rs.agent_id);
    let floorless = pointerAgents.length === 0;
    if (!floorless) {
      const { data: unpointered, error: unpointeredErr } = await supabase
        .from('agent_inbox')
        .select('id')
        .eq('recipient_user_id', resolved.user.id)
        .not('recipient_agent_id', 'is', null)
        .not('recipient_agent_id', 'in', `(${pointerAgents.join(',')})`)
        .limit(1);
      floorless = unpointeredErr ? true : (unpointered?.length ?? 0) > 0;
    }
    unreadFloor = floorless
      ? null
      : (readStatuses || []).reduce(
          (oldest: string | null, rs: { last_read_at: string }) =>
            !oldest || rs.last_read_at < oldest ? rs.last_read_at : oldest,
          null
        );
  }

  // The CONSUMING path: an unfiltered unread read that will advance the
  // pointer. Every status:'unread' page selects the OLDEST unseen batch
  // (ascending, id as deterministic tie order) so both the consuming path and
  // exact-ack pagers (the channel plugin) drain contiguously — newest-first
  // selection returned the same page forever once truncated, with no cursor
  // to the remainder (Lumen #504 r1 P1). The response is re-ordered
  // newest-first for display either way.
  const consumingUnread =
    status === 'unread' && markRead && !!agentId && !priority && !messageType && !since;
  const oldestFirst = status === 'unread';

  let query = supabase
    .from('agent_inbox')
    .select('*')
    .eq('recipient_user_id', resolved.user.id)
    .order('created_at', { ascending: oldestFirst })
    .order('id', { ascending: oldestFirst })
    .limit(limit);

  if (agentId) {
    query = query.eq('recipient_agent_id', agentId);
  }
  if (status === 'unread') {
    if (unreadFloor) {
      query = query.gt('created_at', unreadFloor);
    }
  } else if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (since) {
    query = query.gt('created_at', since);
  }
  if (priority) {
    query = query.eq('priority', priority);
  }
  if (messageType) {
    query = query.eq('message_type', messageType);
  }

  // Exclude expired messages
  query = query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

  const { data: fetched, error } = await query;

  if (error) {
    throw new Error(`Failed to get inbox: ${error.message}`);
  }

  // TIE-GROUP COMPLETION (Lumen #504 r2 P1): the stored pointer is a bare
  // timestamp, and now() is transaction-stable, so identical created_at
  // values are normal. If the limit cut the batch mid-tie, advancing (or an
  // exact ack) through the boundary timestamp would consume the unreturned
  // siblings. Extend the page with every remaining row that shares the
  // boundary timestamp so a tie group is always delivered whole.
  let page = fetched ?? [];
  // Only ack-capable shapes (no narrowing filters) extend: a filtered page
  // never advances the pointer OR acks, so completion there would smuggle
  // rows the caller filtered OUT (urgent-only limit:1 returned a normal
  // task request sharing the boundary timestamp — Lumen #504 r3 P2).
  const tieCompletionApplies = oldestFirst && !priority && !messageType && !since;
  if (tieCompletionApplies && page.length >= limit && page.length > 0) {
    const boundary = (page[page.length - 1] as { created_at: string }).created_at;
    const pageIds = page.map((m) => (m as { id: string }).id);
    let tieQuery = supabase
      .from('agent_inbox')
      .select('*')
      .eq('recipient_user_id', resolved.user.id)
      .eq('created_at', boundary)
      .not('id', 'in', `(${pageIds.join(',')})`)
      .order('id', { ascending: true });
    if (agentId) tieQuery = tieQuery.eq('recipient_agent_id', agentId);
    tieQuery = tieQuery.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    const { data: siblings, error: tieError } = await tieQuery;
    if (tieError) {
      throw new Error(`Failed to complete timestamp tie group: ${tieError.message}`);
    }
    if (siblings?.length) page = [...page, ...siblings];
  }

  // Display contract stays newest-first; only the SELECTION flipped.
  const messages = oldestFirst ? [...page].reverse() : page;

  // Count unread BEFORE advancing anything. `unreadCount` describes the
  // mailbox, not this query: it always uses the pointer predicate, whatever
  // `status` the caller filtered the page by. When status is 'unread' the page
  // and the count share a predicate by construction, so `count` can differ from
  // `unreadCount` only by `limit` truncation — which is reported below.
  let countQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id);
  if (agentId) {
    countQuery = countQuery.eq('recipient_agent_id', agentId);
  }
  if (unreadFloor) {
    countQuery = countQuery.gt('created_at', unreadFloor);
  }
  // Expired messages are excluded from the page, so they must be excluded here
  // too — a counter that includes rows the caller can never see is the same
  // class of lie as the one this fixes.
  countQuery = countQuery.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
  const { count: unreadCountRaw, error: countError } = await countQuery;
  if (countError) {
    throw new Error(`Failed to count unread inbox messages: ${countError.message}`);
  }
  const unreadCount = unreadCountRaw || 0;

  // A page smaller than the backlog means the caller did NOT see everything
  // above the floor. Surfaced so a poller can tell "drained" from "capped".
  const pageTruncated = status === 'unread' && unreadCount > (messages?.length || 0);

  // ── Advance the pointer, but only over messages actually returned ────
  // Only the consuming path advances (observer reads and filtered pages never
  // do — a narrowed page whose newest row is newer than mail the caller never
  // saw buries that mail permanently; one get_inbox(priority:'urgent') used
  // to do exactly that). The consuming page is the OLDEST unseen batch, so
  // advancing through the batch maximum is contiguous with the floor and
  // skips nothing — truncation no longer blocks progress, it just means the
  // next call gets the next batch (Lumen #504 r1 P1).
  let readPointerAdvanced = false;
  let readPointerAt: string | null = null;
  if (consumingUnread && messages?.length) {
    // Display order is newest-first, so messages[0] is the batch maximum.
    const newest = messages[0] as { id: string; created_at: string };
    const advance = await advanceAgentInboxReadPointer(supabase, {
      userId: resolved.user.id,
      agentId: agentId!,
      throughMessageId: newest.id,
      source: 'get_inbox:markRead',
    });
    // The MONOTONIC outcome, not RPC success: a concurrent reader may have
    // already moved the pointer past this batch (Lumen #504 r2 P2).
    readPointerAdvanced = advance.changed;
    readPointerAt = advance.lastReadAt;
  }

  // Get threads with unread counts and preview messages.
  // Works with or without agentId — when omitted, finds threads for ALL agents
  // (used by `sb mission` unified timeline).
  interface ThreadSummary {
    threadKey: string;
    title: string | null;
    participants: string[];
    unreadCount: number;
    lastMessageAt: string | null;
    previewMessages: Array<{
      senderAgentId: string;
      content: string;
      messageType: string;
      createdAt: string;
    }>;
  }
  let threadsWithUnread: ThreadSummary[] = [];
  let threadUnreadCount = 0;
  // Completion signal (Lumen, PR #473 §5): the threads page below is capped —
  // a poller must not treat a quiet page as proof the backlog is drained when
  // more participant threads exist beyond it.
  const THREAD_PAGE_LIMIT = 20;
  let unreadThreadsTruncated = false;
  // A failed candidacy query (or any thread-section failure on a delivery
  // poll) must NEVER masquerade as an empty inbox: the poller would treat it
  // as drained. Surfaced in the response; the plugin's drain proof honors it.
  // NOTE: PostgREST failures RESOLVE as {data:null, error} — they do not
  // throw — so every required read below is checked, not just the catch.
  let channelPollIncomplete = false;
  const checkedRead = <T>(
    res: { data: T | null; error: { message: string } | null },
    queryLabel: string
  ): T | null => {
    if (res.error) {
      logger.error('channel_poll_query_failed', {
        query: queryLabel,
        agentId: agentId || null,
        sessionId: callerSessionId,
        error: res.error.message,
      });
      if (channelPoll) channelPollIncomplete = true;
      return null;
    }
    return res.data;
  };

  // (callerSessionId resolved + fail-closed gate applied at the top of the
  // handler — before the legacy inbox fetch/advance. See spec §3.)

  try {
    // NO participant pre-scan: it collected EVERY thread id (unfiltered on
    // the agent-less mission path — 365 threads ≈ 13.5KB of UUIDs) and fed
    // them into `.in('id', ...)`, which PostgREST encodes into the request
    // URL → HTTP 414 "URI too long". Silently swallowed for months; visible
    // since the checked-read sweep. Scoping now happens where the data
    // lives: the candidacy RPC self-scopes (user+agent+session, spec §3),
    // and the recency page filters membership with a SQL join.
    {
      // Get open threads for this user.
      // NOTE: `since` is NOT applied to threads — thread read pointers
      // (inbox_thread_read_status.last_read_at) already handle "which
      // messages have I seen." Filtering threads by updated_at would
      // cause missed messages when lastPollTime advances past the
      // thread's updated_at between polls.
      let threads: ThreadPageRow[] | null = null;
      if (channelPoll && agentId) {
        // Delivery polls page by EXACT candidacy in SQL (Lumen, PR #473
        // round 3): candidacy compares the read pointer against the latest
        // MESSAGE timestamp — thread.updated_at is bumped AFTER the message
        // insert with a later app timestamp, so updated_at-based candidacy
        // kept every fully-acked thread a candidate forever. The RPC scans
        // all stamped threads (no client pre-cap — nothing is silently
        // unreachable) and returns the newest-first page + total count.
        const { data: candRows, error: candErr } = await supabase.rpc(
          'get_unread_thread_candidates',
          {
            p_user_id: resolved.user.id,
            p_agent_id: agentId,
            p_session_id: callerSessionId ?? undefined,
            p_limit: THREAD_PAGE_LIMIT,
          }
        );
        if (candErr) {
          logger.error('channel_poll_candidates_failed', {
            agentId,
            sessionId: callerSessionId,
            error: candErr.message,
          });
          channelPollIncomplete = true;
        }
        const cands = (candErr ? [] : candRows || []) as Array<{
          thread_id: string;
          latest_message_at: string;
          total_candidates: number | string;
        }>;
        unreadThreadsTruncated = (Number(cands[0]?.total_candidates) || 0) > THREAD_PAGE_LIMIT;
        if (cands.length > 0) {
          const candIds = cands.map((c) => c.thread_id);
          const pageRows = checkedRead<ThreadPageRow[]>(
            await threadTable(supabase, 'inbox_threads')
              .select('id, thread_key, title, user_id, created_by_agent_id, updated_at')
              .in('id', candIds),
            'thread_page'
          );
          const byId = new Map((pageRows || []).map((t) => [t.id, t]));
          threads = candIds.map((id) => byId.get(id)).filter(Boolean) as ThreadPageRow[];
        } else {
          threads = [];
        }
      } else {
        // Recency page (mission timeline / non-delivery callers): membership
        // is filtered with an !inner join on participants when an agent is
        // given — never a client-side `.in(id-list)`, which blows the URL
        // past 8KB once a user has a few hundred threads (HTTP 414). Threads
        // are user-scoped rows, so the agent-less unified view needs no
        // participant filter at all.
        let recencyQuery = threadTable(supabase, 'inbox_threads')
          .select(
            agentId
              ? 'id, thread_key, title, user_id, created_by_agent_id, updated_at, inbox_thread_participants!inner(agent_id)'
              : 'id, thread_key, title, user_id, created_by_agent_id, updated_at'
          )
          .eq('user_id', resolved.user.id)
          .eq('status', 'open');
        if (agentId) {
          recencyQuery = recencyQuery.eq('inbox_thread_participants.agent_id', agentId);
        }
        const data = checkedRead<ThreadPageRow[]>(
          await recencyQuery.order('updated_at', { ascending: false }).limit(THREAD_PAGE_LIMIT),
          'thread_page_recency'
        );
        threads = data;
      }

      if (threads?.length) {
        const tIds = threads.map((t: { id: string }) => t.id);

        // Batch 1: all participants for all threads (was N queries)
        const allParts = checkedRead<
          Array<{ thread_id: string; agent_id: string; joined_at?: string }>
        >(
          await threadTable(supabase, 'inbox_thread_participants')
            .select('thread_id, agent_id, joined_at')
            .in('thread_id', tIds),
          'thread_participants'
        );
        const partsByThread = new Map<string, Array<{ agent_id: string; joined_at?: string }>>();
        for (const p of allParts || []) {
          const arr = partsByThread.get(p.thread_id) || [];
          arr.push(p);
          partsByThread.set(p.thread_id, arr);
        }

        // Batch 2: all read statuses for all threads (was N queries)
        const readStatusByThread = new Map<string, string | null>();
        if (agentId) {
          const allReadStatuses = checkedRead<
            Array<{ thread_id: string; last_read_at: string | null }>
          >(
            await threadTable(supabase, 'inbox_thread_read_status')
              .select('thread_id, last_read_at')
              .in('thread_id', tIds)
              .eq('agent_id', agentId),
            'thread_read_status'
          );
          for (const rs of allReadStatuses || []) {
            readStatusByThread.set(rs.thread_id, rs.last_read_at);
          }
        }

        // Batch 3: recent messages for all threads — used for both unread counts
        // and preview messages (was 2N queries). Fetch enough to cover previews +
        // reasonable unread counts. Threads with >50 unread will show a lower-bound.
        const MSG_BATCH_LIMIT = Math.max(tIds.length * 20, 200);
        const allMsgs = checkedRead<
          Array<{
            thread_id: string;
            sender_agent_id: string;
            content: string;
            message_type: string;
            created_at: string;
            metadata: unknown;
          }>
        >(
          await threadTable(supabase, 'inbox_thread_messages')
            .select('thread_id, sender_agent_id, content, message_type, created_at, metadata')
            .in('thread_id', tIds)
            .order('created_at', { ascending: false })
            .limit(MSG_BATCH_LIMIT),
          'thread_messages'
        );

        const msgsByThread = new Map<
          string,
          Array<{
            thread_id: string;
            sender_agent_id: string;
            content: string;
            message_type: string;
            created_at: string;
            metadata: unknown;
          }>
        >();
        for (const m of allMsgs || []) {
          const arr = msgsByThread.get(m.thread_id) || [];
          arr.push(m);
          msgsByThread.set(m.thread_id, arr);
        }

        // Assemble thread summaries from batched data (pure JS, zero queries)
        threadsWithUnread = threads.map((t: ThreadPageRow) => {
          const parts = partsByThread.get(t.id) || [];
          const participants = parts.map((p) => p.agent_id);

          let lastReadAt: string | null = readStatusByThread.get(t.id) || null;
          let joinedAt: string | null = null;
          if (agentId) {
            const callerPart = parts.find((p) => p.agent_id === agentId);
            joinedAt = callerPart?.joined_at || null;
          }

          const unreadBaseline = lastReadAt || joinedAt;
          const threadMsgs = msgsByThread.get(t.id) || [];
          const unreadCount = unreadBaseline
            ? threadMsgs.filter((m) => m.created_at > unreadBaseline).length
            : threadMsgs.length;

          const previewMessages = threadMsgs
            .filter((m) => m.message_type !== 'system')
            .slice(0, 3)
            .reverse()
            .map((m) => ({
              senderAgentId: m.sender_agent_id,
              content: m.content,
              messageType: m.message_type,
              createdAt: m.created_at,
            }));

          return {
            threadKey: t.thread_key,
            title: t.title,
            participants,
            unreadCount,
            lastMessageAt: t.updated_at,
            previewMessages,
          };
        });

        // Only include threads that actually have unread messages
        threadsWithUnread = threadsWithUnread.filter((t) => t.unreadCount > 0);

        // Channel poll studio filtering (defense-in-depth): when channelPoll=true
        // and no session_id filter was applied, fall back to message-metadata-based
        // studio ownership check. Uses the already-batched messages (no extra queries).
        if (channelPoll && agentId && !callerSessionId) {
          const reqCtx = getRequestContext();
          const sessCtx = getSessionContext();
          const callerStudioId = reqCtx?.studioId || sessCtx?.studioId || null;

          if (callerStudioId) {
            // Build a threadKey→threadId map for lookup
            const keyToId = new Map<string, string>(
              threads.map((t: { id: string; thread_key: string }) => [t.thread_key, t.id])
            );

            threadsWithUnread = threadsWithUnread.filter((thread) => {
              const tid = keyToId.get(thread.threadKey);
              if (!tid) return true; // safety fallback
              const ourMsgs = (msgsByThread.get(tid) || [])
                .filter((m) => m.sender_agent_id === agentId)
                .slice(0, 5);
              const owned = isThreadOwnedByStudio(ourMsgs, callerStudioId);
              if (!owned) {
                logger.debug('[ChannelPoll] Filtered thread (owned by different studio)', {
                  threadKey: thread.threadKey,
                  callerStudioId,
                });
              }
              return owned;
            });
          }
        }

        threadUnreadCount = threadsWithUnread.reduce((sum, t) => sum + t.unreadCount, 0);
      }
    }
  } catch (err) {
    // Graceful fallback (legacy: thread tables may not exist) — but LOUD:
    // for a channelPoll this is a delivery outage, not trivia, and the
    // response must not read as a drained inbox.
    if (channelPoll) channelPollIncomplete = true;
    logger.warn('Failed to fetch thread unread counts', { err });
  }

  const inboxUnreadCount = unreadCount || 0;
  const totalUnreadCount = inboxUnreadCount + threadUnreadCount;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          ...(agentId ? { agentId } : { allAgents: true }),
          unreadCount: inboxUnreadCount,
          threadUnreadCount,
          totalUnreadCount,
          count: messages?.length || 0,
          // Read-state transparency: a caller that gets fewer rows than the
          // backlog, or whose read deliberately didn't drain, can tell why.
          ...(pageTruncated ? { truncated: true } : {}),
          lastReadAt: unreadFloor,
          readPointerAdvanced,
          ...(readPointerAt ? { readPointerAt } : {}),
          messages: (messages || []).map((m) => ({
            id: m.id,
            subject: m.subject,
            content: m.content,
            messageType: m.message_type,
            priority: m.priority,
            status: m.status,
            senderAgentId: m.sender_agent_id,
            recipientAgentId: m.recipient_agent_id,
            threadKey: m.thread_key || null,
            recipientSessionId: m.recipient_session_id,
            relatedArtifactUri: m.related_artifact_uri,
            metadata: m.metadata,
            createdAt: m.created_at,
            readAt: m.read_at,
          })),
          ...(unreadThreadsTruncated ? { unreadThreadsTruncated: true } : {}),
          ...(channelPollIncomplete
            ? {
                channelPollIncomplete: true,
                warning:
                  'channel_poll_incomplete: thread candidacy query failed — results are partial; do NOT treat this poll as drained',
              }
            : {}),
          ...(threadsWithUnread.length > 0
            ? {
                threadsWithUnread,
                threadHint:
                  'You have unread thread messages. Use get_thread_messages(threadKey) to read them, send_to_inbox(threadKey) to respond, or mark_thread_read to acknowledge.',
              }
            : {}),
        }),
      },
    ],
  };
}

export async function handleUpdateInboxMessage(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = updateInboxMessageSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { messageId, agentId, status } = parsed;

  // Try legacy agent_inbox first
  const { data: existing } = await supabase
    .from('agent_inbox')
    .select('*')
    .eq('id', messageId)
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .maybeSingle();

  if (existing) {
    // Legacy inbox message — update in agent_inbox
    const updates: Record<string, unknown> = { status };
    if (status === 'read' && !existing.read_at) {
      updates.read_at = new Date().toISOString();
    }
    if (status === 'acknowledged') {
      updates.acknowledged_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabase
      .from('agent_inbox')
      .update(updates)
      .eq('id', messageId)
      .select()
      .single();

    if (updateError) {
      throw new Error(`Failed to update message: ${updateError.message}`);
    }

    logger.info('Inbox message updated', { messageId, agentId, newStatus: status });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Message updated',
            messageId,
            status: updated.status,
            readAt: updated.read_at,
            acknowledgedAt: updated.acknowledged_at,
          }),
        },
      ],
    };
  }

  // Try thread message — verify thread belongs to this user AND agent is a participant
  const { data: threadMsg } = await threadTable(supabase, 'inbox_thread_messages')
    .select('id, thread_id')
    .eq('id', messageId)
    .maybeSingle();

  if (threadMsg) {
    // Verify the thread belongs to this user
    const { data: thread } = await threadTable(supabase, 'inbox_threads')
      .select('id')
      .eq('id', threadMsg.thread_id)
      .eq('user_id', resolved.user.id)
      .maybeSingle();

    if (!thread) {
      throw new Error(`Message not found or not accessible: ${messageId}`);
    }

    // Verify this agent is a participant on the thread
    const { data: participant } = await threadTable(supabase, 'inbox_thread_participants')
      .select('agent_id')
      .eq('thread_id', threadMsg.thread_id)
      .eq('agent_id', agentId)
      .maybeSingle();

    if (!participant) {
      throw new Error(`Message not found or not accessible: ${messageId}`);
    }

    // Thread messages don't have a status column — advance the read pointer
    // through THIS message instead (never wall-clock: a concurrently inserted
    // later message must not be swept into "read"). This API's purpose IS the
    // durable write, so a failed advance must surface as failure, never as a
    // positive acknowledgement.
    if (status === 'read' || status === 'acknowledged' || status === 'completed') {
      const advanced = await advanceThreadReadPointer(supabase, {
        threadId: threadMsg.thread_id,
        agentId,
        throughMessageId: messageId,
        source: 'update_inbox_message:thread-fallback',
      });
      if (!advanced) {
        throw new Error(
          `Failed to persist read state for thread message ${messageId} — status not updated`
        );
      }
    }

    logger.info('Thread message status updated (via read pointer)', {
      messageId,
      threadId: threadMsg.thread_id,
      agentId,
      newStatus: status,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Thread message acknowledged (thread marked as read)',
            messageId,
            threadId: threadMsg.thread_id,
            status,
          }),
        },
      ],
    };
  }

  // Neither table had this message
  throw new Error(`Message not found or not accessible: ${messageId}`);
}

export async function handleMarkInboxRead(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = markInboxReadSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const agentId = getEffectiveAgentId(parsed.agentId) ?? parsed.agentId;

  // Resolve the requested cutoff to a REAL message before touching the pointer.
  // The old code wrote `before || now()` straight into the row, which is the
  // wall-clock advance the spec bans (§2): a message inserted between the
  // caller's decision and this write would be marked read without ever being
  // seen. Anchoring to the newest message at or before the cutoff preserves the
  // caller's intent exactly while making that race impossible.
  //
  // throughMessageId is the exact-id delivery ack (the legacy mirror of
  // mark_thread_read): the anchor IS that message, recipient-scoped so one
  // agent cannot ack with another's mail.
  let anchorQuery = supabase
    .from('agent_inbox')
    .select('id, created_at')
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (parsed.throughMessageId) {
    anchorQuery = anchorQuery.eq('id', parsed.throughMessageId);
  } else if (parsed.before) {
    anchorQuery = anchorQuery.lte('created_at', parsed.before);
  }
  const { data: anchor, error: anchorError } = await anchorQuery.maybeSingle();

  if (anchorError) {
    throw new Error(`Failed to mark inbox read: ${anchorError.message}`);
  }

  if (!anchor) {
    // Nothing at or before the cutoff — no message to advance through. The
    // pointer is monotonic anyway, so this is a no-op, not a failure.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            agentId,
            lastReadAt: null,
            advanced: false,
            message: parsed.throughMessageId
              ? `Message ${parsed.throughMessageId} is not in this agent's inbox — read pointer unchanged.`
              : parsed.before
                ? `No messages at or before ${parsed.before} — read pointer unchanged.`
                : 'Inbox is empty — read pointer unchanged.',
          }),
        },
      ],
    };
  }

  const result = await advanceAgentInboxReadPointer(supabase, {
    userId: resolved.user.id,
    agentId,
    throughMessageId: anchor.id,
    source: 'mark_inbox_read',
  });

  if (!result.ok) {
    throw new Error('Failed to mark inbox read: read pointer advance failed (see server logs)');
  }

  logger.info('Inbox marked as read', { agentId, lastReadAt: result.lastReadAt });

  // Report the MONOTONIC RESULT, never the requested anchor (Lumen #504 r1):
  // when the stored pointer is already ahead, the DB correctly keeps it — and
  // saying `lastReadAt: <older anchor>, advanced: true` here could regress a
  // client cursor even though the DB stayed correct.
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          lastReadAt: result.lastReadAt,
          advanced: result.changed,
          message: result.changed
            ? 'Inbox read pointer advanced. Messages up to and including this timestamp are now read. ' +
              'The pointer is monotonic — it never moves backwards.'
            : 'Read pointer already at or past the requested anchor — unchanged (monotonic).',
        }),
      },
    ],
  };
}

export async function handleGetAgentStatus(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getAgentStatusSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId } = parsed;

  // Get latest session for this agent
  const { data: latestSession } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Get unread message count (pointer-based)
  const { data: readStatus } = await threadTable(supabase, 'agent_inbox_read_status')
    .select('last_read_at')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .maybeSingle();

  // Expired messages are excluded here to match get_inbox's predicate. These
  // two counters are read side by side (mission control shows both) and must
  // agree, or one of them is quietly wrong.
  const notExpired = `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;

  let unreadQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId);
  if (readStatus?.last_read_at) {
    unreadQuery = unreadQuery.gt('created_at', readStatus.last_read_at);
  }
  const { count: unreadCount } = await unreadQuery.or(notExpired);

  // Get urgent unread message count (pointer-based)
  let urgentQuery = supabase
    .from('agent_inbox')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_user_id', resolved.user.id)
    .eq('recipient_agent_id', agentId)
    .eq('priority', 'urgent');
  if (readStatus?.last_read_at) {
    urgentQuery = urgentQuery.gt('created_at', readStatus.last_read_at);
  }
  const { count: urgentCount } = await urgentQuery.or(notExpired);

  // Get active workspaces for this agent
  const { data: workspaces } = await supabase
    .from('studios')
    .select('id, branch, worktree_path, purpose, status, work_type, session_id, created_at')
    .eq('user_id', resolved.user.id)
    .eq('agent_id', agentId)
    .in('status', ['active', 'idle'])
    .order('created_at', { ascending: false });

  // Determine agent status based on session
  let agentStatus = 'inactive';
  if (latestSession) {
    if (!latestSession.ended_at) {
      agentStatus = 'active';
    } else {
      const endedAt = new Date(latestSession.ended_at);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      agentStatus = endedAt > hourAgo ? 'recently_active' : 'inactive';
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          agentId,
          status: agentStatus,
          inbox: {
            unreadCount: unreadCount || 0,
            urgentCount: urgentCount || 0,
          },
          lastSession: latestSession
            ? {
                id: latestSession.id,
                claudeSessionId: latestSession.claude_session_id,
                startedAt: latestSession.started_at,
                endedAt: latestSession.ended_at,
                summary: latestSession.summary,
                workingDir: latestSession.working_dir,
              }
            : null,
          workspaces: (workspaces || []).map((w) => ({
            id: w.id,
            branch: w.branch,
            path: w.worktree_path,
            purpose: w.purpose,
            status: w.status,
            workType: w.work_type,
            hasLinkedSession: !!w.session_id,
            createdAt: w.created_at,
          })),
        }),
      },
    ],
  };
}

export async function handleGetAgentSummaries(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = getAgentSummariesSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);
  const userId = resolved.user.id;

  // Discover agents
  let agentIds = parsed.agentIds;
  if (!agentIds?.length) {
    const { data: identities } = await supabase
      .from('agent_identities')
      .select('agent_id')
      .eq('user_id', userId);
    agentIds = (identities || []).map((i: { agent_id: string }) => i.agent_id);
  }

  if (!agentIds.length) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, agents: [] }) }],
    };
  }

  // ── Round 1: four independent bulk queries in parallel ──────────────
  const now = new Date();
  const staleThresholdMs = 30 * 60 * 1000; // 30 minutes
  const todayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [readPointers, allSessions, allParticipation, allStudios] = await Promise.all([
    // 1. All inbox read pointers for this user
    threadTable(supabase, 'agent_inbox_read_status')
      .select('agent_id, last_read_at')
      .eq('user_id', userId)
      .then((r: { data: unknown }) => r.data || []),

    // 2. All sessions: non-ended OR started today (covers active + today counts)
    supabase
      .from('sessions')
      .select('id, agent_id, lifecycle, current_phase, started_at, ended_at, studio_id, updated_at')
      .eq('user_id', userId)
      .in('agent_id', agentIds)
      .or(`ended_at.is.null,started_at.gte.${todayCutoff}`)
      .order('started_at', { ascending: false })
      .then((r: { data: unknown }) => r.data || []),

    // 3. All thread participation for these agents
    threadTable(supabase, 'inbox_thread_participants')
      .select('thread_id, agent_id')
      .in('agent_id', agentIds)
      .then((r: { data: unknown }) => r.data || [])
      .catch(() => []), // Thread tables may not exist yet

    // 4. Studios per agent (ownership-based, not session-based)
    supabase
      .from('studios')
      .select('id, agent_id')
      .eq('user_id', userId)
      .in('agent_id', agentIds)
      .in('status', ['active', 'idle'])
      .then((r: { data: unknown }) => r.data || []),
  ]);

  // Build read pointer map
  const readPointerMap = new Map<string, string>();
  for (const rp of readPointers as Array<{ agent_id: string; last_read_at: string }>) {
    readPointerMap.set(rp.agent_id, rp.last_read_at);
  }

  // The fetch floor is an optimization, not the truth source — and it is
  // only sound when EVERY requested agent has a pointer row. An agent with
  // mail but no pointer must contribute ALL its rows to the per-agent count
  // below; filtering the fetch by other agents' minimum silently zeroed such
  // agents on the Mission path (Lumen #504 r2 P1). Min over REQUESTED agents
  // only, and only when none of them is pointer-less.
  let minPointer: string | null = null;
  if (agentIds.every((a) => readPointerMap.has(a))) {
    for (const a of agentIds) {
      const ts = readPointerMap.get(a)!;
      if (!minPointer || ts < minPointer) minPointer = ts;
    }
  }

  // Collect unique thread IDs from participation
  const threadIdSet = new Set<string>();
  for (const p of allParticipation as Array<{ thread_id: string; agent_id: string }>) {
    threadIdSet.add(p.thread_id);
  }
  const allThreadIds = [...threadIdSet];

  // ── Round 2: inbox messages + open threads (depend on round 1) ─────
  const [inboxMessages, openThreads] = await Promise.all([
    // 4. All inbox messages after earliest pointer (just agent_id + created_at for counting)
    (async () => {
      let q = supabase
        .from('agent_inbox')
        .select('recipient_agent_id, created_at')
        .eq('recipient_user_id', userId)
        .in('recipient_agent_id', agentIds)
        // Expiry parity with get_inbox/get_agent_status (Lumen #504 r2 P2):
        // Mission's total must not disagree with the surfaces it links to.
        .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`);
      if (minPointer) {
        q = q.gt('created_at', minPointer);
      }
      const { data } = await q;
      return (data || []) as Array<{ recipient_agent_id: string; created_at: string }>;
    })(),

    // 5. Open threads for this user (filtered to threads agents participate in)
    (async () => {
      if (!allThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'open')
        .in('id', allThreadIds);
      return (data || []) as Array<{ id: string }>;
    })(),
  ]);

  const openThreadIds = openThreads.map((t) => t.id);

  // ── Round 3: thread read statuses + thread messages (depend on round 2) ─
  const [threadReadStatuses, threadMessages] = await Promise.all([
    // 6. All thread read statuses for open threads × agents
    (async () => {
      if (!openThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_thread_read_status')
        .select('thread_id, agent_id, last_read_at')
        .in('thread_id', openThreadIds)
        .in('agent_id', agentIds);
      return (data || []) as Array<{
        thread_id: string;
        agent_id: string;
        last_read_at: string;
      }>;
    })(),

    // 7. All messages in open threads (just thread_id + created_at for counting)
    (async () => {
      if (!openThreadIds.length) return [];
      const { data } = await threadTable(supabase, 'inbox_thread_messages')
        .select('thread_id, created_at')
        .in('thread_id', openThreadIds);
      return (data || []) as Array<{ thread_id: string; created_at: string }>;
    })(),
  ]);

  // ── Aggregate in JS ───────────────────────────────────────────────────

  // Inbox unreads: count messages per agent where created_at > that agent's pointer
  const inboxUnreadMap = new Map<string, number>();
  for (const m of inboxMessages) {
    const pointer = readPointerMap.get(m.recipient_agent_id);
    if (!pointer || m.created_at > pointer) {
      inboxUnreadMap.set(m.recipient_agent_id, (inboxUnreadMap.get(m.recipient_agent_id) || 0) + 1);
    }
  }

  // Thread unreads: build per-agent read pointer lookup, then count messages
  const threadReadMap = new Map<string, string>(); // "threadId:agentId" → last_read_at
  for (const rs of threadReadStatuses) {
    threadReadMap.set(`${rs.thread_id}:${rs.agent_id}`, rs.last_read_at);
  }

  // Build agent → set of open thread IDs they participate in
  const agentOpenThreads = new Map<string, Set<string>>();
  const openThreadIdSet = new Set(openThreadIds);
  for (const p of allParticipation as Array<{ thread_id: string; agent_id: string }>) {
    if (!openThreadIdSet.has(p.thread_id)) continue;
    if (!agentOpenThreads.has(p.agent_id)) agentOpenThreads.set(p.agent_id, new Set());
    agentOpenThreads.get(p.agent_id)!.add(p.thread_id);
  }

  // Count unread thread messages per agent
  const threadUnreadMap = new Map<string, number>();
  for (const msg of threadMessages) {
    // For each agent that participates in this thread, check if message is unread
    for (const [aid, threads] of agentOpenThreads) {
      if (!threads.has(msg.thread_id)) continue;
      const lastRead = threadReadMap.get(`${msg.thread_id}:${aid}`);
      if (!lastRead || msg.created_at > lastRead) {
        threadUnreadMap.set(aid, (threadUnreadMap.get(aid) || 0) + 1);
      }
    }
  }

  // Sessions: group by agent_id in JS
  type SessionRow = {
    id: string;
    agent_id: string;
    lifecycle: string | null;
    current_phase: string | null;
    started_at: string | null;
    ended_at: string | null;
    studio_id: string | null;
    updated_at: string | null;
  };
  const sessionsByAgent = new Map<string, SessionRow[]>();
  const todayCountMap = new Map<string, number>();

  for (const s of allSessions as SessionRow[]) {
    // Active sessions (non-ended)
    if (!s.ended_at) {
      if (!sessionsByAgent.has(s.agent_id)) sessionsByAgent.set(s.agent_id, []);
      sessionsByAgent.get(s.agent_id)!.push(s);
    }
    // Sessions today (started in last 24h, including ended)
    if (s.started_at && s.started_at >= todayCutoff) {
      todayCountMap.set(s.agent_id, (todayCountMap.get(s.agent_id) || 0) + 1);
    }
  }

  // Studios: count per agent from the studios table (ownership-based)
  const studioCountMap = new Map<string, number>();
  for (const s of allStudios as Array<{ id: string; agent_id: string }>) {
    studioCountMap.set(s.agent_id, (studioCountMap.get(s.agent_id) || 0) + 1);
  }

  // Assemble summaries
  const agents = agentIds.map((agentId) => {
    const sessions = sessionsByAgent.get(agentId) || [];
    const latest = sessions[0] || null; // already sorted by started_at DESC

    const byLifecycle: Record<string, number> = {};
    for (const s of sessions) {
      const lc = s.lifecycle || 'unknown';
      byLifecycle[lc] = (byLifecycle[lc] || 0) + 1;
    }

    const generating = sessions.filter((s) => {
      if (s.lifecycle !== 'running') return false;
      if (!s.updated_at) return true;
      const updatedMs = Date.parse(s.updated_at);
      return !Number.isNaN(updatedMs) && now.getTime() - updatedMs < staleThresholdMs;
    }).length;

    const inboxUnread = inboxUnreadMap.get(agentId) || 0;
    const threadUnread = threadUnreadMap.get(agentId) || 0;

    return {
      agentId,
      inboxUnread,
      threadUnread,
      totalUnread: inboxUnread + threadUnread,
      activeSessions: sessions.length,
      sessionsByLifecycle: byLifecycle,
      generating,
      sessionsToday: todayCountMap.get(agentId) || 0,
      studioCount: studioCountMap.get(agentId) || 0,
      latestSession: latest
        ? {
            id: latest.id,
            lifecycle: latest.lifecycle,
            phase: latest.current_phase,
            startedAt: latest.started_at,
            endedAt: latest.ended_at,
            studioId: latest.studio_id,
          }
        : null,
    };
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, agents }),
      },
    ],
  };
}

// ============== Tool Registration ==============

export const inboxToolDefinitions = [
  {
    name: 'send_to_inbox',
    description:
      'Send a message to agent(s) or reply to a thread. Unified tool for all cross-agent messaging.\n\nSingle recipient: send_to_inbox(recipientAgentId: "lumen", content: "...")\nGroup thread: send_to_inbox(recipients: ["lumen", "aster"], threadKey: "pr:165", content: "...")\nReply to thread: send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:165", content: "...")\n\nWhen threadKey is provided, messages go to inbox_thread_messages (thread-first model). Late joiners see full history. Without threadKey, creates a simple agent_inbox row.\n\nFor existing threads, reply semantics are automatic: closed threads are rejected, and smart trigger defaults apply (1:1 → other participant; group with explicit recipient → that recipient; group non-creator → creator; group creator → all others). Override with triggerAll or triggerAgents.\n\nMessage types:\n- message: General communication\n- task_request: Request another agent to do work\n- session_resume: Request agent to resume a specific session\n- notification: FYI, no response needed\n- permission_grant: Grant or revoke tool permissions\n\nTrigger behavior:\nAll message types trigger recipients by default. Set trigger=false only if the message can wait 5+ hours.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
    schema: sendToInboxSchema,
    handler: handleSendToInbox,
  },
  {
    name: 'get_inbox',
    description:
      'Get messages from an agent\'s inbox. Returns UNSEEN messages by default — those newer than your read pointer, not rows whose status column says "unread". `unreadCount` is measured before this call advances anything, so it reports the backlog you were handed rather than what\'s left after reading it; `truncated: true` means `limit` cut that backlog short. Reading advances your pointer only over messages this call actually returned — pass markRead:false to observe without draining (watchers and pollers with their own cursor must). Omit agentId to get inbox across ALL agents in one query (useful for unified timelines like mission control). Sorted by created_at descending. Pass threadKey to read a conversation thread instead — this aliases through to get_thread_messages (thread messages are stored separately from the legacy inbox) and requires agentId.',
    schema: getInboxSchema,
    handler: handleGetInbox,
  },
  {
    name: 'update_inbox_message',
    description: 'Update message status (mark as read, acknowledged, or completed).',
    schema: updateInboxMessageSchema,
    handler: handleUpdateInboxMessage,
  },
  {
    name: 'mark_inbox_read',
    description:
      "Advance the agent's inbox read pointer. All messages created at or before the pointer are considered read. Defaults to the newest message currently in the inbox (marks everything read); use 'before' to mark up to a specific timestamp. The advance is monotonic — it never moves the pointer backwards — and always lands on a real message, so mail that arrives mid-call is never marked read without being seen.",
    schema: markInboxReadSchema,
    handler: handleMarkInboxRead,
  },
  {
    name: 'get_agent_status',
    description:
      'Get status of an agent: active/inactive, unread message count, last session info.',
    schema: getAgentStatusSchema,
    handler: handleGetAgentStatus,
  },
  {
    name: 'get_agent_summaries',
    description:
      'Get summaries for all agents in one call. Returns per-agent unread counts (legacy inbox + thread-aware with proper per-agent read status), active session count, and latest session lifecycle/phase. Ideal for dashboards and mission control. Omit agentIds to auto-discover all agents.',
    schema: getAgentSummariesSchema,
    handler: handleGetAgentSummaries,
  },
];
