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
import { createHeartbeatNotificationStore } from './heartbeat-notification-store';
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

  // Each case starts from no notices. In afterEach, not at the end of a test,
  // so a failing assertion cannot leave its rows for the next case to find.
  afterEach(async () => {
    await client
      .from('heartbeat_notifications')
      .delete()
      .in('reminder_id', [reminderId, otherReminderId]);
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
});
