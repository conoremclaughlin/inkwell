/**
 * Thread-borne trigger scope and failure-notice ownership
 * (spec inkmail-thread-scope §1a; Lumen, #618 round 1).
 *
 * Pulled out of the trigger handler so the guards can be tested as
 * functions rather than by executing the handler's prefix.
 *
 * A thread-borne trigger names its target canonically (`toSbId`). Its
 * runtime owner is that identity's user, the thread must live in the
 * identity's workspace, and the authenticated sender must be a member of
 * that workspace. Every failure to establish those facts REFUSES the
 * trigger: a thread that cannot be read is not a bare trigger, and a
 * missing workspace never skips a check.
 */

import { logger } from '../utils/logger';
import { isWorkspaceMember } from './principals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

export interface ThreadTriggerScopeInput {
  threadId?: string;
  threadMessageId?: string;
  /** The canonical target, set by thread dispatch. */
  toSbId?: string;
  /** The slug the payload names; must match the identity. */
  targetSlug: string;
  /** The authenticated caller, when there is one (internal dispatch may run without). */
  authUserId?: string;
  fromSlug?: string;
}

export interface ThreadTriggerScope {
  threadId: string;
  threadWorkspaceId: string;
  /** Set when the payload named a canonical target: its owner and identity. */
  userId?: string;
  recipientSbId?: string;
}

export async function resolveThreadTriggerScope(
  client: Client,
  input: ThreadTriggerScopeInput
): Promise<ThreadTriggerScope> {
  const { targetSlug, authUserId, fromSlug } = input;

  // 1. The thread, from the id or from the message. Unreadable is refused.
  let threadId = input.threadId;
  if (!threadId && input.threadMessageId) {
    const { data: threadMsg, error: tmError } = await client
      .from('inbox_thread_messages')
      .select('thread_id')
      .eq('id', input.threadMessageId)
      .single();
    if (tmError || !threadMsg?.thread_id) {
      logger.error('[Trigger] Thread message could not be resolved', {
        threadMessageId: input.threadMessageId,
        error: tmError?.message ?? 'not found',
      });
      throw new Error('Trigger denied: thread message could not be resolved');
    }
    threadId = threadMsg.thread_id as string;
  }
  if (!threadId) {
    throw new Error('Trigger denied: thread-borne trigger names no thread');
  }
  const { data: thread, error: threadError } = await client
    .from('inbox_threads')
    .select('id, workspace_id')
    .eq('id', threadId)
    .single();
  if (threadError || !thread?.workspace_id) {
    logger.error('[Trigger] Thread could not be resolved', {
      threadId,
      error: threadError?.message ?? 'not found',
    });
    throw new Error('Trigger denied: thread could not be resolved');
  }
  const threadWorkspaceId = thread.workspace_id as string;

  // 2. The sender must belong to the thread's workspace.
  if (authUserId && !(await isWorkspaceMember(client, threadWorkspaceId, authUserId))) {
    logger.warn('[Trigger] SECURITY: sender is not a member of the thread workspace', {
      threadId,
      threadWorkspaceId,
      authUserId,
      targetSlug,
      fromSlug,
    });
    throw new Error('Trigger denied: sender is not a member of the thread workspace');
  }

  // 3. The canonical target, when named: exists, is the slug the payload
  //    names, and lives in the thread's workspace. Its owner is the runtime
  //    owner (§1a) — which may differ from the sender's.
  if (!input.toSbId) {
    return { threadId, threadWorkspaceId };
  }
  const { data: identity, error: identityError } = await client
    .from('agent_identities')
    .select('id, agent_id, user_id, workspace_id')
    .eq('id', input.toSbId)
    .maybeSingle();
  if (identityError || !identity) {
    throw new Error(`Trigger denied: unknown target identity for ${targetSlug}`);
  }
  if (identity.agent_id !== targetSlug) {
    throw new Error(
      `Trigger denied: target identity is "${identity.agent_id}", not "${targetSlug}"`
    );
  }
  if (identity.workspace_id !== threadWorkspaceId) {
    logger.warn('[Trigger] SECURITY: target identity is not in the thread workspace', {
      threadId,
      threadWorkspaceId,
      identityWorkspaceId: identity.workspace_id,
      targetSlug,
      fromSlug,
    });
    throw new Error('Trigger denied: target identity is not in the thread workspace');
  }
  return {
    threadId,
    threadWorkspaceId,
    userId: identity.user_id as string,
    recipientSbId: identity.id as string,
  };
}

export interface FailureNoticeAddress {
  /** The thread the failed trigger was for, when it can be resolved. */
  threadId?: string;
  threadWorkspaceId?: string;
  /** The failed target's runtime owner (activity attribution only). */
  targetOwnerUserId?: string;
  /**
   * The SENDER's owner — where a legacy-lane notice may land. Absent for a
   * person or the system (they hold no agent inbox) and when the sender's
   * identity is unknown; the thread lane is then the only lane.
   */
  senderOwnerUserId?: string;
}

/**
 * Where a failure notice belongs. The target's owner is who the SB was
 * spawned for; the sender's owner is who is waiting for an answer. They
 * differ in a shared workspace, and the legacy inbox lane is per owner —
 * writing it under the target's owner would deliver the notice to a
 * namesake (Lumen, #618).
 */
export async function resolveFailureNoticeAddress(
  client: Client,
  payload: {
    threadId?: string;
    threadMessageId?: string;
    toSbId?: string;
    fromSbId?: string;
    fromSlug?: string;
  }
): Promise<FailureNoticeAddress> {
  const out: FailureNoticeAddress = {};
  let threadId = payload.threadId;
  if (!threadId && payload.threadMessageId) {
    const { data: threadMsg } = await client
      .from('inbox_thread_messages')
      .select('thread_id')
      .eq('id', payload.threadMessageId)
      .single();
    threadId = (threadMsg?.thread_id as string | undefined) ?? undefined;
  }
  if (threadId) {
    out.threadId = threadId;
    const { data: thread } = await client
      .from('inbox_threads')
      .select('workspace_id')
      .eq('id', threadId)
      .single();
    out.threadWorkspaceId = (thread?.workspace_id as string | undefined) ?? undefined;
  }
  if (payload.toSbId) {
    const { data: target } = await client
      .from('agent_identities')
      .select('user_id')
      .eq('id', payload.toSbId)
      .maybeSingle();
    out.targetOwnerUserId = (target?.user_id as string | undefined) ?? undefined;
  }
  if (payload.fromSbId) {
    const { data: sender } = await client
      .from('agent_identities')
      .select('user_id')
      .eq('id', payload.fromSbId)
      .maybeSingle();
    out.senderOwnerUserId = (sender?.user_id as string | undefined) ?? undefined;
  }
  return out;
}
