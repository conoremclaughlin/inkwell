/**
 * Durable acknowledgement for heartbeat outage and recovery notices.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO HOLD.
 *
 * A heartbeat failure streak says a previous BEAT failed. It says nothing about
 * whether that beat's outage alert reached a human. Suppressing on the streak
 * (`consecutive > 1`) therefore fails in the worst direction: if the first
 * channel send rejects, its failure is already in `reminder_history`, so every
 * later beat reads a streak greater than one and stays quiet. Zero successful
 * alerts, for an outage that is still happening — the silence bug reproduced
 * inside its own fix.
 *
 * So a notice is suppressed only once it has been DELIVERED.
 *
 * EPISODE IDENTITY IS MINTED, NOT DERIVED.
 *
 * An episode key must be the same string on every beat of one outage, or the
 * "have we told them yet" lookup asks about a different episode each time and
 * every beat alarms. The first cut derived the key from `reminder_history` and
 * drifted twice over: the first failure of an outage has no prior row to date
 * itself from and fell back to an application timestamp, while the second beat
 * read the first's `triggered_at` out of the database — different value, and a
 * different text encoding of it. Two ordinary beats, two alarms, no race
 * required. Past the history lookback window the key moved again.
 *
 * So the key is minted once as a uuid and read back from this table thereafter.
 * `openEpisode` is that lookup. A value we assign and store cannot drift.
 *
 * AN OWED ALL-CLEAR OUTLIVES THE ROW THAT WOULD HAVE RECORDED IT.
 *
 * If a human was told their monitor is down, they are owed a "it is back". That
 * obligation cannot depend on the recovery row being written, because the case
 * that matters is precisely the one where the store was failing: recovery
 * INSERT fails, channel fails, the settle UPDATE matches nothing, and the beat
 * is healthy again by the next tick so the recovery edge never fires. History
 * says healthy; nobody is owed anything; the human holds an outage alert
 * forever. That is silence produced by a store failure, which is the one
 * outcome this module promises never to produce.
 *
 * The obligation is therefore carried by the OUTAGE row, which already exists
 * by then: `episode_closed_at` stays null until the all-clear is delivered, and
 * `findOwedRecovery` reconstructs the owed notice from it. The recovery row is
 * bookkeeping; the outage row is the debt.
 *
 * FAILING TOWARD NOISE, DELIBERATELY.
 *
 * Every read here degrades to "we have not told them yet" when the store is
 * unreachable, and every write degrades to a warning. A store outage therefore
 * costs duplicate alerts, never silence. That asymmetry is the whole point: this
 * subsystem exists because a monitor went quiet, and a monitor that goes quiet
 * when its bookkeeping breaks has learned nothing.
 *
 * WHICH IS WHY THERE IS NO ATTEMPT CAP.
 *
 * There was one: three tries, then the notice was logged and abandoned. Review
 * rejected it and I agree — under a no-silence contract, a cap converts a long
 * channel outage into exactly the silence the table exists to prevent, and it
 * does so at the moment the human most needs the message. What is bounded is
 * retry FREQUENCY, not eligibility: `next_attempt_at` backs off geometrically
 * to a ceiling, so a permanently dead channel costs one attempt every few hours
 * rather than one per beat, and the notice stays owed until it lands.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';
import { logger } from '../utils/logger.js';

/**
 * Backoff schedule for a notice that has not landed yet, in milliseconds.
 *
 * The first retry is immediate (the next beat) because the common failure is a
 * momentary channel blip and the message is urgent. After that it steps back so
 * a channel that is simply gone does not cost an attempt per beat forever. The
 * last entry is the ceiling and repeats indefinitely — the notice never stops
 * being owed, it just stops being frequent.
 */
export const NOTICE_BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/** Backoff for the Nth consecutive failed attempt (1-based). */
export function backoffForAttempt(attempts: number): number {
  if (attempts <= 0) return 0;
  const index = Math.min(attempts, NOTICE_BACKOFF_MS.length) - 1;
  return NOTICE_BACKOFF_MS[index];
}

