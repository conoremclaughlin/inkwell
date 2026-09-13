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
 * So a notice is suppressed only once it has been DELIVERED. A pending one is
 * retried on the next beat, bounded by `MAX_NOTICE_ATTEMPTS` so a permanently
 * dead channel becomes a logged `exhausted` row rather than an unbounded retry.
 *
 * FAILING TOWARD NOISE, DELIBERATELY.
 *
 * Every read here degrades to "we have not told them yet" when the store is
 * unreachable, and every write degrades to a warning. A store outage therefore
 * costs duplicate alerts, never silence. That asymmetry is the whole point: this
 * subsystem exists because a monitor went quiet, and a monitor that goes quiet
 * when its bookkeeping breaks has learned nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';
import { logger } from '../utils/logger.js';

/**
 * How many times we will try to push one notice before giving up on it.
 *
 * Three is a compromise between a transient channel blip (worth retrying) and a
 * channel that is simply gone (where retrying every beat forever just moves the
 * noise into the log). An exhausted notice stops retrying but stays on the row
 * with its last error, so "we could never tell you" remains answerable.
 */
export const MAX_NOTICE_ATTEMPTS = 3;

export type NoticeKind = 'outage' | 'recovery';

export interface NoticeRecord {
  id: string;
  status: 'pending' | 'delivered' | 'exhausted';
  attempts: number;
}

export interface NoticeKey {
  reminderId: string;
  userId: string;
  kind: NoticeKind;
  /** Identifies the outage. See the migration for why it is a timestamp. */
  episodeKey: string;
  destination: string | null;
  /**
   * Beats failed when the notice was composed. Payload rather than identity —
   * recorded on creation so a retry sent from a later healthy beat can still
   * name what it recovered from.
   */
  failedBeats?: number;
}

export interface HeartbeatNotificationStore {
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
   * A recovery notice that failed to send has no natural trigger to retry it:
   * once the beat is healthy the failure streak is zero, so the recovery edge
   * never fires again. This is the sweep that gives it one.
   */
  findRetryableRecovery(
    reminderId: string
  ): Promise<
    (NoticeRecord & { episodeKey: string; destination: string | null; failedBeats: number }) | null
  >;
}

interface NoticeRow {
  id: string;
  status: 'pending' | 'delivered' | 'exhausted';
  attempts: number;
  episode_key: string;
  destination: string | null;
  failed_beats: number | null;
}

