/**
 * Held notices and the drain's reads — Integration Tests (real DB), task 2301cb3c.
 *
 * The drain's unit tests run against an in-memory store that implements the
 * same rules. These check the rules where they actually live, in the queries:
 * the hold touches only its own columns, backoff is filtered in SQL, an
 * all-clear never comes ahead of its outage, and ineligible rows cannot fill
 * the batch ahead of a due one.
 *
 * ISOLATED STACK ONLY. These write users, reminders and notices, so they run
 * only under the isolated integration-DB harness (yarn test:integration:db:local,
 * which is also what CI runs). That harness exports INTEGRATION_SUPABASE_WORKDIR
 * and the isolated stack's SUPABASE_URL; nothing here reads .env.local, which
 * points at the shared local database the main server uses. Without the
 * harness the suite is skipped. As a second line of defence, the fixture
 * reminders are completed and due in 2099, so no scheduler could ever run them.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { Database } from '../data/supabase/types';
import {
  createHeartbeatNotificationStore,
  type HeartbeatNotificationStore,
} from './heartbeat-notification-store';
import { createHeartbeatEscalation } from './heartbeat-escalation';
import type { DueReminder } from './heartbeat';
import type { ChannelResponse } from './sessions/types';
import { shouldRunOnIsolatedIntegrationDb } from '../test/isolated-integration-target';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
// Exactly the isolated stack the harness reserved, or not at all: a harness
// marker beside any other SUPABASE_URL fails this file at load.
const available = shouldRunOnIsolatedIntegrationDb();

const d = available ? describe : describe.skip;

d('held notices — real schema', () => {
  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const store = createHeartbeatNotificationStore(client);

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const reminderId = randomUUID();
  const otherReminderId = randomUUID();
  const payload = { channel: 'telegram', target: 'chat-1', content: 'held content' };

  const rowFor = async (kind: 'outage' | 'recovery', episodeKey: string, rid = reminderId) => {
    const { data } = await client
      .from('heartbeat_notifications')
      .select('*')
      .eq('reminder_id', rid)
      .eq('kind', kind)
      .eq('episode_key', episodeKey)
      .single();
    return data!;
  };

  /** A drain-owned pending notice, inserted directly so its timing can be set. */
  const insertHeld = async (opts: {
    kind: 'outage' | 'recovery';
    episodeKey: string;
    nextAttemptAt?: string | null;
    status?: 'pending' | 'delivered';
    rid?: string;
    uid?: string;
  }) => {
    const { error } = await client.from('heartbeat_notifications').insert({
      reminder_id: opts.rid ?? reminderId,
      user_id: opts.uid ?? userId,
      kind: opts.kind,
      episode_key: opts.episodeKey,
      status: opts.status ?? 'pending',
      next_attempt_at: opts.nextAttemptAt ?? null,
      drain_owned: true,
      hold_reason: 'quiet-hours',
      payload,
    } as never);
    expect(error).toBeNull();
  };

  beforeAll(async () => {
    for (const [uid, rid] of [
      [userId, reminderId],
      [otherUserId, otherReminderId],
    ]) {
      // A failed fixture insert stops the suite here, rather than letting
      // every case run against rows that are not there (PR #723 review).
      const { error: userError } = await client
        .from('users')
        .insert({ id: uid, email: `held-notices-${rid}@example.test` } as never);
      if (userError) throw new Error(`fixture user insert failed: ${userError.message}`);
      const { error: reminderError } = await client.from('scheduled_reminders').insert({
        id: rid,
        user_id: uid,
        title: 'held notices integration fixture',
        delivery_channel: 'telegram',
        delivery_target: 'chat-1',
        // Never runnable: the notices only need the row for their foreign key.
        next_run_at: '2099-01-01T00:00:00Z',
        status: 'completed',
      } as never);
      if (reminderError) {
        throw new Error(`fixture reminder insert failed: ${reminderError.message}`);
      }
    }
  });

  /** Many held rows at once, in one INSERT, in the order given. */
  const insertMany = async (
    rows: Array<{
      kind: 'outage' | 'recovery';
      episodeKey: string;
      nextAttemptAt?: string | null;
      rid?: string;
      uid?: string;
    }>
  ) => {
    const { error } = await client.from('heartbeat_notifications').insert(
      rows.map((r) => ({
        reminder_id: r.rid ?? reminderId,
        user_id: r.uid ?? userId,
        kind: r.kind,
        episode_key: r.episodeKey,
        status: 'pending',
        next_attempt_at: r.nextAttemptAt ?? null,
        drain_owned: true,
        hold_reason: 'quiet-hours',
        payload,
      })) as never
    );
    expect(error).toBeNull();
  };

  /**
   * Users for notices beyond the two fixture users. A notice's user_id is a
   * key to users (ink://specs/account-deletion), so each one is a real,
   * synthetic users row, removed after its case.
   */
  const seededUsers: string[] = [];
  const ensureUsers = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 1_000) {
      const chunk = ids.slice(i, i + 1_000);
      const { error } = await client
        .from('users')
        .insert(chunk.map((id) => ({ id, email: `held-notices-${id}@example.test` })) as never);
      expect(error).toBeNull();
      seededUsers.push(...chunk);
    }
  };

  // Each case starts from no notices. In afterEach, not at the end of a test,
  // so a failing assertion cannot leave its rows for the next case to find.
  afterEach(async () => {
    await client
      .from('heartbeat_notifications')
      .delete()
      .in('reminder_id', [reminderId, otherReminderId]);
    await client.from('reminder_history').delete().in('reminder_id', [reminderId, otherReminderId]);
    while (seededUsers.length > 0) {
      const chunk = seededUsers.splice(0, 500);
      await client.from('users').delete().in('id', chunk);
    }
  });

  afterAll(async () => {
    // ON DELETE CASCADE takes the notification rows with them.
    for (const [uid, rid] of [
      [userId, reminderId],
      [otherUserId, otherReminderId],
    ]) {
      await client.from('scheduled_reminders').delete().eq('id', rid);
      await client.from('users').delete().eq('id', uid);
    }
  });

  it('a hold writes only its own columns: no attempt, no backoff, no status change', async () => {
    const episodeKey = randomUUID();
    const key = { reminderId, userId, kind: 'outage' as const, episodeKey, destination: null };
    await store.claimNotice(key);

    const persisted = await store.holdNotice(key, {
      heldUntil: '2026-09-02T15:00:00.000Z',
      payload,
    });

    expect(persisted).toBe(true);
    const row = await rowFor('outage', episodeKey);
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      hold_reason: 'quiet-hours',
      drain_owned: true,
      payload,
    });
    expect(Date.parse(row.held_until!)).toBe(Date.parse('2026-09-02T15:00:00.000Z'));
    expect(await store.listDrainUsers()).toContain(userId);
  });

  it('a settle keeps the row drain-owned, and its backoff takes it out of the candidates', async () => {
    const episodeKey = randomUUID();
    await insertHeld({ kind: 'outage', episodeKey });
    const key = { reminderId, userId, kind: 'outage' as const, episodeKey, destination: null };

    // Attempt 1 fails; its retry is immediate (backoff 0) so it stays eligible.
    await store.settleNotice(key, { delivered: false, error: 'telegram blip' });
    expect(await rowFor('outage', episodeKey)).toMatchObject({ drain_owned: true, attempts: 1 });
    // Attempt 2 fails; now it is backed off.
    await store.settleNotice(key, { delivered: false, error: 'telegram blip' });
    const ids = (await store.listDrainCandidates([userId], 20))!.map((c) => c.key.episodeKey);
    expect(ids).not.toContain(episodeKey);
  });

  it('an all-clear is not a candidate until its outage is delivered', async () => {
    const episodeKey = randomUUID();
    await insertHeld({ kind: 'outage', episodeKey });
    await insertHeld({ kind: 'recovery', episodeKey });

    const first = (await store.listDrainCandidates([userId], 20))!.map((c) => c.key.kind);
    expect(first).toEqual(['outage']);

    await store.settleNotice(
      { reminderId, userId, kind: 'outage', episodeKey, destination: null },
      { delivered: true }
    );
    const second = (await store.listDrainCandidates([userId], 20))!.map((c) => c.key.kind);
    expect(second).toEqual(['recovery']);
  });

  it('old rows still in backoff cannot keep a newer due row out of a small batch', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    for (let i = 0; i < 3; i += 1) {
      await insertHeld({
        kind: 'outage',
        episodeKey: `old-${i}-${randomUUID()}`,
        nextAttemptAt: future,
      });
    }
    const dueKey = `due-${randomUUID()}`;
    await insertHeld({ kind: 'outage', episodeKey: dueKey });

    const batch = await store.listDrainCandidates([userId], 1);
    expect(batch!.map((c) => c.key.episodeKey)).toEqual([dueKey]);
    expect(batch![0].payload).toEqual(payload);
  });

  it('only the users the gate cleared are read', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await insertHeld({ kind: 'outage', episodeKey: mine });
    await insertHeld({
      kind: 'outage',
      episodeKey: theirs,
      rid: otherReminderId,
      uid: otherUserId,
    });

    const batch = await store.listDrainCandidates([userId], 20);
    const keys = batch!.map((c) => c.key.episodeKey);
    expect(keys).toContain(mine);
    expect(keys).not.toContain(theirs);
  });

  // ── PR #723 review ──────────────────────────────────────────────────────

  it('a claim that carries its send is drain-owned from that one write', async () => {
    const episodeKey = randomUUID();
    const key = { reminderId, userId, kind: 'outage' as const, episodeKey, destination: null };

    await store.claimNotice(key, { payload });

    // No hold, no second write: the drain can already find and send it.
    expect(await rowFor('outage', episodeKey)).toMatchObject({
      status: 'pending',
      drain_owned: true,
      payload,
      hold_reason: null,
    });
    expect(await store.listDrainUsers()).toContain(userId);
    const keys = (await store.listDrainCandidates([userId], 20))!.map((c) => c.key.episodeKey);
    expect(keys).toContain(episodeKey);
  });

  it('outageStatus tells an outage the drain will send from one nothing can send', async () => {
    const base = { reminderId, userId, kind: 'recovery' as const, destination: null };
    const absent = randomUUID();
    const owed = randomUUID();
    const sent = randomUUID();
    const stranded = randomUUID();
    await insertHeld({ kind: 'outage', episodeKey: owed });
    await insertHeld({ kind: 'outage', episodeKey: sent, status: 'delivered' });
    // A row from before notices carried their send: pending, no payload.
    const { error } = await client.from('heartbeat_notifications').insert({
      reminder_id: reminderId,
      user_id: userId,
      kind: 'outage',
      episode_key: stranded,
      status: 'pending',
    } as never);
    expect(error).toBeNull();

    expect(await store.outageStatus({ ...base, episodeKey: absent })).toBe('absent');
    expect(await store.outageStatus({ ...base, episodeKey: owed })).toBe('pending');
    expect(await store.outageStatus({ ...base, episodeKey: sent })).toBe('delivered');
    expect(await store.outageStatus({ ...base, episodeKey: stranded })).toBe('stranded');
  });

  it('200 blocked all-clears cannot keep a newer due outage out of the batch', async () => {
    // 200 outages the drain still owes, each in backoff so none is itself a
    // candidate, and each blocking its own all-clear.
    const episodes = Array.from({ length: 200 }, () => randomUUID());
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await insertMany(
      episodes.map((e) => ({ kind: 'outage' as const, episodeKey: e, nextAttemptAt: future }))
    );
    await insertMany(episodes.map((e) => ({ kind: 'recovery' as const, episodeKey: e })));
    const dueKey = `due-${randomUUID()}`;
    await insertHeld({ kind: 'outage', episodeKey: dueKey });

    const batch = await store.listDrainCandidates([userId], 20);
    expect(batch!.map((c) => c.key.episodeKey)).toEqual([dueKey]);
  });

  it('control: with 199 blocked all-clears the due outage is found either way', async () => {
    const episodes = Array.from({ length: 199 }, () => randomUUID());
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await insertMany(
      episodes.map((e) => ({ kind: 'outage' as const, episodeKey: e, nextAttemptAt: future }))
    );
    await insertMany(episodes.map((e) => ({ kind: 'recovery' as const, episodeKey: e })));
    const dueKey = `due-${randomUUID()}`;
    await insertHeld({ kind: 'outage', episodeKey: dueKey });

    const batch = await store.listDrainCandidates([userId], 20);
    expect(batch!.map((c) => c.key.episodeKey)).toEqual([dueKey]);
  });

  it('200 rows for one user cannot hide another user from the drain', async () => {
    await insertMany(
      Array.from({ length: 200 }, () => ({ kind: 'outage' as const, episodeKey: randomUUID() }))
    );
    await insertHeld({
      kind: 'outage',
      episodeKey: randomUUID(),
      rid: otherReminderId,
      uid: otherUserId,
    });

    const users = await store.listDrainUsers();
    expect(users).toContain(userId);
    expect(users).toContain(otherUserId);
  });

  // ── PR #723 re-review: every chunk of users, every page of users ─────────

  /**
   * The candidate read takes users 100 at a time. 100 users fill the first
   * chunk with 20 newer notices; the 101st user's notice is older than all of
   * them. The notices sit on the fixture reminder; the users holding a notice
   * are real rows (ensureUsers), and the rest of the chunk is ids only.
   */
  const crossChunkFixture = async () => {
    const firstChunk = Array.from({ length: 100 }, () => randomUUID());
    const lateUser = randomUUID();
    const oldest = `oldest-${randomUUID()}`;
    await ensureUsers([lateUser, ...firstChunk.slice(0, 20)]);
    // Its own INSERT, before the others, so its created_at is the earliest.
    await insertHeld({ kind: 'outage', episodeKey: oldest, uid: lateUser });
    await insertMany(
      firstChunk
        .slice(0, 20)
        .map((uid) => ({ kind: 'outage' as const, episodeKey: `newer-${randomUUID()}`, uid }))
    );
    return { firstChunk, lateUser, oldest };
  };

  it('an older notice for a user past the first 100 is not starved by newer ones', async () => {
    const { firstChunk, lateUser, oldest } = await crossChunkFixture();

    const batch = await store.listDrainCandidates([...firstChunk, lateUser], 20);

    expect(batch).toHaveLength(20);
    expect(batch![0].key.episodeKey).toBe(oldest);
  });

  it('control: the same older notice is first when its user is in the first chunk', async () => {
    const { firstChunk, lateUser, oldest } = await crossChunkFixture();

    const batch = await store.listDrainCandidates([lateUser, ...firstChunk], 20);

    expect(batch).toHaveLength(20);
    expect(batch![0].key.episodeKey).toBe(oldest);
  });

  it('lists every user, past any fixed number of pages', async () => {
    // 10,001 users: one more than fifty pages of two hundred.
    const users = Array.from({ length: 10_001 }, () => randomUUID());
    await ensureUsers(users);
    for (let i = 0; i < users.length; i += 1_000) {
      await insertMany(
        users
          .slice(i, i + 1_000)
          .map((uid) => ({ kind: 'outage' as const, episodeKey: randomUUID(), uid }))
      );
    }

    const listed = new Set(await store.listDrainUsers());

    expect(users.filter((u) => !listed.has(u))).toEqual([]);
  }, 120_000);

  // ── PR #723 re-review: an all-clear owed for an ended episode ───────────

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  /** A beat as the heartbeat records it, at a chosen time. */
  const beat = async (status: 'delivered' | 'failed', at: string, rid = reminderId) => {
    const { error } = await client
      .from('reminder_history')
      .insert({ reminder_id: rid, status, triggered_at: at } as never);
    expect(error).toBeNull();
  };

  /** An outage notice with a chosen creation time and state. */
  const outage = async (opts: {
    episodeKey: string;
    at: string;
    status?: 'pending' | 'delivered';
    drainOwned?: boolean;
    closed?: boolean;
    rid?: string;
  }) => {
    const { error } = await client.from('heartbeat_notifications').insert({
      reminder_id: opts.rid ?? reminderId,
      user_id: userId,
      kind: 'outage',
      episode_key: opts.episodeKey,
      status: opts.status ?? 'delivered',
      drain_owned: opts.drainOwned ?? true,
      payload: opts.drainOwned === false ? null : payload,
      failed_beats: 1,
      created_at: opts.at,
      episode_closed_at: opts.closed ? opts.at : null,
    } as never);
    expect(error).toBeNull();
  };

  const owedFor = async (rids: string[]) =>
    ((await store.listOwedRecoveries()) ?? []).filter((o) => rids.includes(o.reminder.id));

  it('an ended episode whose all-clear has no row is owed, with its failed beats counted', async () => {
    const owed = randomUUID();
    await beat('failed', minutesAgo(70)); // an earlier run, before the last healthy beat
    await beat('delivered', minutesAgo(60));
    await beat('failed', minutesAgo(50));
    await outage({ episodeKey: owed, at: minutesAgo(49) });
    await beat('failed', minutesAgo(40));
    await beat('failed', minutesAgo(30));
    await beat('delivered', minutesAgo(20)); // the episode ends
    await beat('failed', minutesAgo(10)); // a later run

    const rows = await owedFor([reminderId]);

    expect(rows.map((o) => [o.episodeKey, o.failedBeats])).toEqual([[owed, 3]]);
    expect(rows[0].reminder).toMatchObject({
      id: reminderId,
      title: 'held notices integration fixture',
      delivery_channel: 'telegram',
      delivery_target: 'chat-1',
    });
  });

  it('control: nothing is owed for an episode that has not ended, or that something else holds', async () => {
    await beat('failed', minutesAgo(50));
    await beat('failed', minutesAgo(50), otherReminderId);
    // Ended by the delivered beat below, but each excluded by its own state.
    const withRecoveryRow = randomUUID(); // the drain can send it
    const deliveredRecovery = randomUUID();
    const closed = randomUUID();
    const legacy = randomUUID();
    const stillOwed = randomUUID();
    await outage({ episodeKey: withRecoveryRow, at: minutesAgo(49) });
    await insertHeld({ kind: 'recovery', episodeKey: withRecoveryRow });
    await outage({ episodeKey: deliveredRecovery, at: minutesAgo(49) });
    // Delivered with nothing replayable, as a sibling-covered all-clear is.
    const { error: deliveredError } = await client.from('heartbeat_notifications').insert({
      reminder_id: reminderId,
      user_id: userId,
      kind: 'recovery',
      episode_key: deliveredRecovery,
      status: 'delivered',
    } as never);
    expect(deliveredError).toBeNull();
    await outage({ episodeKey: closed, at: minutesAgo(49), closed: true });
    await outage({ episodeKey: legacy, at: minutesAgo(49), drainOwned: false });
    await outage({ episodeKey: stillOwed, at: minutesAgo(49), status: 'pending' });
    await beat('delivered', minutesAgo(20));
    // Not ended: the other reminder has failed and never delivered since.
    await outage({ episodeKey: randomUUID(), at: minutesAgo(49), rid: otherReminderId });

    expect(await owedFor([reminderId, otherReminderId])).toEqual([]);
  });

  it('an empty recovery row holds nothing, so its episode is still owed', async () => {
    const episodeKey = randomUUID();
    await beat('failed', minutesAgo(50));
    await outage({ episodeKey, at: minutesAgo(49) });
    // What a settle recreates after a failed claim: pending, no payload, not
    // drain-owned, one attempt recorded.
    const { error } = await client.from('heartbeat_notifications').insert({
      reminder_id: reminderId,
      user_id: userId,
      kind: 'recovery',
      episode_key: episodeKey,
      status: 'pending',
      attempts: 1,
    } as never);
    expect(error).toBeNull();
    await beat('delivered', minutesAgo(20));

    expect((await owedFor([reminderId])).map((o) => o.episodeKey)).toEqual([episodeKey]);
  });

  it('every owed all-clear is listed, past a single page of the view', async () => {
    // 101 episodes ended by one delivered beat: one more than a page.
    const episodes = Array.from({ length: 101 }, () => randomUUID());
    await beat('failed', minutesAgo(50));
    const { error } = await client.from('heartbeat_notifications').insert(
      episodes.map((e) => ({
        reminder_id: reminderId,
        user_id: userId,
        kind: 'outage',
        episode_key: e,
        status: 'delivered',
        drain_owned: true,
        payload,
        failed_beats: 1,
        created_at: minutesAgo(49),
      })) as never
    );
    expect(error).toBeNull();
    await beat('delivered', minutesAgo(20));

    const listed = new Set((await owedFor([reminderId])).map((o) => o.episodeKey));

    expect(episodes.filter((e) => !listed.has(e))).toEqual([]);
  });

  // ── The drain end to end on the real store ───────────────────────────────

  /**
   * Scoped to this file's fixture user and reminder: other DB files run in
   * parallel, and these drains must not send or settle their notices.
   */
  const scoped = (s: HeartbeatNotificationStore): HeartbeatNotificationStore => ({
    ...s,
    listDrainUsers: async () => (await s.listDrainUsers())?.filter((u) => u === userId) ?? null,
    listOwedRecoveries: async () =>
      (await s.listOwedRecoveries())?.filter((o) => o.reminder.id === reminderId) ?? null,
  });

  const escalationWith = (
    s: HeartbeatNotificationStore,
    sendToChannel: (r: ChannelResponse) => Promise<unknown>
  ) =>
    createHeartbeatEscalation({
      client,
      sendToChannel,
      defaultSlug: 'myra',
      store: scoped(s),
      quietGate: async () => ({ kind: 'clear' }),
    });

  /** The real store, with only the next all-clear claim failing to record. */
  const recoveryClaimFailsOnce = () => {
    const state = { faulted: false };
    const faulty: HeartbeatNotificationStore = {
      ...store,
      claimNotice: async (key, opts) => {
        if (key.kind === 'recovery' && !state.faulted) {
          state.faulted = true;
          return { shouldSend: true, record: null };
        }
        return store.claimNotice(key, opts);
      },
    };
    return { faulty, state };
  };

  /**
   * Lumen's scenario. A final run succeeds while its outage notice is still
   * held, and only the all-clear's own claim fails. After a restart no
   * reminder is ever due again; the drain alone must send the outage, then
   * the all-clear, and close the episode.
   */
  it('a final run whose all-clear waited unrecorded gets it from the drain alone', async () => {
    const episodeKey = randomUUID();
    const { data: fixture, error: fixtureError } = await client
      .from('scheduled_reminders')
      .select('*')
      .eq('id', reminderId)
      .single();
    expect(fixtureError).toBeNull();
    const reminder = fixture as unknown as DueReminder;
    const sent: ChannelResponse[] = [];
    const record = async (r: ChannelResponse) => {
      sent.push(r);
    };

    // Overnight: a failed beat, its outage notice held.
    await beat('failed', minutesAgo(31));
    await outage({ episodeKey, at: minutesAgo(30), status: 'pending' });
    // The final run succeeds, recorded before the recovery hook runs.
    await beat('delivered', minutesAgo(5));

    // Only the all-clear's claim fails. It waits behind the held outage.
    const { faulty, state } = recoveryClaimFailsOnce();
    const before = escalationWith(faulty, record);
    expect(
      await before.onRecovery(reminder, 1, {
        destinationAlreadyAlerted: false,
        episodeKey,
        destination: null,
      })
    ).toEqual({ alerted: false });
    expect(state.faulted).toBe(true);
    expect(sent).toEqual([]);

    // Restart: a fresh escalation over the healthy store, and only the drain.
    const after = escalationWith(createHeartbeatNotificationStore(client), record);
    await after.drainHeldNotices();

    expect(sent.map((s) => s.content.split('\n')[0])).toEqual([
      'held content',
      expect.stringContaining('Heartbeat recovered'),
    ]);
    expect(await rowFor('recovery', episodeKey)).toMatchObject({ status: 'delivered' });
    expect((await rowFor('outage', episodeKey)).episode_closed_at).not.toBeNull();

    // Nothing more is owed.
    await after.drainHeldNotices();
    expect(sent).toHaveLength(2);
  });

  /**
   * Lumen's re-review at 2d02049e. The outage has landed and the final run
   * has succeeded. The drain rebuilds the all-clear, but its claim fails and
   * then its send fails; the settle recreates the recovery row empty. After a
   * restart, with no reminder ever due again, the drain must still send it.
   */
  it('a rebuilt all-clear whose claim and send both failed is sent after a restart', async () => {
    const episodeKey = randomUUID();
    await beat('failed', minutesAgo(31));
    await outage({ episodeKey, at: minutesAgo(30) }); // delivered
    await beat('delivered', minutesAgo(5));

    const { faulty, state } = recoveryClaimFailsOnce();
    const failing = escalationWith(faulty, async () => {
      throw new Error('telegram unreachable');
    });
    await failing.drainHeldNotices();
    expect(state.faulted).toBe(true);
    expect(await rowFor('recovery', episodeKey)).toMatchObject({
      status: 'pending',
      attempts: 1,
      payload: null,
      drain_owned: false,
    });

    // Restart: a healthy store and channel, and only the drain.
    const sent: ChannelResponse[] = [];
    const after = escalationWith(createHeartbeatNotificationStore(client), async (r) => {
      sent.push(r);
    });
    await after.drainHeldNotices();

    expect(sent.map((s) => s.content.split('\n')[0])).toEqual([
      expect.stringContaining('Heartbeat recovered'),
    ]);
    expect(await rowFor('recovery', episodeKey)).toMatchObject({ status: 'delivered' });
    expect((await rowFor('outage', episodeKey)).episode_closed_at).not.toBeNull();

    // Nothing more is owed.
    await after.drainHeldNotices();
    expect(sent).toHaveLength(1);
  });
});
