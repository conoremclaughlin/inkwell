/**
 * The thread a space-turn call addresses, found exactly as its handler will
 * find it (ink://specs/inkling-multi-person-groups, Phase 2 gate 3).
 *
 * Every step is the handler's own function, not a copy of it, so the thread
 * the policy checks is the thread the handler then acts on:
 *
 * - get_thread_messages: the principal, the slug it reads as
 *   (threadReaderSlug), that SB's workspace (resolveCallerSb), then the
 *   thread by key there (findThread).
 * - send_response on the inkling channel: the reply's caller
 *   (resolveInklingCaller), then the conversation in its workspace
 *   (findInklingConversation).
 *
 * The caller's workspace comes from the token's own SB. A token whose SB
 * lives outside the token's workspace therefore resolves outside it, and
 * the policy refuses the mismatch.
 */

import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { resolveCallerSb } from './caller-principal';
import { findThread, threadReaderSlug } from './thread-handlers';
import { findInklingConversation, resolveInklingCaller } from './inkling-response';
import type { SpaceTurnThreadResolver } from './space-turn-policy';

export function createSpaceTurnThreadResolver(dataComposer: DataComposer): SpaceTurnThreadResolver {
  return async (toolName, args) => {
    const fields = (args ?? {}) as Record<string, unknown>;

    if (toolName === 'get_thread_messages') {
      const resolved = await resolveUserOrThrow(fields, dataComposer);
      const sbSlug = threadReaderSlug(
        typeof fields.sbSlug === 'string' ? fields.sbSlug : undefined
      );
      if (!sbSlug) return null;
      const supabase = dataComposer.getClient();
      const caller = await resolveCallerSb(supabase, resolved.user.id, sbSlug);
      const threadKey = typeof fields.threadKey === 'string' ? fields.threadKey : '';
      const thread = await findThread(supabase, caller.workspaceId, threadKey);
      return thread ? { id: thread.id, workspaceId: thread.workspace_id } : null;
    }

    const caller = await resolveInklingCaller(dataComposer);
    const conversationId = typeof fields.conversationId === 'string' ? fields.conversationId : '';
    const thread = await findInklingConversation(dataComposer, caller.workspaceId, conversationId);
    return { id: thread.id, workspaceId: thread.workspace_id };
  };
}
