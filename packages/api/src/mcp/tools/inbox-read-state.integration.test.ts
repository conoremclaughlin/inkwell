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
import {
  handleGetInbox,
  handleMarkInboxRead,
  handleGetAgentStatus,
  handleGetAgentSummaries,
} from './inbox-handlers';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';

// Uniquely namespaced per run: this suite's rows and pointer can NEVER
// collide with another suite's use of the shared Echo fixture (the previous
// shared slug made cross-suite sweeps possible at all — Lumen #504 r1 P2).
const AGENT = `echo-readstate-${Math.random().toString(36).slice(2, 8)}`;

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
    // Cleanup is suite-owned ONLY: afterEach already deletes exactly the rows
    // this suite created (tracked ids) plus its own pointer row. A broad
    // recipient-wide sweep here deleted OTHER suites' rows for the shared
    // Echo fixture mid-run (agent-gateway resolves the user through its own
    // agent_inbox row) — a direct source of flaky DB CI (Lumen #504 r1 P2).
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
    // The response reports the RESULTING pointer from the RPC (r2 P2).
    expect(first.readPointerAt).toBe('2026-08-16T11:00:00+00:00');
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

  it('drains a limit-cut backlog batch by batch — progress without loss', async () => {
    /*
     * Lumen #504 r1 P1: the old guard refused to advance on truncation, but
     * the page held the NEWEST rows with no cursor to the rest — the same
     * page returned forever, and a backlog above the cap could never drain.
     * The consuming path now selects the OLDEST unseen batch and advances
     * through its maximum, so each call makes progress and nothing is
     * skipped.
     */
    const a = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    const b = await insert({ createdAt: '2026-08-16T11:00:00Z' });
    const c = await insert({ createdAt: '2026-08-16T12:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const first = await getInbox({ limit: 1 });
    expect(first.unreadCount).toBe(3);
    expect(first.truncated).toBe(true);
    // The OLDEST unseen message, not the newest — and the pointer advanced
    // through it, because the batch is contiguous with the floor.
    expect(first.messages.map((m: { id: string }) => m.id)).toEqual([a]);
    expect(first.readPointerAdvanced).toBe(true);

    const second = await getInbox({ limit: 1 });
    expect(second.messages.map((m: { id: string }) => m.id)).toEqual([b]);

    const third = await getInbox({ limit: 1 });
    expect(third.messages.map((m: { id: string }) => m.id)).toEqual([c]);

    // Fully drained — nothing lost, nothing repeated.
    expect((await getInbox()).unreadCount).toBe(0);
  });

  it('a multi-row batch is returned newest-first but advances through the batch max', async () => {
    const a = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    const b = await insert({ createdAt: '2026-08-16T11:00:00Z' });
    await insert({ createdAt: '2026-08-16T12:00:00Z' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ limit: 2 });
    // Oldest BATCH (a, b), displayed newest-first (b, a).
    expect(res.messages.map((m: { id: string }) => m.id)).toEqual([b, a]);
    expect(await getPointer()).toBe('2026-08-16T11:00:00+00:00');
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
    // The RESPONSE reports the monotonic RESULT, not the requested anchor
    // (Lumen #504 r1 P2): the DB kept Aug 16, so the response must too.
    expect(res.lastReadAt).toBe('2026-08-16T10:00:00+00:00');
    expect(res.advanced).toBe(false);
    expect(await getPointer()).toBe('2026-08-16T10:00:00+00:00');
  });

  it('acks an exact message id (throughMessageId) — the legacy delivery ack', async () => {
    const older = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await insert({ createdAt: '2026-08-16T11:00:00Z' });

    const res = JSON.parse(
      (
        await handleMarkInboxRead(
          { userId, agentId: AGENT, throughMessageId: older },
          dataComposer as never
        )
      ).content[0].text
    );

    expect(res.success).toBe(true);
    expect(res.advanced).toBe(true);
    // Advanced through EXACTLY the acked message — the newer row stays unseen.
    expect(res.lastReadAt).toBe('2026-08-16T10:00:00+00:00');
    expect(await getPointer()).toBe('2026-08-16T10:00:00+00:00');
    expect((await getInbox({ markRead: false })).unreadCount).toBe(1);
  });

  it("throughMessageId for another agent's message is a no-op, not an advance", async () => {
    const { data: foreign } = await supabase
      .from('agent_inbox')
      .insert({
        recipient_user_id: userId,
        recipient_agent_id: `${AGENT}-other`,
        sender_agent_id: 'wren',
        content: 'not yours',
        message_type: 'message',
        priority: 'normal',
        status: 'unread',
        created_at: '2026-08-16T10:00:00Z',
      })
      .select('id')
      .single();
    created.push(foreign.id);

    const res = JSON.parse(
      (
        await handleMarkInboxRead(
          { userId, agentId: AGENT, throughMessageId: foreign.id },
          dataComposer as never
        )
      ).content[0].text
    );

    expect(res.success).toBe(true);
    expect(res.advanced).toBe(false);
    expect(await getPointer()).toBeNull();
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

  // ── r2 P1: timestamp ties at a limited batch boundary ───────────────

  it('a timestamp tie group is delivered and consumed WHOLE, even past the limit', async () => {
    /*
     * now() is transaction-stable, so identical created_at values are
     * normal. With limit:1 and two unseen siblings at the same instant, the
     * old code returned one and advanced the timestamp pointer past both —
     * the sibling was never delivered (Lumen #504 r2, reproduced on the
     * migrated DB). The page now extends to the whole boundary tie group.
     */
    const t = '2026-08-16T10:00:00Z';
    const a = await insert({ createdAt: t, content: 'twin A' });
    const b = await insert({ createdAt: t, content: 'twin B' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ limit: 1 });

    // BOTH siblings arrive despite limit:1 — the tie group is atomic.
    expect(res.messages.map((m: { id: string }) => m.id).sort()).toEqual([a, b].sort());
    expect(res.readPointerAdvanced).toBe(true);
    // Nothing left behind.
    expect((await getInbox()).unreadCount).toBe(0);
  });

  it('a tie at the boundary between batches also survives', async () => {
    const t2 = '2026-08-16T11:00:00Z';
    const first = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    const twinA = await insert({ createdAt: t2, content: 'twin A' });
    const twinB = await insert({ createdAt: t2, content: 'twin B' });
    await setPointer('2026-08-01T00:00:00Z');

    // Batch 1: limit 2 → oldest row + the first twin — page extends to the
    // twin's sibling so the boundary timestamp is complete.
    const page1 = await getInbox({ limit: 2 });
    expect(page1.messages.map((m: { id: string }) => m.id).sort()).toEqual(
      [first, twinA, twinB].sort()
    );
    expect((await getInbox()).unreadCount).toBe(0);
  });

  it('tie completion never smuggles filtered-out rows (urgent-only stays urgent-only)', async () => {
    // r3 P2, reproduced on the migrated DB: urgent-only limit:1 returned
    // both the urgent message AND a normal task request sharing its
    // timestamp. Filtered pages never advance or ack, so they get no tie
    // extension at all.
    const t = '2026-08-16T10:00:00Z';
    const urgent = await insert({ createdAt: t, priority: 'urgent' });
    await insert({ createdAt: t, priority: 'normal', messageType: 'task_request' });
    await setPointer('2026-08-01T00:00:00Z');

    const res = await getInbox({ priority: 'urgent', limit: 1 });
    expect(res.messages.map((m: { id: string }) => m.id)).toEqual([urgent]);
    expect(res.readPointerAdvanced).toBe(false);
  });

  // ── r2 P2: the RPC computes `changed` atomically ────────────────────

  it('replaying an already-covered anchor reports changed:false with the stored pointer', async () => {
    const older = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    const newer = await insert({ createdAt: '2026-08-16T11:00:00Z' });

    const advance = (id: string) =>
      supabase
        .rpc('advance_agent_inbox_read_pointer', {
          p_user_id: userId,
          p_agent_id: AGENT,
          p_through_message_id: id,
        })
        .then((r: { data: Array<{ last_read_at: string; changed: boolean }> }) => r.data[0]);

    const firstResult = await advance(newer);
    expect(firstResult.changed).toBe(true);

    const replay = await advance(older);
    expect(replay.changed).toBe(false);
    expect(replay.last_read_at).toBe('2026-08-16T11:00:00+00:00');
  });

  it('concurrent advances through the same anchor: exactly one reports changed', async () => {
    const msg = await insert({ createdAt: '2026-08-16T10:00:00Z' });

    const call = () =>
      supabase
        .rpc('advance_agent_inbox_read_pointer', {
          p_user_id: userId,
          p_agent_id: AGENT,
          p_through_message_id: msg,
        })
        .then((r: { data: Array<{ changed: boolean }> }) => r.data[0]);

    const results = await Promise.all([call(), call()]);
    const changedCount = results.filter((r) => r.changed).length;
    expect(changedCount).toBe(1);
  });

  // ── r2 P1: get_agent_summaries floor (the Mission path) ─────────────

  it('summaries: an agent with mail but NO pointer is counted, not zeroed', async () => {
    /*
     * Lumen's exact repro: agent A has a 10:00 pointer, agent B has unread
     * mail at 09:00 and no pointer row. The shared fetch floor (min over
     * existing pointers) excluded B's row before per-agent counting ran, so
     * Mission reported zero for B.
     */
    const agentB = `${AGENT}-nopointer`;
    const { data: bMail } = await supabase
      .from('agent_inbox')
      .insert({
        recipient_user_id: userId,
        recipient_agent_id: agentB,
        sender_agent_id: 'wren',
        content: 'genuinely unread for B',
        message_type: 'task_request',
        priority: 'normal',
        status: 'unread',
        created_at: '2026-08-16T09:00:00Z',
      })
      .select('id')
      .single();
    created.push(bMail.id);
    const seenByA = await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await handleMarkInboxRead(
      { userId, agentId: AGENT, throughMessageId: seenByA },
      dataComposer as never
    );

    const body = JSON.parse(
      (await handleGetAgentSummaries({ userId, agentIds: [AGENT, agentB] }, dataComposer as never))
        .content[0].text
    );
    const bRow = body.agents.find((a: { agentId: string }) => a.agentId === agentB);
    expect(bRow).toBeDefined();
    expect(bRow.inboxUnread).toBeGreaterThanOrEqual(1);
  });

  it('summaries: expired rows are excluded, matching get_inbox (r2 P2)', async () => {
    await insert({ createdAt: '2026-08-16T10:00:00Z' });
    await insert({
      createdAt: '2026-08-16T11:00:00Z',
      expiresAt: '2026-08-16T12:00:00Z', // long past
    });

    const body = JSON.parse(
      (await handleGetAgentSummaries({ userId, agentIds: [AGENT] }, dataComposer as never))
        .content[0].text
    );
    const row = body.agents.find((a: { agentId: string }) => a.agentId === AGENT);
    expect(row.inboxUnread).toBe(1);
  });

  // ── Aggregate floor (agent-less timeline) ───────────────────────────

  it('a recipient with mail but NO pointer forces a null aggregate floor', async () => {
    /*
     * Lumen #504 r1 P1: the aggregate floor was min() over EXISTING pointer
     * rows only. An agent with mail and no pointer row (Echo's July message)
     * was hidden behind the other agents' floor — an under-count to zero,
     * which is the exact bug class this PR fixes. Any such recipient must
     * force a null floor so everything counts.
     */
    const unpointeredAgent = `${AGENT}-nopointer`;
    // Future-dated so parallel suites' rows cannot push these off the page.
    const future = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

    // The unpointered agent's mail is OLDER than the pointered agent's floor.
    const { data: hidden } = await supabase
      .from('agent_inbox')
      .insert({
        recipient_user_id: userId,
        recipient_agent_id: unpointeredAgent,
        sender_agent_id: 'wren',
        content: 'genuinely unread',
        message_type: 'task_request',
        priority: 'normal',
        status: 'unread',
        created_at: future(30),
      })
      .select('id')
      .single();
    created.push(hidden.id);

    const seen = await insert({ createdAt: future(60) });
    // AGENT has read through the newer message: with min-over-existing-rows,
    // the aggregate floor would be future(60) and the older row vanishes.
    await handleMarkInboxRead(
      { userId, agentId: AGENT, throughMessageId: seen },
      dataComposer as never
    );

    const res = JSON.parse(
      (await handleGetInbox({ userId, status: 'unread', limit: 50 }, dataComposer as never))
        .content[0].text
    );
    expect(res.messages.map((m: { id: string }) => m.id)).toContain(hidden.id);
  });
});
