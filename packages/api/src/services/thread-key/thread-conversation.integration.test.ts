/**
 * The chat view's two PostgREST reads, against a real database.
 *
 * The route test's fake builder encodes what these queries are BELIEVED to
 * do — an embed's order/limit applying per parent, an embed filter leaving
 * the parent in place, a compound cursor never skipping a timestamp twin.
 * Only PostgREST can confirm those beliefs; if any is wrong the fake is
 * wrong with it, and every route test stays green.
 *
 * Run via: yarn test:integration:db:local src/services/thread-key/thread-conversation.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import {
  LAST_MESSAGE_EMBED,
  olderThan,
  toLastMessage,
  withLastMessage,
} from './thread-conversation';

describe('thread conversation reads (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let workspaceId: string;
  let echoSbId: string;
  const threadIds: string[] = [];
  const run = `${Date.now()}`;

  async function thread(label: string): Promise<string> {
    const { data, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: `test:chat-${label}-${run}`,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: echoSbId,
        title: `chat fixture ${label}`,
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create thread: ${error.message}`);
    threadIds.push(data.id as string);
    return data.id as string;
  }

  /** Authored by the echo SB, by the fixture person, or by the system (spec §3). */
  async function message(
    threadId: string,
    over: { content: string; created_at: string; message_type?: string },
    author: 'sb' | 'user' | 'system' = over.message_type === 'system' ? 'system' : 'sb'
  ): Promise<string> {
    const principal =
      author === 'sb'
        ? { sender_kind: 'sb', sender_sb_id: echoSbId, sender_agent_id: 'echo' }
        : author === 'user'
          ? { sender_kind: 'user', sender_user_id: userId }
          : { sender_kind: 'system' };
    const { data, error } = await supabase
      .from('inbox_thread_messages')
      .insert({ thread_id: threadId, ...principal, ...over })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to insert message: ${error.message}`);
    return data.id as string;
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    echoSbId = fixture.echoSbId;
  });

  afterAll(async () => {
    for (const id of threadIds) {
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', id);
      await supabase.from('inbox_threads').delete().eq('id', id);
    }
  });

  it('embeds each thread’s newest deliverable message, per thread, keeping every thread', async () => {
    const chatty = await thread('chatty');
    const quiet = await thread('quiet');
    const eventsOnly = await thread('events-only');

    await message(chatty, { content: 'first', created_at: '2026-09-20T10:00:00Z' });
    // The newest real message is a person's: the embed must carry the
    // principal columns the preview names its author from.
    const newest = await message(
      chatty,
      { content: 'newest real message', created_at: '2026-09-20T11:00:00Z' },
      'user'
    );
    // Newer than every real message, and must not win the preview.
    await message(chatty, {
      content: 'Thread closed',
      created_at: '2026-09-20T12:00:00Z',
      message_type: 'system',
    });
    const quietOnly = await message(quiet, { content: 'only', created_at: '2026-09-19T09:00:00Z' });
    await message(eventsOnly, {
      content: 'Thread reopened',
      created_at: '2026-09-20T13:00:00Z',
      message_type: 'system',
    });

    const { data, error } = await withLastMessage(
      supabase.from('inbox_threads').select(`id, ${LAST_MESSAGE_EMBED}`)
    )
      .eq('workspace_id', workspaceId)
      .in('id', [chatty, quiet, eventsOnly]);
    expect(error).toBeNull();

    const byId = new Map<string, unknown[]>(
      (data as Array<{ id: string; last_message: unknown[] }>).map((row) => [
        row.id,
        row.last_message,
      ])
    );
    // Every parent survives the embed filter — a thread with only system
    // events is still a thread in the list.
    expect([...byId.keys()].sort()).toEqual([chatty, quiet, eventsOnly].sort());
    // The limit is per parent: each thread has exactly its own newest.
    expect(byId.get(chatty)).toHaveLength(1);
    const namePerson = (id: string) => ({ name: 'the fixture person', isOwn: id === userId });
    expect(toLastMessage(byId.get(chatty), namePerson)).toMatchObject({
      id: newest,
      senderKind: 'user',
      senderName: 'the fixture person',
      isOwn: true,
    });
    expect(toLastMessage(byId.get(quiet), namePerson)).toMatchObject({
      id: quietOnly,
      senderKind: 'sb',
      senderSlug: 'echo',
    });
    expect(byId.get(eventsOnly)).toEqual([]);
    expect(toLastMessage(byId.get(eventsOnly), namePerson)).toBeNull();
  });

  it('pages backwards through timestamp twins without skipping or repeating one', async () => {
    const threadId = await thread('paging');
    const twinAt = '2026-09-21T08:00:00.123456+00:00';
    const ids = [
      await message(threadId, { content: 'a', created_at: '2026-09-21T07:00:00Z' }),
      await message(threadId, { content: 'b', created_at: twinAt }),
      await message(threadId, { content: 'c', created_at: twinAt }),
      await message(threadId, { content: 'd', created_at: twinAt }),
      await message(threadId, { content: 'e', created_at: '2026-09-21T09:00:00Z' }),
    ];

    const page = async (cursor: { id: string; createdAt: string } | null) => {
      let query = supabase
        .from('inbox_thread_messages')
        .select('id, created_at', { count: 'exact' })
        .eq('thread_id', threadId);
      if (cursor) query = olderThan(query, cursor);
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(2);
      expect(error).toBeNull();
      return { rows: data as Array<{ id: string; created_at: string }>, count: count as number };
    };

    const seen: string[] = [];
    const counts: number[] = [];
    let cursor: { id: string; createdAt: string } | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const { rows, count } = await page(cursor);
      counts.push(count);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const oldest = rows[rows.length - 1];
      cursor = { id: oldest.id, createdAt: oldest.created_at };
    }

    // Every message exactly once. The page boundary falls INSIDE the twin
    // group (pages of 2 over e, d|c|b twins, a), which is where a
    // created_at-only cursor loses the twins it has not served yet.
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    // The count is "everything at or beyond the cursor", so it shrinks by
    // exactly what each page served — what the route reports as `total`.
    expect(counts).toEqual([5, 3, 1, 0]);
  });
});
