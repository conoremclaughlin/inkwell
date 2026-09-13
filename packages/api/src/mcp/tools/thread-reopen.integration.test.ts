/**
 * reopen_thread against the real database (spec inkmail-thread-scope §2).
 *
 * The unit tests drive a fake client. The property that matters most here —
 * that the flip is one guarded UPDATE, so a second reopen matches zero rows
 * and records nothing — is a property of the SQL PostgREST generates, and
 * only the database can show it holds.
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { reopenThreadRow } from './thread-handlers';

describe('reopenThreadRow (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let threadId: string | undefined;
  const threadKey = `test:reopen-${Date.now()}`;

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);

    const { data: thread, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: fixture.userId,
        created_by_agent_id: 'echo',
        title: 'reopen fixture',
        status: 'closed',
        closed_at: '2026-09-01T00:00:00Z',
        closed_by_agent_id: 'echo',
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create thread: ${error.message}`);
    threadId = thread.id as string;
  });

  afterAll(async () => {
    if (!threadId) return;
    await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
    await supabase.from('inbox_threads').delete().eq('id', threadId);
  });

  it('reopens once: status open, both closure fields null, one audit event', async () => {
    expect(await reopenThreadRow(supabase, threadId!, { kind: 'sb', agentId: 'echo' })).toEqual({
      reopened: true,
    });

    const { data: row } = await supabase
      .from('inbox_threads')
      .select('status, closed_at, closed_by_agent_id')
      .eq('id', threadId)
      .single();
    expect(row).toEqual({ status: 'open', closed_at: null, closed_by_agent_id: null });

    const { data: events } = await supabase
      .from('inbox_thread_messages')
      .select('sender_agent_id, message_type, metadata')
      .eq('thread_id', threadId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sender_agent_id: 'system',
      message_type: 'system',
      metadata: { type: 'thread_reopened', reopenedBy: 'echo' },
    });
  });

  it('a second reopen matches no row and records nothing', async () => {
    expect(await reopenThreadRow(supabase, threadId!, { kind: 'user' })).toEqual({
      reopened: false,
    });
    const { data: events } = await supabase
      .from('inbox_thread_messages')
      .select('id')
      .eq('thread_id', threadId);
    expect(events).toHaveLength(1);
  });
});
