/**
 * `get_inbox` never ends an unread page partway through a timestamp (#702).
 *
 * `ink wait --follow` pages the legacy inbox with `status: 'unread'`,
 * `markRead: false` and `since` set to the newest `createdAt` it has read,
 * passed back verbatim. `since` is a strict `created_at >`, so a page that
 * stops inside a group of rows sharing one timestamp leaves the rest of the
 * group behind the next `since` for good. Tie completion used to be skipped
 * whenever `since` was set, and a single sibling select stops at PostgREST's
 * max_rows without saying so.
 *
 * Real DB on purpose: the defect is in what PostgREST returns for a range and
 * a row cap, which a mocked client answers however the test tells it to.
 *
 * Run via: yarn test:integration:db:local
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleGetInbox } from './inbox-handlers';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

// Unique per run, so cleanup by recipient touches only this suite's rows.
const AGENT = `echo-tie-${Math.random().toString(36).slice(2, 8)}`;

const SINCE = '2026-06-18T18:59:59.999999+00:00';
const TIE_AT = '2026-06-18T19:00:01.234567+00:00';

describe('get_inbox tie completion under since (integration)', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    // By recipient, not by id: an `in` filter over 1200 ids does not fit in a URL.
    await supabase
      .from('agent_inbox')
      .delete()
      .eq('recipient_user_id', userId)
      .eq('recipient_agent_id', AGENT);
  });

  function row(id: string, content: string, createdAt: string): Record<string, unknown> {
    return {
      id,
      recipient_user_id: userId,
      recipient_agent_id: AGENT,
      sender_agent_id: 'wren',
      content,
      message_type: 'message',
      priority: 'normal',
      status: 'unread',
      created_at: createdAt,
      expires_at: null,
    };
  }

  async function insert(rows: Record<string, unknown>[]): Promise<void> {
    const { error } = await supabase.from('agent_inbox').insert(rows);
    if (error) throw new Error(`insert failed: ${error.message}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getInbox(args: Record<string, unknown>): Promise<any> {
    const result = await handleGetInbox(
      { userId, sbSlug: AGENT, status: 'unread', markRead: false, limit: 200, ...args },
      dataComposer as never
    );
    return JSON.parse(result.content[0].text);
  }

  for (const n of [200, 1200]) {
    it(`completes a ${n}-row tie group on a since page, then pages past it exclusively to a later reply`, async () => {
      const earlier = crypto.randomUUID();
      const reply = crypto.randomUUID();
      const tied = Array.from({ length: n }, () => crypto.randomUUID());
      await insert([row(earlier, 'before', '2026-06-18T19:00:00.000001+00:00')]);
      await insert(tied.map((id, i) => row(id, `tied ${i}`, TIE_AT)));
      await insert([row(reply, 'reply', '2026-06-18T19:00:02.000001+00:00')]);

      // Premise: the whole group really does share one timestamp.
      const { count, error } = await supabase
        .from('agent_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_agent_id', AGENT)
        .eq('created_at', TIE_AT);
      expect(error).toBeNull();
      expect(count).toBe(n);
      if (n > 1000) {
        // Premise: one select cannot return the group, so this case measures
        // the paged completion rather than a single sibling read.
        const { data: oneSelect } = await supabase
          .from('agent_inbox')
          .select('id')
          .eq('recipient_agent_id', AGENT)
          .eq('created_at', TIE_AT);
        expect(oneSelect.length).toBeLessThan(n);
      }

      // The follow read, with a since floor below every row. The earlier row
      // and 199 of the group fill the 200-row page; the rest must come too.
      const first = await getInbox({ since: SINCE });
      const ids: string[] = first.messages.map((m: { id: string }) => m.id);
      // Display order is newest-first: the group (id descending), then the earlier row.
      expect(ids).toEqual([...[...tied].sort().reverse(), earlier]);
      expect(ids).not.toContain(reply);

      // The client's floor: the newest createdAt, which is the first row, verbatim.
      const floor = first.messages[0].createdAt;
      const second = await getInbox({ since: floor });
      expect(second.messages.map((m: { id: string }) => m.id)).toEqual([reply]);
    });
  }
});
