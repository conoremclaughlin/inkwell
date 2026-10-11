import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { getEffectiveSlug } from '../../auth/enforce-identity';
import { getRequestContext, getSessionContext } from '../../utils/request-context';
import { INKLING_CONVERSATION_MARK } from '../../services/inklings/inkling-thread-gate';
import { resolveCallerWorkspace, assertWriteRole } from './caller-principal';
import { handleSendToInbox } from './inbox-handlers';

/** The inkling channel is an existing conversation, not an external transport. */
export async function sendInklingResponse(
  dataComposer: DataComposer,
  input: { conversationId: string; content: string }
): Promise<{ success: true; channel: 'inkling'; conversationId: string; messageId: string }> {
  if (!input.content.trim()) throw new Error('An inkling reply must contain text');
  const resolved = await resolveUserOrThrow({}, dataComposer);
  const db = dataComposer.getClient();
  const context = getRequestContext() ?? getSessionContext();
  const caller = await resolveCallerWorkspace(
    db,
    resolved.user.id,
    getEffectiveSlug() || context?.sbSlug
  );
  assertWriteRole(caller.role, 'send to a thread');
  // Replies are from the calling SB. The owner's composer uses the ordinary
  // thread POST route; no caller-supplied sender or internal-principal override.
  if (!caller.sb) throw new Error('The inkling reply channel requires an authenticated SB');
  const lookup = db
    .from('inbox_threads')
    .select('id, thread_key, metadata')
    .eq('workspace_id', caller.workspaceId);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const { data: thread, error } = await (
    uuid.test(input.conversationId)
      ? lookup.eq('id', input.conversationId)
      : lookup.eq('thread_key', input.conversationId)
  ).maybeSingle();
  if (error) throw new Error('Could not read the inkling conversation');
  if (
    !thread ||
    (thread.metadata as Record<string, unknown> | null)?.[INKLING_CONVERSATION_MARK] !== true
  ) {
    throw new Error('Inkling conversation not found in your workspace');
  }
  const { data: member, error: memberError } = await db
    .from('inbox_thread_participants')
    .select('sb_id')
    .eq('thread_id', thread.id)
    .eq('sb_id', caller.sb.sbId)
    .maybeSingle();
  if (memberError || !member) throw new Error('You are not a member of this inkling conversation');

  // Reuse the real send boundary: owner-test gate, fixed participants,
  // role checks, read pointers and quiet replies all remain authoritative.
  const sent = await handleSendToInbox(
    {
      threadKey: thread.thread_key,
      recipientSlug: caller.sb.sbSlug,
      content: input.content,
    },
    dataComposer
  );
  const body = JSON.parse(sent.content[0].text) as { success?: boolean; messageId?: string };
  if (body.success !== true || !body.messageId) throw new Error('The inkling reply was not stored');
  return {
    success: true,
    channel: 'inkling',
    conversationId: input.conversationId,
    messageId: body.messageId,
  };
}
