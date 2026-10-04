/**
 * thread_message_reactions against the real database
 * (20261004095944_thread_message_reactions.sql, ink://specs/inkling-reactions).
 *
 * What only Postgres can show: the guard trigger's per-reactor limit holds
 * when requests race (a count in the API would let two requests that each
 * saw five both insert), the unique index makes a repeat a no-op, the
 * reaction's thread and workspace must be its message's, an SB from another
 * workspace cannot react here (the composite key), and deleting a message
 * takes its reactions with it. And a reaction moves nothing else: no
 * message row, no thread recency, no read pointer.
 *
 * Run via: yarn test:integration:db:local src/services/threads/thread-reactions.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import { userPrincipal, type SbPrincipal } from '../principals';
import {
  REACTION_LIMIT_TOKEN,
  REACTIONS_TABLE,
  ReactionRefusedError,
  reactToMessage,
} from './thread-reactions';

const RUN = Math.random().toString(36).slice(2, 8);
const SIX = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
const TWELVE = [...SIX, '🎉', '🔥', '👀', '✅', '🌱', '🦋'];

describe('thread_message_reactions (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let workspaceId: string;
  let userId: string;
  let member: SbPrincipal;
  let other: SbPrincipal;
  let foreignUserId: string;
  let foreignSbId: string;
  const threadIds: string[] = [];
  const identityIds: string[] = [];

  async function thread(key: string, sbMembers: string[], people: string[]): Promise<string> {
    const { data, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: `${key}-${RUN}`,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: member.sbId,
        status: 'open',
      })
      .select('id')
      .single();
    if (error) throw new Error(`thread insert: ${error.message}`);
    threadIds.push(data.id);
    const rows = [
      ...sbMembers.map((sbId) => ({ thread_id: data.id, workspace_id: workspaceId, sb_id: sbId })),
      ...people.map((id) => ({ thread_id: data.id, workspace_id: workspaceId, user_id: id })),
    ];
    const { error: participantError } = await supabase
      .from('inbox_thread_participants')
      .insert(rows);
    if (participantError) throw new Error(`participant insert: ${participantError.message}`);
    return data.id as string;
  }

  async function message(threadId: string): Promise<string> {
    const { data, error } = await supabase
      .from('inbox_thread_messages')
      .insert({
        thread_id: threadId,
        sender_kind: 'sb',
        sender_sb_id: member.sbId,
        sender_agent_id: member.sbSlug,
        content: 'react to me',
      })
      .select('id')
      .single();
    if (error) throw new Error(`message insert: ${error.message}`);
    return data.id as string;
  }

  async function keyOf(threadId: string): Promise<string> {
    const { data } = await supabase
      .from('inbox_threads')
      .select('thread_key')
      .eq('id', threadId)
      .single();
    return data.thread_key as string;
  }

  /** A raw insert, as any writer other than the API would make it. */
  function insertReaction(row: Record<string, unknown>) {
    return supabase.from(REACTIONS_TABLE).insert(row);
  }

  async function rowsOn(messageId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await supabase
      .from(REACTIONS_TABLE)
      .select('*')
      .eq('message_id', messageId);
    if (error) throw new Error(error.message);
    return data;
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    workspaceId = fixture.workspaceId;
    userId = fixture.userId;
    const sb = async (slug: string): Promise<SbPrincipal> => {
      const id = await ensureSuiteIdentity(dataComposer, fixture, slug);
      identityIds.push(id);
      return { kind: 'sb', sbId: id, sbSlug: slug, userId, workspaceId };
    };
    member = await sb(`reactor-${RUN}`);
    other = await sb(`other-reactor-${RUN}`);

    // An SB in somebody else's workspace.
    foreignUserId = randomUUID();
    const { error: userError } = await supabase
      .from('users')
      .insert({ id: foreignUserId, email: `reactions-${RUN}@integration.test` });
    if (userError) throw new Error(`foreign user: ${userError.message}`);
    const { data: personal } = await supabase
      .from('workspaces')
      .select('id')
      .eq('user_id', foreignUserId)
      .eq('slug', 'personal')
      .maybeSingle();
    if (!personal?.id) throw new Error('foreign personal workspace was not provisioned');
    const { data: foreign, error: foreignError } = await supabase
      .from('agent_identities')
      .insert({
        user_id: foreignUserId,
        workspace_id: personal.id,
        agent_id: `foreign-${RUN}`,
        name: 'foreign',
        role: 'Integration suite identity',
        metadata: { fixture: true, suite: true },
        backend: 'claude',
      })
      .select('id')
      .single();
    if (foreignError) throw new Error(`foreign sb: ${foreignError.message}`);
    foreignSbId = foreign.id as string;
  });

  afterAll(async () => {
    if (threadIds.length) {
      await supabase.from('inbox_thread_read_status').delete().in('thread_id', threadIds);
      await supabase.from('inbox_thread_messages').delete().in('thread_id', threadIds);
      await supabase.from('inbox_thread_participants').delete().in('thread_id', threadIds);
      await supabase.from('inbox_threads').delete().in('id', threadIds);
    }
    if (identityIds.length) await supabase.from('agent_identities').delete().in('id', identityIds);
    if (foreignUserId) {
      await supabase.from('agent_identities').delete().eq('user_id', foreignUserId);
      await supabase.from('workspace_members').delete().eq('user_id', foreignUserId);
      await supabase.from('users').delete().eq('id', foreignUserId);
    }
  });

  const react = (
    threadKey: string,
    messageId: string,
    reactor: SbPrincipal | ReturnType<typeof userPrincipal>,
    emoji: string,
    remove = false
  ) => reactToMessage(supabase, { workspaceId, threadKey, messageId, emoji, remove, reactor });

  it('stores a member’s reaction with its message’s thread and workspace, and moves nothing else', async () => {
    const threadId = await thread('thread:reactions-store', [member.sbId], [userId]);
    const messageId = await message(threadId);
    const before = await supabase
      .from('inbox_threads')
      .select('updated_at')
      .eq('id', threadId)
      .single();
    const { count: messagesBefore } = await supabase
      .from('inbox_thread_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', threadId);

    const answer = await react(await keyOf(threadId), messageId, member, '👍');
    expect(answer.reactions).toEqual([
      { emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: member.sbId }], mine: true },
    ]);
    const mine = await react(await keyOf(threadId), messageId, userPrincipal(userId), '👍');
    expect(mine.reactions[0]).toMatchObject({ count: 2, mine: true });

    const [stored] = await rowsOn(messageId);
    expect(stored).toMatchObject({ thread_id: threadId, workspace_id: workspaceId });
    const after = await supabase
      .from('inbox_threads')
      .select('updated_at')
      .eq('id', threadId)
      .single();
    expect(after.data.updated_at).toBe(before.data.updated_at);
    const { count: messagesAfter } = await supabase
      .from('inbox_thread_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', threadId);
    expect(messagesAfter).toBe(messagesBefore);
    const { data: pointers } = await supabase
      .from('inbox_thread_read_status')
      .select('thread_id')
      .eq('thread_id', threadId);
    expect(pointers).toEqual([]);
  });

  it('takes six emoji from one reactor, refuses a seventh (409), and lets it re-add one it has', async () => {
    const threadId = await thread('thread:reactions-limit', [member.sbId, other.sbId], []);
    const messageId = await message(threadId);
    const key = await keyOf(threadId);
    for (const emoji of SIX) await react(key, messageId, member, emoji);
    await expect(react(key, messageId, member, '🎉')).rejects.toMatchObject({
      status: 409,
      code: 'reaction_limit',
    });
    expect((await react(key, messageId, member, '😂')).reactions).toHaveLength(6);
    // The limit is per reactor: another one still adds a seventh emoji.
    expect((await react(key, messageId, other, '🎉')).reactions).toHaveLength(7);
    expect(await rowsOn(messageId)).toHaveLength(7);
  });

  it('holds the limit when twelve adds race: exactly six land', async () => {
    const threadId = await thread('thread:reactions-race', [member.sbId], []);
    const messageId = await message(threadId);
    const key = await keyOf(threadId);
    const results = await Promise.allSettled(
      TWELVE.map((emoji) => react(key, messageId, member, emoji))
    );
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof ReactionRefusedError &&
        r.reason.code === 'reaction_limit'
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(refused).toHaveLength(6);
    expect(await rowsOn(messageId)).toHaveLength(6);
  });

  it('stores one row when the same reaction races, and every request answers as added', async () => {
    const threadId = await thread('thread:reactions-repeat', [member.sbId], []);
    const messageId = await message(threadId);
    const key = await keyOf(threadId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => react(key, messageId, member, '❤️'))
    );
    for (const result of results)
      expect(result.reactions[0]).toMatchObject({ emoji: '❤️', count: 1 });
    expect(await rowsOn(messageId)).toHaveLength(1);
  });

  it('removes only the reactor’s own reaction', async () => {
    const threadId = await thread('thread:reactions-remove', [member.sbId, other.sbId], []);
    const messageId = await message(threadId);
    const key = await keyOf(threadId);
    await react(key, messageId, member, '👍');
    await react(key, messageId, other, '👍');
    const answer = await react(key, messageId, member, '👍', true);
    expect(answer.reactions).toEqual([
      { emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: other.sbId }], mine: false },
    ]);
  });

  it('refuses a raw write whose thread or workspace is not its message’s', async () => {
    const threadId = await thread('thread:reactions-mismatch', [member.sbId], []);
    const elsewhere = await thread('thread:reactions-elsewhere', [member.sbId], []);
    const messageId = await message(threadId);
    const wrongThread = await insertReaction({
      message_id: messageId,
      thread_id: elsewhere,
      workspace_id: workspaceId,
      reactor_sb_id: member.sbId,
      emoji: '👍',
    });
    expect(wrongThread.error?.code).toBe('23514');
    const { data: foreignWorkspace } = await supabase
      .from('agent_identities')
      .select('workspace_id')
      .eq('id', foreignSbId)
      .single();
    const wrongWorkspace = await insertReaction({
      message_id: messageId,
      thread_id: threadId,
      workspace_id: foreignWorkspace.workspace_id,
      reactor_sb_id: foreignSbId,
      emoji: '👍',
    });
    expect(wrongWorkspace.error?.code).toBe('23514');
    expect(await rowsOn(messageId)).toEqual([]);
  });

  it('refuses an SB from another workspace even with this thread’s workspace named (the composite key)', async () => {
    const threadId = await thread('thread:reactions-foreign', [member.sbId], []);
    const messageId = await message(threadId);
    const { error } = await insertReaction({
      message_id: messageId,
      thread_id: threadId,
      workspace_id: workspaceId,
      reactor_sb_id: foreignSbId,
      emoji: '👍',
    });
    expect(error?.code).toBe('23503');
    expect(await rowsOn(messageId)).toEqual([]);
  });

  it('refuses a raw write with no reactor, two reactors, or an emoji the column cannot hold', async () => {
    const threadId = await thread('thread:reactions-shape', [member.sbId], []);
    const messageId = await message(threadId);
    const base = { message_id: messageId, thread_id: threadId, workspace_id: workspaceId };
    for (const row of [
      { ...base, emoji: '👍' },
      { ...base, emoji: '👍', reactor_sb_id: member.sbId, reactor_user_id: userId },
      { ...base, emoji: '', reactor_sb_id: member.sbId },
      { ...base, emoji: 'x'.repeat(17), reactor_sb_id: member.sbId },
    ]) {
      const { error } = await insertReaction(row);
      expect(error?.code).toBe('23514');
    }
    expect(await rowsOn(messageId)).toEqual([]);
  });

  it('raises the limit token the API maps to 409 on a raw seventh insert', async () => {
    const threadId = await thread('thread:reactions-token', [member.sbId], []);
    const messageId = await message(threadId);
    const base = {
      message_id: messageId,
      thread_id: threadId,
      workspace_id: workspaceId,
      reactor_sb_id: member.sbId,
    };
    for (const emoji of SIX) {
      const { error } = await insertReaction({ ...base, emoji });
      expect(error).toBeNull();
    }
    const { error } = await insertReaction({ ...base, emoji: '🎉' });
    expect(error?.message).toContain(REACTION_LIMIT_TOKEN);
  });

  it('deletes a message’s reactions with the message', async () => {
    const threadId = await thread('thread:reactions-cascade', [member.sbId], []);
    const messageId = await message(threadId);
    const keep = await message(threadId);
    const key = await keyOf(threadId);
    await react(key, messageId, member, '👍');
    await react(key, keep, member, '👍');
    const { error } = await supabase.from('inbox_thread_messages').delete().eq('id', messageId);
    expect(error).toBeNull();
    expect(await rowsOn(messageId)).toEqual([]);
    expect(await rowsOn(keep)).toHaveLength(1);
  });
});
