/**
 * Integration tests for legacy `agent_inbox` read state.
 *
 * These run against the real DB on purpose. The bug they cover is invisible to
 * a mocked client by construction: every defect here was a mismatch between the
 * PREDICATE one query applied and the predicate another one applied, and a mock
 * that returns a fixed row set answers both identically. The original code
 * passes a mocked "returns 5 rows, reports unreadCount" test perfectly.
 *
 * Reported by Myra 2026-08-17: `get_inbox` returned `unreadCount: 0` beside
 * `count: 5` with every row reading `status: "unread"`. A task_request sat
 * unseen for 11 days because her heartbeat trusts the counter.
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleGetInbox, handleMarkInboxRead, handleGetAgentStatus } from './inbox-handlers';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

const AGENT = 'echo';

describe('agent_inbox read state (integration)', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;

  /** Message ids created by the current test, torn down in afterEach. */
  let created: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    if (created.length) {
      await supabase.from('agent_inbox').delete().in('id', created);
      created = [];
    }
    await supabase
      .from('agent_inbox_read_status')
      .delete()
      .eq('user_id', userId)
      .eq('agent_id', AGENT);
  });

  afterAll(async () => {
    await supabase
      .from('agent_inbox')
      .delete()
      .eq('recipient_user_id', userId)
      .eq('recipient_agent_id', AGENT);
    await supabase
      .from('agent_inbox_read_status')
      .delete()
      .eq('user_id', userId)
      .eq('agent_id', AGENT);
  });

  /** Insert a message with an explicit created_at so ordering is deterministic. */
  async function insert(opts: {
    createdAt: string;
    status?: string;
    priority?: string;
    messageType?: string;
    content?: string;
    expiresAt?: string | null;
  }): Promise<string> {
    const { data, error } = await supabase
      .from('agent_inbox')
      .insert({
        recipient_user_id: userId,
        recipient_agent_id: AGENT,
        sender_agent_id: 'wren',
        content: opts.content ?? 'test message',
        message_type: opts.messageType ?? 'message',
        priority: opts.priority ?? 'normal',
        status: opts.status ?? 'unread',
        created_at: opts.createdAt,
        expires_at: opts.expiresAt ?? null,
      })
      .select('id')
      .single();
    if (error) throw new Error(`insert failed: ${error.message}`);
    created.push(data.id);
    return data.id;
  }

  async function setPointer(lastReadAt: string): Promise<void> {
    const { error } = await supabase
      .from('agent_inbox_read_status')
      .upsert(
        { user_id: userId, agent_id: AGENT, last_read_at: lastReadAt },
        { onConflict: 'user_id,agent_id' }
      );
    if (error) throw new Error(`setPointer failed: ${error.message}`);
  }

  async function getPointer(): Promise<string | null> {
    const { data } = await supabase
      .from('agent_inbox_read_status')
      .select('last_read_at')
      .eq('user_id', userId)
      .eq('agent_id', AGENT)
      .maybeSingle();
    return data?.last_read_at ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getInbox(args: Record<string, unknown> = {}): Promise<any> {
    const result = await handleGetInbox({ userId, agentId: AGENT, ...args }, dataComposer as never);
    return JSON.parse(result.content[0].text);
  }

  // ── The reported symptom ────────────────────────────────────────────

  it('reports the backlog it just handed you, not what is left after reading', async () => {
    await insert({ createdAt: '2026-06-18T19:00:00Z' });
    await insert({ createdAt: '2026-06-18T20:00:00Z' });
    await insert({ createdAt: '2026-08-06T02:46:54Z', messageType: 'task_request' });
    await setPointer('2026-06-01T00:00:00Z');

    const res = await getInbox();

    // The whole bug in one assertion: the count is taken BEFORE this call's
    // own advance. The old code advanced first, so this read 0 while handing
    // back three messages.
    expect(res.count).toBe(3);
    expect(res.unreadCount).toBe(3);
  });

  it('does not let the count go UP when a message is removed (Myra 0 → 1)', async () => {
    await insert({ createdAt: '2026-06-18T19:00:00Z' });
    await insert({ createdAt: '2026-06-18T21:06:52Z' });
    const recent = await insert({ createdAt: '2026-08-06T02:46:54Z' });
    await setPointer('2026-06-01T00:00:00Z');

    const before = await getInbox();
    // Mark the newest one handled, exactly as Myra did.
    await supabase.from('agent_inbox').update({ status: 'completed' }).eq('id', recent);
    const after = await getInbox();

    expect(before.unreadCount).toBe(3);
    // Removing a message must never increase the count. Under the old code the
    // filtered page regressed the pointer to June and the count rose 0 → 1.
    expect(after.unreadCount).toBeLessThanOrEqual(before.unreadCount);
  });

  it('never moves the pointer backwards, even when the page maximum is older', async () => {
    await insert({ createdAt: '2026-06-18T21:06:52Z' });
    await insert({ createdAt: '2026-08-06T02:46:54Z', status: 'completed' });
    await setPointer('2026-08-06T02:46:54Z');

    // status:'unread' page now contains only the June row, whose max is seven
    // weeks older than the pointer. The old unconditional upsert wrote it.
    await getInbox();

    expect(await getPointer()).toBe('2026-08-06T02:46:54+00:00');
  });

  // ── Pointer is the single source of truth for "unseen" ──────────────

  it("treats 'unread' as unseen, not as the status column's literal value", async () => {
    // Stale row: column says unread, but the agent has already read past it.
    await insert({ createdAt: '2026-06-18T19:00:00Z', status: 'unread' });
    // Newer row the agent has NOT seen, whose column says completed because
    // someone ran an explicit workflow action on it.
    await insert({ createdAt: '2026-08-16T10:00:00Z', status: 'completed' });
    await setPointer('2026-07-01T00:00:00Z');

    const res = await getInbox();

    expect(res.count).toBe(1);
    expect(res.unreadCount).toBe(1);
    expect(res.messages[0].status).toBe('completed');
  });

  it('drains on a complete read, so a second poll is quiet', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await insert({ createdAt: '2026-08-16T11:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const first = await getInbox();
    const second = await getInbox();

    expect(first.unreadCount).toBe(2);
    expect(first.readPointerAdvanced).toBe(true);
    expect(second.unreadCount).toBe(0);
    expect(second.count).toBe(0);
    expect(await getPointer()).toBe('2026-08-16T11:00:00+00:00');
  });

  // ── Advancing only over what the caller actually saw ────────────────

  it('does not advance for an observer (markRead:false)', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ markRead: false });

    expect(res.unreadCount).toBe(1);
    expect(res.readPointerAdvanced).toBe(false);
    expect(await getPointer()).toBe('2026-08-01T00:00:00+00:00');
    // And the message is still there on the next look.
    expect((await getInbox({ markRead: false })).unreadCount).toBe(1);
  });

  it('does not bury unseen mail behind a narrower filter', async () => {
    const normal = await insert({ createdAt: '2026-08-16T10:00:00Z', priority: 'normal' });
    await insert({ createdAt: '2026-08-16T11:00:00Z', priority: 'urgent' });
    await setPointer('2026-08-01T00:00:00Z');

    // Reading only the urgent mail must not mark the older normal message read
    // — the page's newest row is newer than a message the caller never saw.
    const urgentRead = await getInbox({ priority: 'urgent' });
    expect(urgentRead.readPointerAdvanced).toBe(false);

    const followUp = await getInbox();
    expect(followUp.messages.map((m: { id: string }) => m.id)).toContain(normal);
  });

  it('does not advance past a backlog that limit cut short', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await insert({ createdAt: '2026-08-16T11:00:00Z' });
    await insert({ createdAt: '2026-08-16T12:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ limit: 1 });

    expect(res.count).toBe(1);
    expect(res.unreadCount).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.readPointerAdvanced).toBe(false);
    // Re-delivery beats loss: the two older messages survive.
    expect((await getInbox()).unreadCount).toBe(3);
  });

  it('does not advance when the page was selected by workflow status', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z', status: 'unread' });
    await insert({ createdAt: '2026-08-16T11:00:00Z', status: 'completed' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ status: 'completed' });

    expect(res.readPointerAdvanced).toBe(false);
    // unreadCount describes the mailbox, not the filter the caller used.
    expect(res.unreadCount).toBe(2);
    expect(await getPointer()).toBe('2026-08-01T00:00:00+00:00');
  });

  // ── Expiry parity between the page and the counters ─────────────────

  it('excludes expired messages from the count, as the page does', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z', expiresAt: '2026-08-16T11:00:00Z' });
    await insert({ createdAt: '2026-08-16T12:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ markRead: false });
    expect(res.count).toBe(1);
    expect(res.unreadCount).toBe(1);

    const status = JSON.parse(
      (await handleGetAgentStatus({ userId, agentId: AGENT }, dataComposer as never)).content[0]
        .text
    );
    // get_agent_status is read side by side with get_inbox in mission control;
    // it counted expired mail the inbox would never show.
    expect(status.inbox.unreadCount).toBe(1);
  });

  // ── mark_inbox_read ─────────────────────────────────────────────────

  it('anchors mark_inbox_read to a real message instead of wall-clock now', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = JSON.parse(
      (await handleMarkInboxRead({ userId, agentId: AGENT }, dataComposer as never)).content[0].text
    );

    expect(res.advanced).toBe(true);
    // Exactly the newest message's timestamp — not now(), which would also
    // swallow anything inserted between the caller's decision and this write.
    expect(res.lastReadAt).toBe('2026-08-16T10:00:00+00:00');
    expect(await getPointer()).toBe('2026-08-16T10:00:00+00:00');
  });

  it('refuses to regress the pointer via mark_inbox_read(before)', async () => {
    await insert({ createdAt: '2026-06-18T19:00:00Z' });
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await setPointer('2026-08-16T10:00:00Z');

    const res = JSON.parse(
      (
        await handleMarkInboxRead(
          { userId, agentId: AGENT, before: '2026-07-01T00:00:00Z' },
          dataComposer as never
        )
      ).content[0].text
    );

    expect(res.success).toBe(true);
    expect(await getPointer()).toBe('2026-08-16T10:00:00+00:00');
  });

  it('is a no-op, not a failure, when nothing precedes the cutoff', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });

    const res = JSON.parse(
      (
        await handleMarkInboxRead(
          { userId, agentId: AGENT, before: '2026-01-01T00:00:00Z' },
          dataComposer as never
        )
      ).content[0].text
    );

    expect(res.success).toBe(true);
    expect(res.advanced).toBe(false);
    expect(await getPointer()).toBeNull();
  });
});
