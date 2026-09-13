/**
 * Notification acknowledgement store — Integration Tests (real DB)
 *
 * WHY THIS TIER.
 *
 * The unit tests for this store run against an in-memory fake, which proves the
 * suppression RULE is right and proves nothing about the queries. Every way this
 * module can be silently wrong lives in the part a fake cannot see: a column
 * that does not exist, a unique constraint that does not match the key we
 * deduplicate on, `maybeSingle()` on a query that can return more than one row.
 *
 * That is not a hypothetical class of bug on this branch. The failure streak
 * this store replaces sorted `reminder_history` by `created_at`, a column that
 * table does not have, and sixty-one unit tests passed through it because a
 * mocked `order()` accepts any string. PostgREST answered 42703, the catch
 * turned that into a streak of zero, and the whole alerting policy inverted.
 *
 * So these ask the schema, not a mock.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

d('heartbeat notification store — real schema', () => {
  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const store = createHeartbeatNotificationStore(client);

  // A real reminder row, because the table carries an FK to it. Creating one is
  // cheaper than discovering at 3am that the FK rejects our writes.
  const userId = randomUUID();
  const reminderId = randomUUID();
  const episodeKey = randomUUID();
  const baseKey = {
    reminderId,
    userId,
    episodeKey,
    destination: 'sb-test|telegram|chat-1',
  };

  beforeAll(async () => {
    await client.from('users').insert({
      id: userId,
      email: `heartbeat-store-${reminderId}@example.test`,
    } as never);
    await client.from('scheduled_reminders').insert({
      id: reminderId,
      user_id: userId,
      title: 'notification store integration fixture',
      delivery_channel: 'telegram',
      delivery_target: 'chat-1',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);
  });

  afterAll(async () => {
    // ON DELETE CASCADE takes the notification rows with it.
    await client.from('scheduled_reminders').delete().eq('id', reminderId);
    await client.from('users').delete().eq('id', userId);
  });

  it('creates a notice and reports that it should be sent', async () => {
    const { shouldSend, record } = await store.claimNotice({ ...baseKey, kind: 'outage' });

    // If any column in the insert were misnamed, PostgREST would reject it and
    // the store would degrade to `record: null` — which still says shouldSend,
    // so the record is the assertion that matters here.
    expect(record).not.toBeNull();
    expect(record?.status).toBe('pending');
    expect(shouldSend).toBe(true);
  });

  it('suppresses only after a DELIVERED settle, and reads back that way', async () => {
    const key = { ...baseKey, kind: 'outage' as const };

    await store.settleNotice(key, { delivered: true });
    const after = await store.claimNotice(key);

    expect(after.record?.status).toBe('delivered');
    expect(after.shouldSend).toBe(false);
  });

  it('keeps a failed notice retryable and counts its attempts', async () => {
    const key = { ...baseKey, kind: 'recovery' as const };

    await store.claimNotice(key);
    await store.settleNotice(key, { delivered: false, error: 'telegram unreachable' });

    const after = await store.claimNotice(key);
    expect(after.record?.attempts).toBe(1);
    expect(after.shouldSend).toBe(true);
  });

  it('reuses the same episode key while the outage stays open', async () => {
    // Finding 1 of round four, against the real table. The key used to be
    // derived from reminder_history and differed between the first beat of an
    // outage and the second — two keys, two rows, two alarms. It is now read
    // back from this table, so the second beat must get the first beat's key.
    const open = await store.openEpisode(reminderId);
    expect(open).toBe(episodeKey);
    expect(await store.openEpisode(reminderId)).toBe(open);
  });

  it('finds the owed all-clear from the outage row, not from a recovery row', async () => {
    // The sweep queries the OUTAGE row by (reminder, kind, status) with
    // `episode_closed_at IS NULL`. Every one of those has to exist on the real
    // table or a recovered outage is never announced as recovered.
    const owed = await store.findOwedRecovery(reminderId);

    expect(owed).not.toBeNull();
    expect(owed?.episodeKey).toBe(episodeKey);
  });

  it('owes the all-clear even when no recovery row was ever written', async () => {
    // Lumen's round-four P1, end to end against the real table, and the reason
    // the test above is not sufficient on its own: a pending recovery row
    // happens to exist there, so a sweep that (wrongly) queried the RECOVERY
    // row would still find something and the test would pass for the wrong
    // reason. Here the recovery INSERT never happened at all — the exact state
    // left behind when the store was failing at the moment an all-clear was
    // owed — and the debt must still be discoverable.
    const isolatedReminder = randomUUID();
    const isolatedEpisode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'owed all-clear with no recovery row',
      delivery_channel: 'telegram',
      delivery_target: 'chat-2',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const key = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: isolatedEpisode,
      destination: 'sb-test|telegram|chat-2',
      kind: 'outage' as const,
    };

    // The outage was announced and landed. Nothing else is ever written.
    await store.claimNotice(key);
    await store.settleNotice(key, { delivered: true });

    const { data: recoveryRows } = await client
      .from('heartbeat_notifications' as never)
      .select('id')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'recovery');
    expect((recoveryRows as unknown[] | null) ?? []).toHaveLength(0);

    const owed = await store.findOwedRecovery(isolatedReminder);
    expect(owed?.episodeKey).toBe(isolatedEpisode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('does not owe an all-clear for an outage that was never delivered', async () => {
    // Positive control. Only an outage the human actually heard about creates a
    // debt; otherwise every undeliverable beat would generate an all-clear for
    // an alarm that never rang.
    const isolatedReminder = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'undelivered outage owes nothing',
      delivery_channel: 'telegram',
      delivery_target: 'chat-3',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const key = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: randomUUID(),
      destination: 'sb-test|telegram|chat-3',
      kind: 'outage' as const,
    };

    await store.claimNotice(key);
    await store.settleNotice(key, { delivered: false, error: 'telegram unreachable' });

    expect(await store.findOwedRecovery(isolatedReminder)).toBeNull();

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('stops owing the all-clear once the episode is closed', async () => {
    await store.closeEpisode({ ...baseKey, kind: 'recovery' });

    expect(await store.findOwedRecovery(reminderId)).toBeNull();
    // And a closed episode is no longer the open one, so the next failure
    // mints a fresh key rather than reopening a settled outage.
    expect(await store.openEpisode(reminderId)).not.toBe(episodeKey);
  });

  it('writes a backoff gate that the real column accepts', async () => {
    // `next_attempt_at` replaced the attempt cap. If the column were misnamed
    // the UPDATE would fail, the notice would never be gated, and a dead
    // channel would be retried on every beat forever.
    const key = { ...baseKey, kind: 'recovery' as const, episodeKey: randomUUID() };

    await store.claimNotice(key);
    await store.settleNotice(key, { delivered: false, error: 'unreachable' });
    await store.settleNotice(key, { delivered: false, error: 'still unreachable' });

    const { data } = await client
      .from('heartbeat_notifications' as never)
      .select('attempts, next_attempt_at, status')
      .eq('reminder_id', reminderId)
      .eq('kind', 'recovery')
      .eq('episode_key', key.episodeKey)
      .single();

    const row = data as { attempts: number; next_attempt_at: string | null; status: string };
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('pending');
    expect(Date.parse(row.next_attempt_at!)).toBeGreaterThan(Date.now());

    // Eligibility is retained — the cap is on frequency, not on ever trying.
    const gated = await store.claimNotice(key);
    expect(gated.shouldSend).toBe(false);
    expect(gated.record?.status).toBe('pending');
  });

  it('stays eligible far past the attempt cap it used to have', async () => {
    // Round four, finding 4, against the real store rather than a fake. The old
    // rule retired a notice after three attempts; Lumen rejected it because
    // under a no-silence contract a cap turns a long channel outage into the
    // exact silence this table exists to prevent. Six failed attempts here —
    // double the old cap — and the notice must still be owed and sendable.
    const key = { ...baseKey, kind: 'recovery' as const, episodeKey: randomUUID() };

    await store.claimNotice(key);
    for (let attempt = 1; attempt <= 6; attempt++) {
      await store.settleNotice(key, { delivered: false, error: `unreachable #${attempt}` });
      // Step past the backoff this attempt just wrote, so the next one is due.
      await client
        .from('heartbeat_notifications' as never)
        .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never)
        .eq('reminder_id', reminderId)
        .eq('kind', 'recovery')
        .eq('episode_key', key.episodeKey);
    }

    const after = await store.claimNotice(key);
    expect(after.record?.attempts).toBe(6);
    expect(after.record?.status).toBe('pending');
    expect(after.shouldSend).toBe(true);
  });

  it('recreates the obligation when a settle matches no row', async () => {
    // A zero-row UPDATE is not an error in PostgREST — it resolves with an empty
    // array. Settling a notice whose row was never created used to vanish
    // silently, leaving the notice neither delivered nor owed: the shape of the
    // silence this table exists to stop.
    //
    // The assertion has to READ THE TABLE rather than call claimNotice, because
    // claimNotice creates a missing row itself and would paper over the loss —
    // a first draft of this test asserted status via claimNotice and passed with
    // the zero-row detection deleted.
    const key = { ...baseKey, kind: 'recovery' as const, episodeKey: randomUUID() };

    await store.settleNotice(key, { delivered: false, error: 'never inserted' });

    const { data } = await client
      .from('heartbeat_notifications' as never)
      .select('status, attempts, last_error')
      .eq('reminder_id', reminderId)
      .eq('kind', 'recovery')
      .eq('episode_key', key.episodeKey)
      .maybeSingle();

    const row = data as { status: string; attempts: number; last_error: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    // The attempt is on the rebuilt row: the notice is still owed AND we know
    // one try has already been spent on it.
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('never inserted');
  });

  it('records a delivered settle whose row went missing, rather than losing it', async () => {
    // The same hole in the other direction. If the row is gone and the send
    // SUCCEEDED, dropping the update means the notice is never marked
    // delivered — so it is resent on every later beat, which is the duplicate
    // storm rather than the silence, but still wrong.
    const key = { ...baseKey, kind: 'recovery' as const, episodeKey: randomUUID() };

    await store.settleNotice(key, { delivered: true });

    const { data } = await client
      .from('heartbeat_notifications' as never)
      .select('status, attempts')
      .eq('reminder_id', reminderId)
      .eq('kind', 'recovery')
      .eq('episode_key', key.episodeKey)
      .maybeSingle();

    expect((data as { status: string; attempts: number } | null)?.status).toBe('delivered');
  });

  it('does not reopen a recovered episode when only the close write failed', async () => {
    // Round five, finding 1. The close is a separate write and it can fail on
    // its own, leaving a finished episode with `episode_closed_at` still null.
    // `openEpisode` used to trust that column alone, hand the stale key to the
    // next outage, and find its outage notice already marked delivered — so the
    // next outage announced NOTHING, after the human had been explicitly told
    // the monitor was back. Delivery of the all-clear is what ends an episode.
    //
    // Its own reminder: a row left behind by an earlier test in this file would
    // decide the outcome, which is how a green here could mean nothing.
    const isolatedReminder = randomUUID();
    const recoveredEpisode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'failed close must not suppress the next outage',
      delivery_channel: 'telegram',
      delivery_target: 'chat-4',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: recoveredEpisode,
      destination: 'sb-test|telegram|chat-4',
    };

    // Outage announced and delivered; all-clear announced and delivered.
    await store.claimNotice({ ...base, kind: 'outage' });
    await store.settleNotice({ ...base, kind: 'outage' }, { delivered: true });
    await store.claimNotice({ ...base, kind: 'recovery' });
    await store.settleNotice({ ...base, kind: 'recovery' }, { delivered: true });

    // The close never lands. This is the whole scenario, so assert the state
    // really is the one under test rather than assuming it.
    const { data: stillOpen } = await client
      .from('heartbeat_notifications' as never)
      .select('episode_closed_at')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'outage')
      .eq('episode_key', recoveredEpisode)
      .single();
    expect((stillOpen as { episode_closed_at: string | null }).episode_closed_at).toBeNull();

    // The next failing beat must get a FRESH episode, or its outage is silent.
    expect(await store.openEpisode(isolatedReminder)).not.toBe(recoveredEpisode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('owes the all-clear when the outage send landed but its acknowledgement did not', async () => {
    // Round five, finding 2. A pending outage row does not prove the human was
    // never warned — it equally means the send succeeded and the UPDATE that
    // should have recorded it is what failed. The sweep used to require a
    // DELIVERED outage, so this obligation was invisible forever.
    //
    // The proof that the outage WAS announced is the recovery row: only an
    // attempted all-clear writes one, and an all-clear is only attempted for an
    // announced outage.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'lost outage acknowledgement still owes an all-clear',
      delivery_channel: 'telegram',
      delivery_target: 'chat-5',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-5',
    };

    // Outage row exists but never reaches 'delivered' — the settle was the write
    // that failed. No settleNotice call at all leaves exactly that row.
    await store.claimNotice({ ...base, kind: 'outage' });

    // The all-clear was attempted and failed, writing its pending recovery row.
    await store.claimNotice({ ...base, kind: 'recovery' });
    await store.settleNotice({ ...base, kind: 'recovery' }, { delivered: false, error: 'down' });
    // Step past the backoff that attempt just wrote, so the debt is due now.
    await client
      .from('heartbeat_notifications' as never)
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never)
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'recovery')
      .eq('episode_key', episode);

    const { data: outageRow } = await client
      .from('heartbeat_notifications' as never)
      .select('status')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'outage')
      .eq('episode_key', episode)
      .single();
    expect((outageRow as { status: string }).status).toBe('pending');

    const owed = await store.findOwedRecovery(isolatedReminder);
    expect(owed?.episodeKey).toBe(episode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('enforces one notice per (reminder, kind, episode)', async () => {
    // The whole design leans on this constraint: without it, two server
    // incarnations racing the same beat would each create a row, each see its
    // own as unsent, and both alert.
    const { error } = await client.from('heartbeat_notifications' as never).insert({
      reminder_id: reminderId,
      user_id: userId,
      kind: 'outage',
      episode_key: episodeKey,
      destination: 'sb-test|telegram|chat-1',
    } as never);

    expect(error).not.toBeNull();
    expect(error?.code).toBe('23505');
  });

  it('rejects a status outside the allowed set', async () => {
    const { error } = await client.from('heartbeat_notifications' as never).insert({
      reminder_id: reminderId,
      user_id: userId,
      kind: 'outage',
      episode_key: `${episodeKey}-bad-status`,
      status: 'sent-probably',
    } as never);

    expect(error?.code).toBe('23514');
  });
});
