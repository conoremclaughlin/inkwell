/**
 * An inkling's closing text, posted on Postgres (task 9edf62fe).
 *
 * The unit suite runs the real send path over the in-memory fake. This one
 * runs it against the real schema, because the SB server-internal sender is
 * new to production: the person starts a conversation with their inkling,
 * the inkling's turn ends without a word, and its closing text lands as the
 * inkling's own message, once.
 *
 * Run via: yarn test:integration:db:local src/services/inklings/inkling-closing-text.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import { handleSendToInbox } from '../../mcp/tools/inbox-handlers';
import { userPrincipal } from '../principals';
import { INKLING_CLIENT } from './inkling-service';
import {
  CLOSING_TEXT_FOR,
  postClosingTextIfSilent,
  readTurnBoundary,
} from './inkling-closing-text';

const RUN = randomUUID().slice(0, 8);
const INK = `closing-ink-${RUN}`;
const KEY = `chat:conversation-closing-${RUN}`;

describe('an inkling closing text on Postgres', () => {
  let dc: DataComposer;
  let userId: string;
  let workspaceId: string;
  let inkSbId: string | null = null;
  let threadId: string;
  let wakingId: string;

  const messagesInThread = async () => {
    const { data, error } = await dc
      .getClient()
      .from('inbox_thread_messages')
      .select('id, sender_kind, sender_sb_id, sender_user_id, content, metadata, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  beforeAll(async () => {
    dc = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dc);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    inkSbId = await ensureSuiteIdentity(dc, fixture, INK);
    const { error: inkError } = await dc
      .getClient()
      .from('agent_identities')
      .update({ metadata: { fixture: true, suite: true, client: INKLING_CLIENT, ownerTest: true } })
      .eq('id', inkSbId);
    if (inkError) throw new Error(`inkling identity: ${inkError.message}`);
    vi.stubEnv('INKLING_OWNER_TEST_USER_ID', userId);

    // The person starts the conversation. Nothing is woken: the turn below
    // is the one that "ran".
    await handleSendToInbox(
      { userId, threadKey: KEY, recipientSlug: INK, content: 'hi', trigger: false },
      dc,
      { sender: { principal: userPrincipal(userId), workspaceId } }
    );
    const { data: thread, error: threadError } = await dc
      .getClient()
      .from('inbox_threads')
      .select('id, metadata')
      .eq('workspace_id', workspaceId)
      .eq('thread_key', KEY)
      .single();
    if (threadError || !thread) throw new Error(`thread: ${threadError?.message}`);
    expect((thread.metadata as Record<string, unknown>)?.inklingConversation).toBe(true);
    threadId = thread.id as string;
    const [waking] = await messagesInThread();
    wakingId = waking.id as string;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!dc) return;
    const raw = dc.getClient();
    if (threadId) {
      await raw.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
      await raw.from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await raw.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await raw.from('inbox_threads').delete().eq('id', threadId);
    }
    if (inkSbId) await raw.from('agent_identities').delete().eq('id', inkSbId);
  });

  it("is stored as the inkling's own message, naming the message it answers, once", async () => {
    // The turn starts: its boundary is the conversation's newest message,
    // read from Postgres's own clock.
    const boundary = await readTurnBoundary(dc, threadId);
    expect(boundary).toEqual({ createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    const turn = {
      boundary,
      result: {
        success: true,
        admitted: true,
        finalTextResponse: "  I couldn't read our conversation, so I didn't reply.  ",
      },
      userId,
      identityId: inkSbId!,
      threadId,
      threadKey: KEY,
      threadMessageId: wakingId,
    };

    expect(await postClosingTextIfSilent(dc, turn)).toMatchObject({ posted: true });

    const rows = await messagesInThread();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      sender_kind: 'sb',
      sender_sb_id: inkSbId,
      sender_user_id: null,
      content: "I couldn't read our conversation, so I didn't reply.",
    });
    expect((rows[1].metadata as Record<string, unknown>)[CLOSING_TEXT_FOR]).toBe(wakingId);

    // A replay of the same wake in a later turn finds the stored closing text.
    const later = { ...turn, boundary: await readTurnBoundary(dc, threadId) };
    expect(await postClosingTextIfSilent(dc, later)).toEqual({
      posted: false,
      skipped: 'already-posted',
    });
    // And the turn that posted it, judged again, sees its own post after its start.
    expect(await postClosingTextIfSilent(dc, turn)).toEqual({ posted: false, skipped: 'replied' });
    expect(await messagesInThread()).toHaveLength(2);
  });
});
