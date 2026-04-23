/**
 * Thread Handler Integration Tests (real Supabase)
 *
 * Verifies the server-side read cursor behavior in `handleGetThreadMessages`:
 *
 *   1. markRead advances `last_read_at` to the max created_at of the returned
 *      batch (not NOW) so a partial fetch does not silently mark untouched
 *      newer messages as read.
 *   2. When no explicit cursor is provided, the handler falls back to the
 *      caller's `last_read_at` as an implicit cursor — a client whose
 *      in-memory cursor was reset (e.g. channel-plugin restart) does not
 *      replay full thread history.
 *   3. markRead is monotonic — an explicit `afterMessageId` pointing at an old
 *      message must not regress the stored pointer backwards.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { handleGetThreadMessages } from './thread-handlers';

type ThreadRow = { id: string; status: string };
type MessageRow = { id: string; created_at: string };
type ReadStatusRow = { last_read_at: string };
type ThreadMessagesResult = {
  success: boolean;
  messageCount: number;
  messages: Array<{ id: string; createdAt: string; senderAgentId: string; content: string }>;
};

async function parseResult(raw: {
  content: Array<{ text: string }>;
}): Promise<ThreadMessagesResult> {
  return JSON.parse(raw.content[0].text) as ThreadMessagesResult;
}

describe('Thread Handlers Integration — read cursor + monotonic markRead', () => {
  let dataComposer: DataComposer;
  let userId: string;
  const testThreadKeys: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    if (testThreadKeys.length === 0) return;
    const supabase = dataComposer.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = supabase as any;
    for (const key of testThreadKeys) {
      const { data: thread } = await raw
        .from('inbox_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('thread_key', key)
        .maybeSingle();
      if (thread?.id) {
        await raw.from('inbox_thread_messages').delete().eq('thread_id', thread.id);
        await raw.from('inbox_thread_participants').delete().eq('thread_id', thread.id);
        await raw.from('inbox_thread_read_status').delete().eq('thread_id', thread.id);
        await raw.from('inbox_threads').delete().eq('id', thread.id);
      }
    }
    testThreadKeys.length = 0;
  });

  afterAll(async () => {
    // Safety sweep: remove any leftover threads created by this suite for this user
    const supabase = dataComposer.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = supabase as any;
    await raw
      .from('inbox_threads')
      .delete()
      .eq('user_id', userId)
      .like('thread_key', 'thread:test-cursor-%');
  });

  async function createThreadWithMessages(
    threadKey: string,
    senderAgentId: string,
    agentId: string,
    messages: Array<{ sender: string; content: string }>,
    spacingMs = 25
  ): Promise<{ threadId: string; messageIds: string[] }> {
    testThreadKeys.push(threadKey);
    const supabase = dataComposer.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = supabase as any;

    const { data: thread, error: threadError } = await raw
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: userId,
        created_by_agent_id: senderAgentId,
        status: 'open',
      })
      .select('id')
      .single();
    if (threadError || !thread) throw new Error(`thread insert: ${threadError?.message}`);
    const threadId = (thread as ThreadRow).id;

    // Participants — sender + receiver
    await raw.from('inbox_thread_participants').insert([
      { thread_id: threadId, agent_id: senderAgentId },
      { thread_id: threadId, agent_id: agentId },
    ]);

    // Insert messages serially so created_at is monotonic
    const messageIds: string[] = [];
    for (const m of messages) {
      const { data: row, error } = await raw
        .from('inbox_thread_messages')
        .insert({
          thread_id: threadId,
          sender_agent_id: m.sender,
          content: m.content,
          message_type: 'message',
        })
        .select('id, created_at')
        .single();
      if (error || !row) throw new Error(`message insert: ${error?.message}`);
      messageIds.push((row as MessageRow).id);
      if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
    }

    return { threadId, messageIds };
  }

  async function readPointer(threadId: string, agentId: string): Promise<string | null> {
    const supabase = dataComposer.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = supabase as any;
    const { data } = await raw
      .from('inbox_thread_read_status')
      .select('last_read_at')
      .eq('thread_id', threadId)
      .eq('agent_id', agentId)
      .maybeSingle();
    return (data as ReadStatusRow | null)?.last_read_at ?? null;
  }

  it('markRead advances last_read_at to max created_at of the returned batch (not NOW)', async () => {
    const threadKey = 'thread:test-cursor-partial-' + Date.now();
    const { threadId, messageIds } = await createThreadWithMessages(threadKey, 'lumen', 'wren', [
      { sender: 'lumen', content: 'first' },
      { sender: 'lumen', content: 'second' },
      { sender: 'lumen', content: 'third' },
      { sender: 'lumen', content: 'fourth' },
      { sender: 'lumen', content: 'fifth' },
    ]);

    // Fetch only 2 messages — must not advance read pointer past those 2
    const raw = await handleGetThreadMessages(
      { userId, threadKey, agentId: 'wren', limit: 2, markRead: true },
      dataComposer
    );
    const result = await parseResult(raw);
    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(2);
    expect(result.messages.map((m) => m.content)).toEqual(['first', 'second']);

    // Pointer should equal the 2nd message's created_at, NOT NOW
    const pointer = await readPointer(threadId, 'wren');
    expect(pointer).not.toBeNull();

    // Fetch the 2nd message's created_at directly for comparison
    const supabase = dataComposer.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: secondRow } = await (supabase as any)
      .from('inbox_thread_messages')
      .select('created_at')
      .eq('id', messageIds[1])
      .single();
    expect(pointer).toBe(secondRow.created_at);
  });

  it('falls back to last_read_at as implicit cursor when no afterMessageId is provided', async () => {
    const threadKey = 'thread:test-cursor-fallback-' + Date.now();
    const { messageIds } = await createThreadWithMessages(threadKey, 'lumen', 'wren', [
      { sender: 'lumen', content: 'old-1' },
      { sender: 'lumen', content: 'old-2' },
      { sender: 'lumen', content: 'old-3' },
      { sender: 'lumen', content: 'new-1' },
      { sender: 'lumen', content: 'new-2' },
    ]);

    // First fetch — advance the pointer through the first 3 messages
    const first = await parseResult(
      await handleGetThreadMessages(
        { userId, threadKey, agentId: 'wren', limit: 3, markRead: true },
        dataComposer
      )
    );
    expect(first.messages.map((m) => m.content)).toEqual(['old-1', 'old-2', 'old-3']);

    // Second fetch — NO cursor passed. The fallback must kick in and return
    // only messages after last_read_at, NOT the earliest N from scratch.
    const second = await parseResult(
      await handleGetThreadMessages(
        { userId, threadKey, agentId: 'wren', limit: 50, markRead: true },
        dataComposer
      )
    );
    expect(second.messages.map((m) => m.content)).toEqual(['new-1', 'new-2']);
    expect(second.messages.map((m) => m.id)).toEqual([messageIds[3], messageIds[4]]);
  });

  it('fallback returns full thread when the caller has no prior read status', async () => {
    const threadKey = 'thread:test-cursor-no-pointer-' + Date.now();
    await createThreadWithMessages(threadKey, 'lumen', 'wren', [
      { sender: 'lumen', content: 'a' },
      { sender: 'lumen', content: 'b' },
      { sender: 'lumen', content: 'c' },
    ]);

    // No markRead writes here — caller has never read this thread
    const result = await parseResult(
      await handleGetThreadMessages(
        { userId, threadKey, agentId: 'wren', limit: 50, markRead: false },
        dataComposer
      )
    );
    expect(result.messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });

  it('monotonic last_read_at — an old explicit afterMessageId does not regress the pointer', async () => {
    const threadKey = 'thread:test-cursor-monotonic-' + Date.now();
    const { threadId, messageIds } = await createThreadWithMessages(threadKey, 'lumen', 'wren', [
      { sender: 'lumen', content: 'one' },
      { sender: 'lumen', content: 'two' },
      { sender: 'lumen', content: 'three' },
      { sender: 'lumen', content: 'four' },
      { sender: 'lumen', content: 'five' },
    ]);

    // Advance the pointer to message 4
    await parseResult(
      await handleGetThreadMessages(
        { userId, threadKey, agentId: 'wren', limit: 4, markRead: true },
        dataComposer
      )
    );
    const pointerAfterFirst = await readPointer(threadId, 'wren');
    expect(pointerAfterFirst).not.toBeNull();

    // Now call with an explicit afterMessageId pointing to message 1 — this
    // would return messages 2 and 3, older than the current pointer. The
    // monotonic guard must prevent the pointer from regressing.
    await parseResult(
      await handleGetThreadMessages(
        {
          userId,
          threadKey,
          agentId: 'wren',
          afterMessageId: messageIds[0],
          limit: 2,
          markRead: true,
        },
        dataComposer
      )
    );
    const pointerAfterStale = await readPointer(threadId, 'wren');
    expect(pointerAfterStale).toBe(pointerAfterFirst);
  });

  it('explicit afterMessageId overrides the fallback', async () => {
    const threadKey = 'thread:test-cursor-explicit-' + Date.now();
    const { messageIds } = await createThreadWithMessages(threadKey, 'lumen', 'wren', [
      { sender: 'lumen', content: 'a' },
      { sender: 'lumen', content: 'b' },
      { sender: 'lumen', content: 'c' },
      { sender: 'lumen', content: 'd' },
    ]);

    // Advance pointer to message 3
    await parseResult(
      await handleGetThreadMessages(
        { userId, threadKey, agentId: 'wren', limit: 3, markRead: true },
        dataComposer
      )
    );

    // Explicit afterMessageId=messages[0] should return b, c, d — bypassing
    // the fallback (which would have returned just d).
    const result = await parseResult(
      await handleGetThreadMessages(
        {
          userId,
          threadKey,
          agentId: 'wren',
          afterMessageId: messageIds[0],
          limit: 50,
          markRead: false,
        },
        dataComposer
      )
    );
    expect(result.messages.map((m) => m.content)).toEqual(['b', 'c', 'd']);
  });
});
