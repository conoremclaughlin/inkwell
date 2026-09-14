/**
 * reopen_thread against the real database (spec inkmail-thread-scope §2).
 *
 * The flip and its audit event are ONE transaction — `reopen_inbox_thread`
 * (migration 20260913083000). Three properties only the database can show:
 * the guarded UPDATE matches zero rows the second time and records nothing;
 * a rejected audit event rolls the flip back too, so the thread stays closed
 * and a retry does the whole thing; and exactly one event exists afterwards.
 * (Lumen, #615 review: as two round trips, a failed audit left the row open
 * with no event, and the retry skipped it for good.)
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { reopenThreadRow } from './thread-handlers';

const DB_URL = process.env.INTEGRATION_DB_URL;

describe('reopenThreadRow (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  const threadIds: string[] = [];

  async function closedThread(): Promise<string> {
    const { data: thread, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: `test:reopen-${Date.now()}-${threadIds.length}`,
        user_id: userId,
        created_by_agent_id: 'echo',
        title: 'reopen fixture',
        status: 'closed',
        closed_at: '2026-09-01T00:00:00Z',
        closed_by_agent_id: 'echo',
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create thread: ${error.message}`);
    threadIds.push(thread.id as string);
    return thread.id as string;
  }

  async function threadState(threadId: string) {
    const { data } = await supabase
      .from('inbox_threads')
      .select('status, closed_at, closed_by_agent_id')
      .eq('id', threadId)
      .single();
    return data;
  }

  async function events(threadId: string) {
    const { data } = await supabase
      .from('inbox_thread_messages')
      .select('sender_agent_id, message_type, metadata')
      .eq('thread_id', threadId);
    return data as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterAll(async () => {
    for (const id of threadIds) {
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', id);
      await supabase.from('inbox_threads').delete().eq('id', id);
    }
  });

  it('reopens once: status open, both closure fields null, one audit event', async () => {
    const threadId = await closedThread();
    expect(await reopenThreadRow(supabase, threadId, { kind: 'sb', agentId: 'echo' })).toEqual({
      reopened: true,
    });
    expect(await threadState(threadId)).toEqual({
      status: 'open',
      closed_at: null,
      closed_by_agent_id: null,
    });
    const rows = await events(threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sender_agent_id: 'system',
      message_type: 'system',
      metadata: { type: 'thread_reopened', reopenedBy: 'echo' },
    });

    // The guard: a second reopen matches no row and records nothing.
    expect(await reopenThreadRow(supabase, threadId, { kind: 'user' })).toEqual({
      reopened: false,
    });
    expect(await events(threadId)).toHaveLength(1);
  });

  it.skipIf(!DB_URL)(
    'a rejected audit event rolls the flip back: the thread stays closed and a retry does the whole thing',
    async () => {
      const threadId = await closedThread();
      const { Client } = await import('pg');
      const pg = new Client({ connectionString: DB_URL });
      await pg.connect();
      const rejectAudit = `reject_reopen_audit_${threadId.replace(/-/g, '')}`;
      try {
        // A trigger that refuses THIS thread's reopen event — the audit INSERT
        // fails after the UPDATE inside the same function call.
        await pg.query(`
          CREATE FUNCTION public.${rejectAudit}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.thread_id = '${threadId}' AND NEW.metadata ->> 'type' = 'thread_reopened' THEN
              RAISE EXCEPTION 'audit rejected by test';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER ${rejectAudit} BEFORE INSERT ON public.inbox_thread_messages
            FOR EACH ROW EXECUTE FUNCTION public.${rejectAudit}();
        `);

        await expect(
          reopenThreadRow(supabase, threadId, { kind: 'sb', agentId: 'echo' })
        ).rejects.toThrow('audit rejected by test');

        // Nothing changed: not the row, not the events.
        expect(await threadState(threadId)).toEqual({
          status: 'closed',
          closed_at: '2026-09-01T00:00:00+00:00',
          closed_by_agent_id: 'echo',
        });
        expect(await events(threadId)).toHaveLength(0);

        await pg.query(`DROP TRIGGER ${rejectAudit} ON public.inbox_thread_messages;`);

        // The retry is the whole thing, once.
        expect(await reopenThreadRow(supabase, threadId, { kind: 'sb', agentId: 'echo' })).toEqual({
          reopened: true,
        });
        expect(await threadState(threadId)).toMatchObject({ status: 'open', closed_at: null });
        expect(await events(threadId)).toHaveLength(1);
      } finally {
        await pg.query(`DROP TRIGGER IF EXISTS ${rejectAudit} ON public.inbox_thread_messages;`);
        await pg.query(`DROP FUNCTION IF EXISTS public.${rejectAudit}();`);
        await pg.end();
      }
    }
  );
});
