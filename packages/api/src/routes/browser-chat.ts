/** The paired installation's own conversations. No caller-supplied thread,
 * workspace, slug, runtime or page authority. Dispatch uses the existing inbox
 * path, including its inkling owner gate and hosted runtime selection.
 * Ordinary recipients are explicit new-grant bindings, not an implicit upgrade. */
import { Router } from 'express';
import { z } from 'zod';
import type { DataComposer } from '../data/composer';
import { InklingService, type Inkling } from '../services/inklings/inkling-service';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { userPrincipal } from '../services/principals';
import { assertWriteRole, roleOfUserIn } from '../mcp/tools/caller-principal';
import {
  deliveryFromSendResult,
  isClientMessageConflict,
  lookUpClientMessage,
  recordDelivery,
} from '../services/send-receipt';
import type { BrowserCompanionRequest } from './browser-companion';
import { BrowserCompanionGrantService } from '../services/browser-companion-grant.service';
import { browserChatRecipients } from '../services/browser-chat-recipient';

const selection = z.object({ inklingId: z.string().uuid() }).strict();
const submission = selection
  .extend({
    operationId: z.string().uuid(),
    body: z
      .string()
      .min(1)
      .max(4_000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

export const browserChatKey = (grantId: string, inklingId: string) =>
  `thread:browser-${grantId}-${inklingId}`;

export function createBrowserChatRouter(getComposer: () => Promise<DataComposer>) {
  const router = Router();

  async function scope(req: BrowserCompanionRequest, inklingId?: string) {
    const claims = req.browserClient;
    const composer = await getComposer();
    const client = composer.getClient();
    // Grant liveness does not prove current workspace membership.
    const role = await roleOfUserIn(client, claims.workspaceId, claims.sub, 'You');
    const recipientId = await new BrowserCompanionGrantService(client).recipientBinding(claims);
    const ownerScope = { userId: claims.sub, workspaceId: claims.workspaceId };
    const inklings =
      recipientId === null
        ? await new InklingService(client).list(ownerScope)
        : await browserChatRecipients(client, ownerScope, recipientId);
    const inkling = inklings.find((entry) => entry.id === inklingId);
    return { composer, client, claims, inklings, inkling, role };
  }
  const publicInkling = (inkling: Pick<Inkling, 'id' | 'displayName'>) => ({
    id: inkling.id,
    name: inkling.displayName ?? 'Unnamed inkling',
  });

  router.get('/chat/inklings', async (req, res) => {
    try {
      const { inklings } = await scope(req as BrowserCompanionRequest);
      res.json({ inklings: inklings.map(publicInkling) });
    } catch {
      res.status(503).json({ error: 'browser_chat_unavailable' });
    }
  });

  router.get('/chat/receipt', async (req, res) => {
    const parsed = selection
      .extend({ operationId: z.string().uuid() })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_chat_receipt' });
      return;
    }
    try {
      const { client, claims, inkling } = await scope(
        req as BrowserCompanionRequest,
        parsed.data.inklingId
      );
      if (!inkling) {
        res.status(403).json({ error: 'inkling_not_owned' });
        return;
      }
      const { data: thread, error } = await client
        .from('inbox_threads')
        .select('id, created_by_user_id')
        .eq('workspace_id', claims.workspaceId)
        .eq('thread_key', browserChatKey(claims.grantId, inkling.id))
        .maybeSingle();
      if (error) throw error;
      if (thread && thread.created_by_user_id !== claims.sub) {
        res.status(403).json({ error: 'conversation_not_owned' });
        return;
      }
      let stored = false;
      if (thread) {
        const { data, error: readError } = await client
          .from('inbox_thread_messages')
          .select('id')
          .eq('thread_id', thread.id)
          .eq('sender_kind', 'user')
          .eq('sender_user_id', claims.sub)
          .eq('metadata->>clientMessageId', parsed.data.operationId)
          .maybeSingle();
        if (readError) throw readError;
        stored = !!data;
      }
      // Missing is NOT proof of rejection: a previous request may still land.
      res.json({ operationId: parsed.data.operationId, status: stored ? 'stored' : 'unknown' });
    } catch {
      res.status(503).json({ error: 'browser_chat_unavailable' });
    }
  });

  router.get('/chat/messages', async (req, res) => {
    const parsed = selection.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_chat_selection' });
      return;
    }
    try {
      const { client, claims, inkling } = await scope(
        req as BrowserCompanionRequest,
        parsed.data.inklingId
      );
      if (!inkling) {
        res.status(403).json({ error: 'inkling_not_owned' });
        return;
      }
      const key = browserChatKey(claims.grantId, inkling.id);
      const { data: thread, error } = await client
        .from('inbox_threads')
        .select('id, created_by_user_id')
        .eq('workspace_id', claims.workspaceId)
        .eq('thread_key', key)
        .maybeSingle();
      if (error) throw error;
      // Even a correctly shaped key is not ownership of an existing thread.
      if (thread && thread.created_by_user_id !== claims.sub) {
        res.status(403).json({ error: 'conversation_not_owned' });
        return;
      }
      if (!thread) {
        res.json({ threadKey: key, inkling: publicInkling(inkling), messages: [] });
        return;
      }
      const { data: members, error: memberError } = await client
        .from('inbox_thread_participants')
        .select('sb_id, user_id')
        .eq('thread_id', thread.id);
      if (memberError) throw memberError;
      if (
        !members?.length ||
        members.some(
          (m) => (m.sb_id && m.sb_id !== inkling.id) || (m.user_id && m.user_id !== claims.sub)
        )
      ) {
        res.status(403).json({ error: 'conversation_members_changed' });
        return;
      }
      const { data: messages, error: readError } = await client
        .from('inbox_thread_messages')
        .select('id, sender_kind, sender_sb_id, sender_user_id, content, metadata')
        .eq('thread_id', thread.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(100);
      if (readError) throw readError;
      res.json({
        threadKey: key,
        inkling: publicInkling(inkling),
        messages: (messages ?? []).reverse().map((row) => {
          const metadata = row.metadata as Record<string, unknown> | null;
          const mine = row.sender_kind === 'user' && row.sender_user_id === claims.sub;
          return {
            id:
              mine && typeof metadata?.clientMessageId === 'string'
                ? metadata.clientMessageId
                : row.id,
            author: mine
              ? 'You'
              : row.sender_kind === 'sb' && row.sender_sb_id === inkling.id
                ? publicInkling(inkling).name
                : 'System',
            body: row.content.slice(0, 8_000),
            // Existence proves storage, not execution or completion.
            status: 'stored',
          };
        }),
      });
    } catch {
      res.status(503).json({ error: 'browser_chat_unavailable' });
    }
  });

  router.post('/chat/message', async (req, res) => {
    const parsed = submission.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_chat_message' });
      return;
    }
    try {
      const { composer, client, claims, inkling, role } = await scope(
        req as BrowserCompanionRequest,
        parsed.data.inklingId
      );
      if (!inkling) {
        res.status(403).json({ error: 'inkling_not_owned' });
        return;
      }
      try {
        assertWriteRole(role, 'send to a thread');
      } catch {
        res.status(403).json({ error: 'workspace_read_only' });
        return;
      }
      const key = browserChatKey(claims.grantId, inkling.id);
      const { body, operationId } = parsed.data;
      const replay = async () => {
        const { data: thread, error } = await client
          .from('inbox_threads')
          .select('id, created_by_user_id')
          .eq('workspace_id', claims.workspaceId)
          .eq('thread_key', key)
          .maybeSingle();
        if (error) throw error;
        if (!thread) return false;
        if (thread.created_by_user_id !== claims.sub) {
          res.status(403).json({ error: 'conversation_not_owned' });
          return true;
        }
        const { data: members, error: memberError } = await client
          .from('inbox_thread_participants')
          .select('sb_id, user_id')
          .eq('thread_id', thread.id);
        if (memberError) throw memberError;
        if (
          members?.some(
            (m) => (m.sb_id && m.sb_id !== inkling.id) || (m.user_id && m.user_id !== claims.sub)
          )
        ) {
          res.status(403).json({ error: 'conversation_members_changed' });
          return true;
        }
        const receipt = await lookUpClientMessage(client, {
          threadId: thread.id,
          clientMessageId: operationId,
          userId: claims.sub,
          content: body,
          wake: null,
        });
        if (receipt.kind === 'none') return false;
        if (receipt.kind === 'conflict') res.status(409).json({ error: 'message_conflict' });
        else res.json({ operationId, status: 'stored', replayed: true });
        return true;
      };
      if (await replay()) return;
      let result;
      try {
        result = await handleSendToInbox(
          {
            userId: claims.sub,
            recipientSlug: inkling.sbSlug,
            threadKey: key,
            content: body,
            messageType: 'message',
            metadata: {
              sentBy: 'user',
              channel: 'browser-companion',
              clientMessageId: operationId,
            },
          },
          composer,
          {
            recipientId: inkling.id,
            sender: { principal: userPrincipal(claims.sub), workspaceId: claims.workspaceId },
          }
        );
      } catch (error) {
        if (isClientMessageConflict(error) && (await replay())) return;
        throw error;
      }
      const block = result.content.find((entry) => entry.type === 'text');
      const sent = JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<
        string,
        unknown
      >;
      if (typeof sent.messageId !== 'string') {
        res.status(409).json({ error: 'message_not_stored' });
        return;
      }
      const delivery = deliveryFromSendResult(sent);
      await recordDelivery(client, sent.messageId, delivery);
      res.json({
        operationId,
        status: delivery.status === 'routed' ? 'queued' : 'stored',
        replayed: false,
      });
    } catch {
      // The store or dispatch may already have happened: never call this rejected.
      res.status(503).json({ error: 'message_outcome_unknown' });
    }
  });
  return router;
}
