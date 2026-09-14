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
import {
  createHeartbeatNotificationStore,
  type EpisodeBoundary,
} from './heartbeat-notification-store';

/**
 * "History read cleanly and holds no healthy beat" — the boundary an ordinary
 * mid-outage beat reports, and the one that lets `openEpisode` answer with the
 * episode already in progress. Named rather than inlined because every lookup
 * below that is NOT about the boundary rule still has to pass one.
 */
const MID_OUTAGE: EpisodeBoundary = { kind: 'none' };

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

  /**
   * The same real client, with exactly one response forced: a single-row read of
   * a RECOVERY notice resolves with a PostgREST error instead of a row.
   *
   * A read failure is the one state in this module that cannot be provoked from
   * the outside — the schema is correct, so PostgREST has no reason to refuse.
   * This forces the refusal and nothing else: every other query the store makes
   * still goes to the real table. That matters, because a test whose whole world
   * is a double I wrote can only confirm the belief I wrote into it.
   */
  const withUnreadableRecovery = (): typeof client =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table as never);
          if (table !== 'heartbeat_notifications') return builder;

          // `.select()` hands back a different builder object than `.from()`,
          // and the filters chain off that one — so the wrapper has to follow
          // the chain rather than assume every call returns `this`. The flags
          // are shared by closure, so what the whole chain asked for is known by
          // the time it is awaited.
          let readsRecovery = false;
          let readsOneRow = false;
          const isBuilder = (value: unknown): boolean =>
            typeof value === 'object' &&
            value !== null &&
            typeof (value as { eq?: unknown }).eq === 'function';

          const follow = (chain: Record<string, unknown>): unknown =>
            new Proxy(chain, {
              get(target, key) {
                const value = target[key as string];
                if (key === 'then') {
                  if (readsRecovery && readsOneRow) {
                    return (resolve: (value: unknown) => unknown) =>
                      Promise.resolve().then(() =>
                        resolve({
                          data: null,
                          error: { message: 'recovery read unavailable', code: '503' },
                        })
                      );
                  }
                  return (...args: unknown[]) =>
                    (value as (...a: unknown[]) => unknown).apply(target, args);
                }
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  if (key === 'eq' && args[0] === 'kind' && args[1] === 'recovery')
                    readsRecovery = true;
                  if (key === 'maybeSingle' || key === 'single') readsOneRow = true;
                  const next = (value as (...a: unknown[]) => unknown).apply(target, args);
                  return isBuilder(next) ? follow(next as Record<string, unknown>) : next;
                };
              },
            });

          return follow(builder as unknown as Record<string, unknown>);
        };
      },
    }) as typeof client;

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
    //
    // Its own reminder. This used to run on the shared fixture, where an earlier
    // test in this file had already written a pending recovery row — which under
    // the round-six boundary rule ends the episode. The test would have gone red
    // for a reason that has nothing to do with the property it names.
    const isolatedReminder = randomUUID();
    const openEpisodeKey = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'one outage keeps one key',
      delivery_channel: 'telegram',
      delivery_target: 'chat-6',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    await store.claimNotice({
      reminderId: isolatedReminder,
      userId,
      episodeKey: openEpisodeKey,
      destination: 'sb-test|telegram|chat-6',
      kind: 'outage',
    });

    const open = await store.openEpisode(isolatedReminder, MID_OUTAGE);
    expect(open).toBe(openEpisodeKey);
    expect(await store.openEpisode(isolatedReminder, MID_OUTAGE)).toBe(open);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
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
    expect(await store.openEpisode(reminderId, MID_OUTAGE)).not.toBe(episodeKey);
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
    expect(await store.openEpisode(isolatedReminder, MID_OUTAGE)).not.toBe(recoveredEpisode);

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

  it('does not read a FAILED recovery lookup as an absent one', async () => {
    // Round six, finding 3. PostgREST reports a failed read by RESOLVING with an
    // error rather than throwing, so "there is no recovery row" and "we could
    // not find out" reach the caller in the same shape: `data: null`. The store
    // collapsed them, read the second as the first, concluded no all-clear had
    // been sent, reused the old episode — and suppressed the next outage on a
    // notice row already marked delivered.
    //
    // A read that did not happen is not evidence that a notice was never sent.
    // The asymmetry this module is built on says an unreadable store costs a
    // duplicate alert; here it was buying silence, which is the opposite.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'an unreadable acknowledgement is not a negative one',
      delivery_channel: 'telegram',
      delivery_target: 'chat-11',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-11',
    };

    // An ordinary open outage with no recovery row — the state in which reusing
    // the episode is exactly right.
    await store.claimNotice({ ...base, kind: 'outage' });
    await store.settleNotice({ ...base, kind: 'outage' }, { delivered: true });

    // The control and the case differ in one thing only: whether the recovery
    // read answers. Same table, same rows, same code.
    expect(await store.openEpisode(isolatedReminder, MID_OUTAGE)).toBe(episode);

    const blindStore = createHeartbeatNotificationStore(withUnreadableRecovery());
    expect(await blindStore.openEpisode(isolatedReminder, MID_OUTAGE)).not.toBe(episode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('finds a pending all-clear whose outage row was never written', async () => {
    // Round six, finding 1. The sweep used to start exclusively from an outage
    // row, which holds until there is no outage row — and a failing store
    // produces exactly that. The outage INSERT fails, its recreation at settle
    // time fails too, and the direct channel send succeeds anyway, because this
    // module deliberately lets the alert go out ahead of its bookkeeping. The
    // human has been warned by a beat that left no trace.
    //
    // The next healthy beat writes its recovery row and its send fails. That
    // pending row is now the only record of the debt, and an anchored-only sweep
    // cannot see it: owed forever, retried never. The silence this module exists
    // to prevent, arrived at from a direction the outage row cannot cover.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'pending all-clear with no outage row',
      delivery_channel: 'telegram',
      delivery_target: 'chat-7',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const recoveryKey = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-7',
      kind: 'recovery' as const,
    };

    // Only the recovery row is ever written, and its send failed.
    await store.claimNotice(recoveryKey);
    await store.settleNotice(recoveryKey, { delivered: false, error: 'telegram unreachable' });
    await client
      .from('heartbeat_notifications' as never)
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never)
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'recovery')
      .eq('episode_key', episode);

    // Assert the state really is the one under test: no anchor, anywhere.
    const { data: outageRows } = await client
      .from('heartbeat_notifications' as never)
      .select('id')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'outage');
    expect((outageRows as unknown[] | null) ?? []).toHaveLength(0);

    const owed = await store.findOwedRecovery(isolatedReminder);
    expect(owed?.episodeKey).toBe(episode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('does not re-announce a pending all-clear whose episode is already closed', async () => {
    // The control for the test above, and the reason the unanchored scan checks
    // for an anchor at all rather than sweeping every pending recovery row. An
    // episode is only closed by an all-clear that was DELIVERED, so a closed
    // episode whose recovery row still reads pending is a lost acknowledgement
    // write, not an undelivered notice. Re-announcing it would tell the human a
    // second time about an outage they already watched resolve.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'closed episode owes nothing further',
      delivery_channel: 'telegram',
      delivery_target: 'chat-8',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-8',
    };

    await store.claimNotice({ ...base, kind: 'outage' });
    await store.settleNotice({ ...base, kind: 'outage' }, { delivered: true });
    await store.claimNotice({ ...base, kind: 'recovery' });
    // The all-clear landed — that is what closes the episode — but the write
    // recording it did not, so the row still reads pending.
    await store.closeEpisode({ ...base, kind: 'recovery' });

    const { data: recoveryRow } = await client
      .from('heartbeat_notifications' as never)
      .select('status')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'recovery')
      .eq('episode_key', episode)
      .single();
    expect((recoveryRow as { status: string }).status).toBe('pending');

    expect(await store.findOwedRecovery(isolatedReminder)).toBeNull();

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('ends an episode at an ATTEMPTED all-clear, without dropping its debt', async () => {
    // Round six, finding 2. A pending recovery row is UNCERTAIN delivery, not a
    // no: the send may well have landed with only its acknowledgement write
    // failing, which is the state a failing store leaves behind. `openEpisode`
    // used to reuse that episode for the next failure — handing it an outage
    // notice already marked delivered, so the new outage announced nothing after
    // the human had been told "recovered".
    //
    // Both halves are the test. The episode must end, AND its all-clear must
    // still be owed: ending it by quietly closing it would trade this silence
    // for the other one.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'an attempted all-clear ends the episode',
      delivery_channel: 'telegram',
      delivery_target: 'chat-9',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-9',
    };

    await store.claimNotice({ ...base, kind: 'outage' });
    await store.settleNotice({ ...base, kind: 'outage' }, { delivered: true });
    await store.claimNotice({ ...base, kind: 'recovery' });
    await store.settleNotice({ ...base, kind: 'recovery' }, { delivered: false, error: 'blip' });

    // Nothing closed the episode — the close write is not even attempted for an
    // all-clear that did not report success.
    const { data: outageRow } = await client
      .from('heartbeat_notifications' as never)
      .select('episode_closed_at')
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'outage')
      .eq('episode_key', episode)
      .single();
    expect((outageRow as { episode_closed_at: string | null }).episode_closed_at).toBeNull();

    expect(await store.openEpisode(isolatedReminder, MID_OUTAGE)).not.toBe(episode);

    const owed = await store.findOwedRecovery(isolatedReminder);
    expect(owed?.episodeKey).toBe(episode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('finds an older debt behind a newer open outage that owes nothing', async () => {
    // The consequence of the test above: ending an episode at the attempted
    // all-clear leaves it OPEN behind a freshly minted one, so a reminder can
    // now carry several open outage rows at once. A sweep that looked at only
    // the newest would stop at an episode that owes nothing — an outage whose
    // own alert never landed, so nobody is waiting on an all-clear for it — and
    // report no debt at all, while an older episode the human WAS warned about
    // waits behind it.
    const isolatedReminder = randomUUID();
    const olderEpisode = randomUUID();
    const newerEpisode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'a newer silent outage must not hide an older debt',
      delivery_channel: 'telegram',
      delivery_target: 'chat-10',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const older = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: olderEpisode,
      destination: 'sb-test|telegram|chat-10',
    };

    // The older episode: announced, heard, and its all-clear attempted and lost.
    await store.claimNotice({ ...older, kind: 'outage' });
    await store.settleNotice({ ...older, kind: 'outage' }, { delivered: true });
    await store.claimNotice({ ...older, kind: 'recovery' });
    await store.settleNotice({ ...older, kind: 'recovery' }, { delivered: false, error: 'blip' });
    await client
      .from('heartbeat_notifications' as never)
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() } as never)
      .eq('reminder_id', isolatedReminder)
      .eq('kind', 'recovery')
      .eq('episode_key', olderEpisode);

    // The newer episode: its outage alert was never delivered, so it owes
    // nothing — and it is the row a newest-first scan sees first.
    await store.claimNotice({
      reminderId: isolatedReminder,
      userId,
      episodeKey: newerEpisode,
      destination: 'sb-test|telegram|chat-10',
      kind: 'outage',
    });

    const owed = await store.findOwedRecovery(isolatedReminder);
    expect(owed?.episodeKey).toBe(olderEpisode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('ends an episode on a healthy beat even when NO recovery row was writable', async () => {
    // Round seven, finding 1. Every other boundary test in this file infers the
    // end of an episode from something this module wrote — a recovery row, a
    // close timestamp. The run worth surviving is the one where those writes
    // were failing, and then there is nothing to infer from: the all-clear is
    // sent, its recovery INSERT and the episode close both fail, and once the
    // store is healthy the recovery read truthfully reports no row at all.
    //
    // The caller knows anyway, from a table this module does not write: the
    // instant of the last delivered beat. The control is the first assertion —
    // without that knowledge the old episode is still the right answer, so it is
    // the boundary doing the work here and not the fixture.
    const isolatedReminder = randomUUID();
    const episode = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'a healthy beat ends an episode with no recovery row',
      delivery_channel: 'telegram',
      delivery_target: 'chat-11',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      episodeKey: episode,
      destination: 'sb-test|telegram|chat-11',
    };

    // Announced and heard. The all-clear that followed left no trace at all.
    await store.claimNotice({ ...base, kind: 'outage' });
    await store.settleNotice({ ...base, kind: 'outage' }, { delivered: true });

    const { data: rows } = await client
      .from('heartbeat_notifications' as never)
      .select('kind, episode_closed_at, created_at')
      .eq('reminder_id', isolatedReminder);
    expect(rows).toHaveLength(1);
    expect((rows as { kind: string }[])[0].kind).toBe('outage');
    expect((rows as { episode_closed_at: string | null }[])[0].episode_closed_at).toBeNull();

    // Both boundaries are derived from the row's OWN `created_at`, read back
    // from the database. Using the local clock would compare two clocks and
    // make the test's verdict depend on skew rather than on the rule.
    const openedAt = Date.parse((rows as { created_at: string }[])[0].created_at);
    const before: EpisodeBoundary = {
      kind: 'healthy-beat',
      at: new Date(openedAt - 1000).toISOString(),
    };
    const after: EpisodeBoundary = {
      kind: 'healthy-beat',
      at: new Date(openedAt + 1000).toISOString(),
    };

    // CONTROL: mid-outage, with no healthy beat between, the episode continues.
    expect(await store.openEpisode(isolatedReminder, MID_OUTAGE)).toBe(episode);

    // CONTROL: a healthy beat BEFORE this episode opened does not end it. Without
    // this, a boundary check that ignored the timestamp entirely would pass.
    expect(await store.openEpisode(isolatedReminder, before)).toBe(episode);

    // The fix: a healthy beat after it opened, so this failure is a new outage.
    expect(await store.openEpisode(isolatedReminder, after)).not.toBe(episode);

    // Round eight. The boundary has to be re-checked on every lookup, not spent
    // on the first one — that is the whole defect. The store is deliberately in
    // the state left by a beat whose fresh episode could not be persisted: no new
    // row, the old delivered outage still the newest thing here. Asking again
    // must still refuse it.
    expect(await store.openEpisode(isolatedReminder, after)).not.toBe(episode);

    // And the old episode's all-clear is still owed — ending it by quietly
    // closing it would trade this silence for the other one.
    expect((await store.findOwedRecovery(isolatedReminder))?.episodeKey).toBe(episode);

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('keeps a minted episode once its row lands, and refuses the one before it', async () => {
    // Round eight, the other half. Refusing a finished episode on every beat is
    // only correct if a LIVE one is still reused on every beat — otherwise the
    // fix for a permanently silent outage is an outage that alarms forever.
    //
    // Two episodes on one reminder, separated by a healthy beat: the old one
    // delivered and never closed (its all-clear left no trace), the new one
    // opened after the boundary. Repeated lookups must keep answering with the
    // new one.
    const isolatedReminder = randomUUID();
    const finished = randomUUID();
    const current = randomUUID();

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'a live episode survives repeated boundary checks',
      delivery_channel: 'telegram',
      delivery_target: 'chat-13',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    const base = {
      reminderId: isolatedReminder,
      userId,
      destination: 'sb-test|telegram|chat-13',
    };

    await store.claimNotice({ ...base, episodeKey: finished, kind: 'outage' });
    await store.settleNotice(
      { ...base, episodeKey: finished, kind: 'outage' },
      { delivered: true }
    );

    const { data: firstRow } = await client
      .from('heartbeat_notifications' as never)
      .select('created_at')
      .eq('reminder_id', isolatedReminder)
      .eq('episode_key', finished)
      .single();
    const healthyBeat = new Date(
      Date.parse((firstRow as { created_at: string }).created_at) + 1000
    ).toISOString();

    // The new outage's row lands this time, dated after the healthy beat.
    await store.claimNotice({ ...base, episodeKey: current, kind: 'outage' });
    await client
      .from('heartbeat_notifications' as never)
      .update({ created_at: new Date(Date.parse(healthyBeat) + 1000).toISOString() } as never)
      .eq('reminder_id', isolatedReminder)
      .eq('episode_key', current);

    const boundary: EpisodeBoundary = { kind: 'healthy-beat', at: healthyBeat };
    for (let beat = 0; beat < 3; beat++) {
      expect(await store.openEpisode(isolatedReminder, boundary)).toBe(current);
    }

    await client.from('scheduled_reminders').delete().eq('id', isolatedReminder);
  });

  it('advances the bounded scan past all-clears that are excluded from it forever', async () => {
    // Round seven, finding 2. The orphan scan applies its limit BEFORE excluding
    // anchored rows, so a row excluded on every sweep also consumes the window on
    // every sweep. OWED_SCAN_LIMIT of these — delivered all-clears whose episodes
    // closed and whose only failed write was their own status UPDATE, an entirely
    // ordinary path — sit newer than an unanchored debt and hide it permanently,
    // with every store and channel healthy. The anchored scan cannot help: the
    // orphan has no anchor. A bigger limit only moves the threshold.
    const isolatedReminder = randomUUID();
    const orphanEpisode = randomUUID();
    const destination = 'sb-test|telegram|chat-12';

    await client.from('scheduled_reminders').insert({
      id: isolatedReminder,
      user_id: userId,
      title: 'a bounded scan must keep moving',
      delivery_channel: 'telegram',
      delivery_target: 'chat-12',
      next_run_at: new Date().toISOString(),
      status: 'active',
    } as never);

    // The debt: a pending all-clear whose outage row was never written.
    await store.claimNotice({
      reminderId: isolatedReminder,
      userId,
      episodeKey: orphanEpisode,
      destination,
      kind: 'recovery',
    });

    // Ten newer episodes, each fully settled in substance — outage delivered,
    // all-clear delivered, episode closed — but each with its recovery status
    // UPDATE lost, so the row stays `pending` and keeps occupying the window.
    for (let i = 0; i < 10; i++) {
      const settled = {
        reminderId: isolatedReminder,
        userId,
        episodeKey: randomUUID(),
        destination,
      };
      await store.claimNotice({ ...settled, kind: 'outage' });
      await store.settleNotice({ ...settled, kind: 'outage' }, { delivered: true });
      await store.claimNotice({ ...settled, kind: 'recovery' });
      await store.closeEpisode({ ...settled, kind: 'recovery' });
    }

    // Order the window deterministically rather than trusting insert timing to
    // separate eleven rows written inside the same second.
    await client
      .from('heartbeat_notifications' as never)
      .update({
        created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      } as never)
      .eq('reminder_id', isolatedReminder)
      .eq('episode_key', orphanEpisode);

    expect(
      (
        await client
          .from('heartbeat_notifications' as never)
          .select('id')
          .eq('reminder_id', isolatedReminder)
          .eq('kind', 'recovery')
          .eq('status', 'pending')
      ).data
    ).toHaveLength(11);

    // CONTROL: the ten fill the window, so the older debt is invisible — this is
    // the reported bug, and without it the assertion below proves nothing.
    expect(await store.findOwedRecovery(isolatedReminder)).toBeNull();

    // The fix: that sweep retired the ten it will never return, so the window
    // has moved and the debt is reachable. Bounded work, with progress.
    expect((await store.findOwedRecovery(isolatedReminder))?.episodeKey).toBe(orphanEpisode);

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
