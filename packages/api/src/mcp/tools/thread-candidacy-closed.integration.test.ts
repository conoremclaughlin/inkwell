/**
 * Closed is not a delivery filter (spec inkmail-thread-scope §2).
 *
 * Runs against the real database on purpose. The predicate under test lives
 * in SQL — `get_unread_thread_candidates` — and every unit test of the poll
 * path mocks that RPC, which is exactly how the old `t.status = 'open'` scope
 * stayed invisible: a mocked RPC returns whatever the author believed. Only
 * the function itself can show that a closed thread with an unseen reply is
 * offered for delivery, and that the read pointer — not the status — is what
 * takes it back off the page.
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

// Uniquely namespaced per run so this suite's participant and pointer rows
// can never collide with another suite's use of the shared Echo fixture.
const AGENT = `echo-closed-${Math.random().toString(36).slice(2, 8)}`;

type CandidateRow = { thread_id: string; latest_message_at: string; total_candidates: number };

describe('get_unread_thread_candidates over closed threads (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let threadId: string | undefined;
  const threadKey = `test:closed-candidacy-${Date.now()}`;

  async function candidates(): Promise<CandidateRow[]> {
    const { data, error } = await supabase.rpc('get_unread_thread_candidates', {
      p_user_id: userId,
      p_agent_id: AGENT,
      p_session_id: null,
      p_limit: 50,
    });
    expect(error).toBeNull();
    return (data ?? []) as CandidateRow[];
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;

    // A thread that is closed both ways — status and closed_at — with a
    // participant who joined before the reply, and no read pointer yet.
    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: userId,
        created_by_agent_id: 'echo',
        title: 'closed-thread candidacy',
        status: 'closed',
        closed_at: '2026-09-01T00:00:00Z',
        closed_by_agent_id: 'echo',
      })
      .select('id')
      .single();
    if (threadErr) throw new Error(`Failed to create thread: ${threadErr.message}`);
    threadId = thread.id as string;

    const { error: partErr } = await supabase.from('inbox_thread_participants').insert({
      thread_id: threadId,
      agent_id: AGENT,
      joined_at: '2026-09-01T00:00:00Z',
    });
    if (partErr) throw new Error(`Failed to add participant: ${partErr.message}`);

    const { error: msgErr } = await supabase.from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_agent_id: 'echo',
      content: 'a reply after the thread was closed',
      message_type: 'message',
      created_at: '2026-09-02T00:00:00Z',
    });
    if (msgErr) throw new Error(`Failed to insert message: ${msgErr.message}`);
  });

  afterAll(async () => {
    // Suite-owned cleanup only: exactly the rows this suite created.
    if (!threadId) return;
    await supabase.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
    await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
    await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
    await supabase.from('inbox_threads').delete().eq('id', threadId);
  });

  it('offers a closed thread with an unseen deliverable reply as a candidate', async () => {
    const rows = await candidates();
    const mine = rows.find((r) => r.thread_id === threadId);
    expect(mine).toBeDefined();
    expect(new Date(mine!.latest_message_at).toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(Number(mine!.total_candidates)).toBeGreaterThanOrEqual(1);
  });

  it('a system event on the closed thread does not make it a candidate on its own', async () => {
    // Same rule as open threads: candidacy is over DELIVERABLE messages. A
    // closed thread whose only post-pointer row is a system event (the close
    // marker itself, for instance) must not be offered.
    await supabase
      .from('inbox_thread_read_status')
      .upsert(
        { thread_id: threadId, agent_id: AGENT, last_read_at: '2026-09-02T00:00:00Z' },
        { onConflict: 'thread_id,agent_id' }
      );
    const { error } = await supabase.from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_agent_id: 'system',
      content: 'Thread closed by echo',
      message_type: 'system',
      created_at: '2026-09-03T00:00:00Z',
    });
    expect(error).toBeNull();

    const rows = await candidates();
    expect(rows.map((r) => r.thread_id)).not.toContain(threadId);
  });

  it('drops the closed thread once the reply is read — the pointer decides, not the status', async () => {
    const { error } = await supabase.from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_agent_id: 'echo',
      content: 'a second reply after the close',
      message_type: 'message',
      created_at: '2026-09-04T00:00:00Z',
    });
    expect(error).toBeNull();
    expect((await candidates()).map((r) => r.thread_id)).toContain(threadId);

    await supabase
      .from('inbox_thread_read_status')
      .upsert(
        { thread_id: threadId, agent_id: AGENT, last_read_at: '2026-09-04T00:00:00Z' },
        { onConflict: 'thread_id,agent_id' }
      );
    expect((await candidates()).map((r) => r.thread_id)).not.toContain(threadId);
  });
});