export type NoticeKind = 'outage' | 'recovery';

export interface NoticeRecord {
  id: string;
  status: 'pending' | 'delivered';
  attempts: number;
}

export interface NoticeKey {
  reminderId: string;
  userId: string;
  kind: NoticeKind;
  /** Minted uuid identifying the outage. See the module note. */
  episodeKey: string;
  destination: string | null;
  /**
   * Beats failed when the notice was composed. Payload rather than identity —
   * recorded on creation so a retry sent from a later healthy beat can still
   * name what it recovered from.
   */
  failedBeats?: number;
}

/** An all-clear we still owe, reconstructed from its outage row. */
export interface OwedRecovery {
  episodeKey: string;
  destination: string | null;
  failedBeats: number;
  /** Attempts already spent on the recovery notice, if its row exists at all. */
  attempts: number;
}

export interface HeartbeatNotificationStore {
  /**
   * The episode key for the outage currently in progress on this reminder,
   * minting one if this is its first failure.
   *
   * Returns a fresh uuid rather than null when the store cannot be read, so an
   * unreadable store costs a duplicate alert instead of attaching this beat to
   * an episode it cannot verify.
   */
  openEpisode(reminderId: string): Promise<string>;
  /**
   * Whether a notice for this episode should be sent now.
   *
   * Returns the row so the caller can report attempt counts, and `shouldSend`
   * so the decision itself lives in one place rather than being re-derived by
   * every caller.
   */
  claimNotice(key: NoticeKey): Promise<{ shouldSend: boolean; record: NoticeRecord | null }>;
  /** Record the outcome of an attempt. */
  settleNotice(key: NoticeKey, outcome: { delivered: boolean; error?: string }): Promise<void>;
  /**
   * Mark an episode's notice delivered without having sent it — because a
   * sibling beat's notice already reached the same destination in this run.
   * The human was told, which is the thing that matters; without this the
   * suppressed sibling would alert on its own next beat.
   */
  markCoveredBySibling(key: NoticeKey): Promise<void>;
  /**
   * An all-clear that is owed and has not been delivered.
   *
   * This is the sweep that gives a failed all-clear an edge to fire on again:
   * once the beat is healthy the failure streak is zero and the recovery branch
   * never runs, so without this the debt would never be retried.
   *
   * An episode is anchored on its OUTAGE row — that is where open/closed lives —
   * but the debt is proven by EITHER a delivered outage (the recovery row may
   * never have been written, and is reconstructed) OR the existence of an
   * undelivered recovery row (which proves the outage was announced even if the
   * outage row's own acknowledgement write failed). Each proof covers a write
   * failure the other one misses.
   */
  findOwedRecovery(reminderId: string): Promise<OwedRecovery | null>;
  /**
   * Mark an episode's debt settled, once its all-clear has been DELIVERED.
   *
   * Only delivery closes an episode. An attempted-but-failed all-clear leaves it
   * open so `findOwedRecovery` keeps finding it — the same attempt-is-not-an-
   * outcome rule the rest of this module turns on.
   */
  closeEpisode(key: NoticeKey): Promise<void>;
}

interface NoticeRow {
  id: string;
  status: 'pending' | 'delivered';
  attempts: number;
  episode_key: string;
  destination: string | null;
  failed_beats: number | null;
  next_attempt_at: string | null;
}

const NOTICE_COLUMNS =
  'id, status, attempts, episode_key, destination, failed_beats, next_attempt_at';

