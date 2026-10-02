/**
 * Held notices and the drain's reads — Integration Tests (real DB), task 2301cb3c.
 *
 * The drain's unit tests run against an in-memory store that implements the
 * same rules. These check the rules where they actually live, in the queries:
 * the hold touches only its own columns, backoff is filtered in SQL, an
 * all-clear never comes ahead of its outage, and ineligible rows cannot fill
 * the batch ahead of a due one.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY, and migration
 * 20261002190637_reminder_quiet_hours_switch applied. Skipped automatically
 * when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from '../data/supabase/types';
import { createHeartbeatNotificationStore } from './heartbeat-notification-store';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);

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
      await client
        .from('users')
        .insert({ id: uid, email: `held-notices-${rid}@example.test` } as never);
      await client.from('scheduled_reminders').insert({
        id: rid,
        user_id: uid,
        title: 'held notices integration fixture',
        delivery_channel: 'telegram',
        delivery_target: 'chat-1',
        next_run_at: new Date().toISOString(),
        status: 'active',
      } as never);
    }
  });

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
});