export function createHeartbeatNotificationStore(
  client: SupabaseClient<Database>
): HeartbeatNotificationStore {
  const table = () => client.from('heartbeat_notifications' as never);

  const load = async (key: NoticeKey): Promise<NoticeRow | null> => {
    const { data, error } = await table()
      .select('id, status, attempts, episode_key, destination, failed_beats')
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

  const claimNotice: HeartbeatNotificationStore['claimNotice'] = async (key) => {
    let record: NoticeRow | null;
    try {
      record = await load(key);
    } catch (err) {
      logger.warn('[Heartbeat] Notice acknowledgement lookup threw', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return { shouldSend: true, record: null };
    }

    if (!record) {
      // First time we have considered this episode. Create the row up front so
      // a crash between here and the send still leaves evidence that a notice
      // was owed — a missing row is indistinguishable from "never happened".
      try {
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
          } as never)
          .select('id, status, attempts, episode_key, destination, failed_beats')
          .single();

        if (error) {
          // A unique violation means a concurrent server incarnation created it
          // first; re-read rather than assuming. Anything else: send anyway.
          const reread = await load(key);
          if (!reread) {
            logger.warn('[Heartbeat] Could not create notice acknowledgement', {
              reminderId: key.reminderId,
              kind: key.kind,
              error: error.message,
            });
            return { shouldSend: true, record: null };
          }
          record = reread;
        } else {
          record = data as NoticeRow;
        }
      } catch (err) {
        logger.warn('[Heartbeat] Notice acknowledgement insert threw', {
          reminderId: key.reminderId,
          kind: key.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return { shouldSend: true, record: null };
      }
    }

    const summary: NoticeRecord = {
      id: record.id,
      status: record.status,
      attempts: record.attempts,
    };

    // Delivered is the ONLY thing that buys silence.
    if (record.status === 'delivered') return { shouldSend: false, record: summary };
    if (record.status === 'exhausted') return { shouldSend: false, record: summary };
    if (record.attempts >= MAX_NOTICE_ATTEMPTS) return { shouldSend: false, record: summary };

    return { shouldSend: true, record: summary };
  };

  const settleNotice: HeartbeatNotificationStore['settleNotice'] = async (key, outcome) => {
    try {
      const record = await load(key);
      const attempts = (record?.attempts ?? 0) + 1;
      const now = new Date().toISOString();

      const status = outcome.delivered
        ? 'delivered'
        : attempts >= MAX_NOTICE_ATTEMPTS
          ? 'exhausted'
          : 'pending';

      const { error } = await table()
        .update({
          status,
          attempts,
          last_attempt_at: now,
          last_error: outcome.delivered ? null : (outcome.error ?? 'send reported failure'),
          delivered_at: outcome.delivered ? now : null,
        } as never)
        .eq('reminder_id', key.reminderId)
        .eq('kind', key.kind)
        .eq('episode_key', key.episodeKey);

      if (error) {
        logger.warn('[Heartbeat] Could not record notice outcome', {
          reminderId: key.reminderId,
          kind: key.kind,
          delivered: outcome.delivered,
          error: error.message,
        });
        return;
      }

      if (status === 'exhausted') {
        // Worth its own line: this is the point at which we stop trying to tell
        // a human something is wrong, which is exactly the shape of failure
        // this whole subsystem exists to prevent.
        logger.error('[Heartbeat] Gave up delivering an outage notice', {
          reminderId: key.reminderId,
          kind: key.kind,
          attempts,
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

  const markCoveredBySibling: HeartbeatNotificationStore['markCoveredBySibling'] = async (key) => {
    try {
      // Ensure the row exists, then mark it. claimNotice's insert path is reused
      // so the two cannot drift apart on required columns.
      await claimNotice(key);
      const now = new Date().toISOString();
      const { error } = await table()
        .update({
          status: 'delivered',
          delivered_at: now,
          last_attempt_at: now,
          last_error: null,
        } as never)
        .eq('reminder_id', key.reminderId)
        .eq('kind', key.kind)
        .eq('episode_key', key.episodeKey);

      if (error) {
        logger.warn('[Heartbeat] Could not record sibling coverage', {
          reminderId: key.reminderId,
          kind: key.kind,
          error: error.message,
        });
      }
    } catch (err) {
      logger.warn('[Heartbeat] Sibling coverage write threw', {
        reminderId: key.reminderId,
        kind: key.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const findRetryableRecovery: HeartbeatNotificationStore['findRetryableRecovery'] = async (
    reminderId
  ) => {
    try {
      const { data, error } = await table()
        .select('id, status, attempts, episode_key, destination, failed_beats')
        .eq('reminder_id', reminderId)
        .eq('kind', 'recovery')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) {
        logger.warn('[Heartbeat] Could not scan for unsent recovery notices', {
          reminderId,
          error: error.message,
        });
        return null;
      }

      const row = (data as NoticeRow[] | null)?.[0];
      if (!row) return null;
      if (row.attempts >= MAX_NOTICE_ATTEMPTS) return null;

      return {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        episodeKey: row.episode_key,
        destination: row.destination,
        failedBeats: row.failed_beats ?? 0,
      };
    } catch (err) {
      logger.warn('[Heartbeat] Recovery notice scan threw', {
        reminderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  return { claimNotice, settleNotice, markCoveredBySibling, findRetryableRecovery };
}