export function createHeartbeatNotificationStore(
  client: SupabaseClient<Database>
): HeartbeatNotificationStore {
  const table = () => client.from('heartbeat_notifications');

  const load = async (key: NoticeKey): Promise<NoticeRow | null> => {
    const { data, error } = await table()
      .select(NOTICE_COLUMNS)
      .eq('reminder_id', key.reminderId)
      .eq('kind', key.kind)
      .eq('episode_key', key.episodeKey)
      .maybeSingle();

    if (error) {
      // Degrade toward sending. See the module note.
      logger.warn('[Heartbeat] Could not read notice acknowledgement', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: error.message,
      });
      return null;
    }
    return (data as NoticeRow | null) ?? null;
  };

  /**
   * Whether an episode is recovered in substance: its all-clear was DELIVERED.
   *
   * Delivery of the all-clear is what ends an episode. `episode_closed_at` is
   * only the record of that, and the two can disagree — the close is a separate
   * write and it can fail on its own.
   */
  const recoveryWasDelivered = async (
    reminderId: string,
    episodeKey: string,
    destination: string | null
  ): Promise<boolean> => {
    const recovery = await load({
      reminderId,
      userId: '',
      kind: 'recovery',
      episodeKey,
      destination,
    });
    return recovery?.status === 'delivered';
  };

  const openEpisode: HeartbeatNotificationStore['openEpisode'] = async (reminderId) => {
    try {
      const { data, error } = await table()
        .select('episode_key, destination')
        .eq('reminder_id', reminderId)
        .eq('kind', 'outage')
        .is('episode_closed_at', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        logger.warn('[Heartbeat] Could not read the open outage episode', {
          reminderId,
          error: error.message,
        });
        return randomUUID();
      }

      const existing = (data as { episode_key: string; destination: string | null }[] | null)?.[0];
      if (!existing) return randomUUID();

      // An episode whose all-clear was delivered is over, whatever the close
      // write did. If the close failed, the row still looks open — and reusing
      // it here would hand the next outage an episode whose outage notice is
      // already marked delivered, so it would announce nothing. That is a new
      // outage silenced by the bookkeeping of the previous one, after the human
      // was explicitly told the monitor was back. Reconcile and start fresh.
      if (await recoveryWasDelivered(reminderId, existing.episode_key, existing.destination)) {
        await closeEpisode({
          reminderId,
          userId: '',
          kind: 'recovery',
          episodeKey: existing.episode_key,
          destination: existing.destination,
        });
        return randomUUID();
      }

      return existing.episode_key;
    } catch (err) {
      logger.warn('[Heartbeat] Open-episode lookup threw', {
        reminderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return randomUUID();
    }
  };

  /** Create the row for an episode we have not considered before. */
  const insertNotice = async (key: NoticeKey): Promise<NoticeRow | null> => {
    const { data, error } = await table()
      .insert({
        reminder_id: key.reminderId,
        user_id: key.userId,
        kind: key.kind,
        episode_key: key.episodeKey,
        destination: key.destination,
        failed_beats: key.failedBeats ?? 0,
        status: 'pending',
        attempts: 0,
      })
      .select(NOTICE_COLUMNS)
      .single();

    if (error) {
      // A unique violation means a concurrent server incarnation created it
      // first; re-read rather than assuming.
      const reread = await load(key);
      if (!reread) {
        logger.warn('[Heartbeat] Could not create notice acknowledgement', {
          reminderId: key.reminderId,
          kind: key.kind,
          error: error.message,
        });
        return null;
      }
      return reread;
    }
    return data as NoticeRow;
  };

  const claimNotice: HeartbeatNotificationStore['claimNotice'] = async (key) => {
    let record: NoticeRow | null;
    try {
      record = await load(key);
      if (!record) {
        // First time we have considered this episode. Create the row up front so
        // a crash between here and the send still leaves evidence that a notice
        // was owed — a missing row is indistinguishable from "never happened".
        record = await insertNotice(key);
      }
    } catch (err) {
      logger.warn('[Heartbeat] Notice acknowledgement lookup threw', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return { shouldSend: true, record: null };
    }

    // No row and no way to make one: send anyway. A store we cannot write to
    // must not be able to decide that a human does not need to hear about this.
    if (!record) return { shouldSend: true, record: null };

    const summary: NoticeRecord = {
      id: record.id,
      status: record.status,
      attempts: record.attempts,
    };

    // Delivered is the ONLY thing that buys silence.
    if (record.status === 'delivered') return { shouldSend: false, record: summary };

    // Still owed, but recently attempted. Bounded frequency, unbounded
    // eligibility: this notice will be sent, just not on this beat.
    if (record.next_attempt_at) {
      const due = Date.parse(record.next_attempt_at);
      if (Number.isFinite(due) && due > Date.now()) {
        return { shouldSend: false, record: summary };
      }
    }

    return { shouldSend: true, record: summary };
  };

  const settleNotice: HeartbeatNotificationStore['settleNotice'] = async (key, outcome) => {
    try {
      const record = await load(key);
      const attempts = (record?.attempts ?? 0) + 1;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      const patch = {
        status: outcome.delivered ? 'delivered' : 'pending',
        attempts,
        last_attempt_at: nowIso,
        last_error: outcome.delivered ? null : (outcome.error ?? 'send reported failure'),
        delivered_at: outcome.delivered ? nowIso : null,
        next_attempt_at: outcome.delivered
          ? null
          : new Date(now + backoffForAttempt(attempts)).toISOString(),
      };

      const { data, error } = await table()
        .update(patch)
        .eq('reminder_id', key.reminderId)
        .eq('kind', key.kind)
        .eq('episode_key', key.episodeKey)
        .select('id');

      if (error) {
        logger.warn('[Heartbeat] Could not record notice outcome', {
          reminderId: key.reminderId,
          kind: key.kind,
          delivered: outcome.delivered,
          error: error.message,
        });
        return;
      }

      // A zero-row UPDATE is not an error in PostgREST — it resolves with an
      // empty array. Treating it as success is how an obligation disappears:
      // the row was never created (its INSERT failed earlier), the UPDATE
      // matches nothing, and the notice is neither delivered nor owed. Rebuild
      // it so it stays owed.
      const matched = (data as { id: string }[] | null)?.length ?? 0;
      if (matched === 0) {
        logger.warn('[Heartbeat] Notice outcome matched no row — recreating the obligation', {
          reminderId: key.reminderId,
          kind: key.kind,
          delivered: outcome.delivered,
        });
        const created = await insertNotice(key);
        if (created) {
          const { error: patchError } = await table().update(patch).eq('id', created.id);
          if (patchError) {
            logger.warn('[Heartbeat] Could not settle the recreated notice row', {
              reminderId: key.reminderId,
              kind: key.kind,
              error: patchError.message,
            });
          }
        }
        return;
      }

      if (!outcome.delivered) {
        logger.warn('[Heartbeat] Notice still owed after a failed send', {
          reminderId: key.reminderId,
          kind: key.kind,
          attempts,
          retryAfterMs: backoffForAttempt(attempts),
          lastError: outcome.error,
        });
      }
    } catch (err) {
      logger.warn('[Heartbeat] Notice outcome write threw', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Close the episode on its outage row, so the "all-clear still owed" sweep
   * stops finding it. Only a DELIVERED recovery closes an episode.
   */
  const closeEpisode = async (key: NoticeKey): Promise<void> => {
    try {
      const { error } = await table()
        .update({ episode_closed_at: new Date().toISOString() })
        .eq('reminder_id', key.reminderId)
        .eq('kind', 'outage')
        .eq('episode_key', key.episodeKey);

      if (error) {
        // Degrades toward a duplicate all-clear on a later beat, never silence —
        // but only because `openEpisode` re-checks whether the all-clear was
        // delivered instead of trusting this column. Left to itself, a failed
        // close leaves a finished episode looking open, and the next outage
        // inherits an already-delivered outage notice and says nothing.
        logger.warn('[Heartbeat] Could not close the outage episode', {
          reminderId: key.reminderId,
          episodeKey: key.episodeKey,
          error: error.message,
        });
      }
    } catch (err) {
      // Bookkeeping must never take down the notice it describes. Leaving the
      // episode open costs a duplicate all-clear; throwing here would abort
      // `onRecovery` after the all-clear had already been sent.
      logger.warn('[Heartbeat] Closing the outage episode threw', {
        reminderId: key.reminderId,
        episodeKey: key.episodeKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const markDelivered = async (key: NoticeKey): Promise<void> => {
    const now = new Date().toISOString();
    const { data, error } = await table()
      .update({
        status: 'delivered',
        delivered_at: now,
        last_attempt_at: now,
        last_error: null,
        next_attempt_at: null,
      })
      .eq('reminder_id', key.reminderId)
      .eq('kind', key.kind)
      .eq('episode_key', key.episodeKey)
      .select('id');

    if (error) {
      logger.warn('[Heartbeat] Could not record sibling coverage', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: error.message,
      });
      return;
    }

    if (((data as { id: string }[] | null)?.length ?? 0) === 0) {
      logger.warn('[Heartbeat] Sibling coverage matched no row', {
        reminderId: key.reminderId,
        kind: key.kind,
      });
    }
  };

  const markCoveredBySibling: HeartbeatNotificationStore['markCoveredBySibling'] = async (key) => {
    try {
      // Ensure the row exists, then mark it. claimNotice's insert path is reused
      // so the two cannot drift apart on required columns.
      await claimNotice(key);
      await markDelivered(key);
      // A sibling's all-clear closes the episode just as our own would have.
      if (key.kind === 'recovery') await closeEpisode(key);
    } catch (err) {
      logger.warn('[Heartbeat] Sibling coverage write threw', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const findOwedRecovery: HeartbeatNotificationStore['findOwedRecovery'] = async (reminderId) => {
    try {
      // The debt lives on the episode, and there are two independent proofs of
      // it — see below. The outage row is the anchor because it is the row that
      // carries the open/closed state; its own `status` is deliberately NOT a
      // filter here, because a pending outage does not mean the human never
      // heard it. It can equally mean the send succeeded and the acknowledgement
      // write that should have recorded it is the thing that failed.
      const { data, error } = await table()
        .select(NOTICE_COLUMNS)
        .eq('reminder_id', reminderId)
        .eq('kind', 'outage')
        .is('episode_closed_at', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        logger.warn('[Heartbeat] Could not scan for owed all-clears', {
          reminderId,
          error: error.message,
        });
        return null;
      }

      const outage = (data as NoticeRow[] | null)?.[0];
      if (!outage) return null;

      // The recovery row may or may not exist. If it does and it is already
      // delivered, the episode is closed in substance and the outage row simply
      // missed its update — close it and stand down.
      const recovery = await load({
        reminderId,
        userId: '',
        kind: 'recovery',
        episodeKey: outage.episode_key,
        destination: outage.destination,
      });

      if (recovery?.status === 'delivered') {
        await closeEpisode({
          reminderId,
          userId: '',
          kind: 'recovery',
          episodeKey: outage.episode_key,
          destination: outage.destination,
        });
        return null;
      }

      // Two independent proofs that an all-clear is owed, and we need both
      // tests because each one covers a write failure the other misses:
      //
      //   - the OUTAGE row is delivered. The recovery row may never have been
      //     written at all; it is reconstructed from the outage row below.
      //   - a RECOVERY row exists and is not delivered. Only an attempted
      //     all-clear writes that row, and an all-clear is only attempted for an
      //     announced outage — so its existence proves the outage was announced
      //     even when the outage row's own acknowledgement write is what failed.
      //
      // A pending outage with no recovery row is the one case that is genuinely
      // not owed: nothing here says the human was ever told.
      const owed = outage.status === 'delivered' || recovery !== null;
      if (!owed) return null;

      // Respect the recovery notice's own backoff if it has one.
      if (recovery?.next_attempt_at) {
        const due = Date.parse(recovery.next_attempt_at);
        if (Number.isFinite(due) && due > Date.now()) return null;
      }

      return {
        episodeKey: outage.episode_key,
        destination: outage.destination,
        failedBeats: recovery?.failed_beats ?? outage.failed_beats ?? 0,
        attempts: recovery?.attempts ?? 0,
      };
    } catch (err) {
      logger.warn('[Heartbeat] Owed all-clear scan threw', {
        reminderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  return {
    openEpisode,
    claimNotice,
    settleNotice,
    markCoveredBySibling,
    findOwedRecovery,
    closeEpisode,
  };
}
