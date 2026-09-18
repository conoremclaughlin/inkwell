/**
 * Heartbeat Service
 *
 * Manages scheduled reminders and periodic checks.
 * - In production: triggered by pg_cron via HTTP
 * - In development: uses node-cron as fallback
 *
 * The heartbeat service is delivery-agnostic. It queries for due reminders,
 * checks quiet hours, and delegates delivery to the caller via a callback.
 * This means ALL agent wake-ups flow through the same path (e.g.,
 * sessionHost.handleMessage), regardless of whether they're triggered by
 * a reminder, an inbox message, or another agent.
 */

import * as cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { isWithinQuietHours } from './quiet-hours.js';
import { CronExpressionParser } from 'cron-parser';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  createHeartbeatNotificationStore,
  type EpisodeBoundary,
} from './heartbeat-notification-store.js';
import type { Database, Json } from '../data/supabase/types.js';

// DueReminder is the subset of fields we need for processing
export interface DueReminder {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  delivery_channel: string;
  delivery_target: string | null;
  sb_id: string | null;
  cron_expression: string | null;
  next_run_at: string;
  run_count: number;
  max_runs: number | null;
  studio_hint: string | null;
  metadata: Record<string, unknown> | null;
}

interface HeartbeatConfig {
  /** Cron expression for heartbeat interval (default: every 5 minutes) */
  interval?: string;
  /** Enable local cron scheduler */
  enableLocalCron?: boolean;
  /** Callback to run on each heartbeat tick */
  onHeartbeat?: () => Promise<void>;
}

/**
 * How far back to look when measuring a failure streak. Only the leading run
 * of failures is counted, so this is a ceiling on the reported number, not a
 * window that can hide one: any outage longer than this still reports as
 * "at least this many" and has long since alerted on its first beat.
 *
 * It bounds the COUNT and nothing else. The episode boundary is read by its own
 * query (`lastDeliveredBeat`) precisely so that it cannot be truncated away —
 * see the note there.
 */
const FAILURE_STREAK_LOOKBACK = 50;

/**
 * The `reminder_history` column the streak sorts by.
 *
 * Exported so the integration tier can run the sort against the real table
 * rather than a mock. A mocked `order()` returns the builder for ANY string,
 * so the unit tier cannot tell a real column from a typo — and a typo here is
 * silent and total: PostgREST fails the sort with 42703, the catch turns that
 * into a streak of 0, every failed beat then reads as its own first, and the
 * result is an alert on EVERY beat and an all-clear on none. Shipped exactly
 * that way on this branch until Myra's report sent me back to the schema.
 */
export const FAILURE_STREAK_ORDER_COLUMN = 'triggered_at';

/**
 * The streak's bounded read: the most recent beats, newest first.
 *
 * Exported, like the column constant above and for the same reason — so the
 * integration tier can run the query production runs rather than a copy of it
 * that has drifted.
 */
export function selectFailureStreakWindow(client: SupabaseClient<Database>, reminderId: string) {
  return client
    .from('reminder_history')
    .select('status, triggered_at')
    .eq('reminder_id', reminderId)
    .in('status', ['delivered', 'failed'])
    .order(FAILURE_STREAK_ORDER_COLUMN, { ascending: false })
    .limit(FAILURE_STREAK_LOOKBACK);
}

/**
 * The boundary read: the single most recent DELIVERED beat.
 *
 * Deliberately NOT the query above with a filter bolted on. It has no window, so
 * no number of failed beats stacked on top can push the answer out of range —
 * which is the entire reason it is a separate query. See `lastDeliveredBeat`.
 */
export function selectLastDeliveredBeat(client: SupabaseClient<Database>, reminderId: string) {
  return client
    .from('reminder_history')
    .select('triggered_at')
    .eq('reminder_id', reminderId)
    .eq('status', 'delivered')
    .order(FAILURE_STREAK_ORDER_COLUMN, { ascending: false })
    .limit(1);
}

/**
 * Who an outage alert would reach: a given SB, on a given channel, at a given
 * address. `null` when the beat has no owning SB, which leaves it to dedupe on
 * its own streak alone.
 *
 * The failure streak is per-REMINDER, but the failures worth alerting on are
 * per-BACKEND: a logged-out backend fails every beat its SB owns, each with an
 * independent streak of 1, so each alerts. Myra owns two active beats whose
 * crons collide at 16:00Z daily — one cause, two alerts, two counts, landing in
 * the same Telegram chat in the same second. She found it on 2026-09-11.
 *
 * Collapsing on this key holds the module's promise — two messages per outage,
 * not two per beat — for every beat that shares a destination.
 */
function alertDestination(reminder: DueReminder): string | null {
  if (!reminder.sb_id) return null;
  return `${reminder.sb_id}|${reminder.delivery_channel}|${reminder.delivery_target}`;
}

// Singleton state
let cronTask: ReturnType<typeof cron.schedule> | null = null;
let supabase: SupabaseClient<Database> | null = null;
let heartbeatRunning = false;

// Store the onHeartbeat callback
let heartbeatCallback: (() => Promise<void>) | null = null;

/**
 * Liveness of the scheduler itself, as opposed to the delivery it schedules.
 *
 * Every alerting path in this module hangs off a delivery ATTEMPT: a beat runs,
 * the callback fails, a failure row lands, the streak crosses one, somebody is
 * told. A tick that never happens attempts nothing, so it writes no row, moves
 * no streak, and escalates to nobody. It is an absence, and absences were
 * invisible here until 2026-09-18.
 *
 * What that cost, measured over the 64 hours of log retained at the time:
 * 39 of 771 expected five-minute ticks never ran (5.1%), in nine separate
 * outages, the longest 50 minutes. Every one of them fell inside a window where
 * the host was asleep — `pmset -g log` accounts for all 39 with zero residual,
 * and the machine was asleep for 5.2% of the span against 5.1% of slots missed.
 * The process was never restarted and `/health` was correct throughout: this is
 * not a crash, and looking for a bug inside the process finds nothing, because
 * the process was suspended along with everything else on the machine. On a
 * laptop, heartbeat coverage is laptop uptime, and nothing reported the
 * difference.
 *
 * Reminders themselves survive it — the due query has no lower bound, so an
 * overdue beat is picked up by whatever tick runs next. They arrive late, not
 * never. The exception is a recurring beat, which carries a single
 * `next_run_at`: several occurrences slept through collapse into one late
 * delivery.
 */
let lastTickAt: Date | null = null;
let lastTickCompletedAt: Date | null = null;
let lastMissedTickAt: Date | null = null;
let missedTickCount = 0;

/**
 * What the scheduler has and has not done, for anything that needs to notice a
 * tick that did not happen.
 *
 * Exposed on `/health` because that is the only place it can do its job. The
 * failure mode is the process being unable to run its own code, so a check that
 * has to run inside the process cannot report it — a stale `lastTickAt` read
 * from outside can.
 *
 * TWO TIMESTAMPS, BECAUSE THERE ARE TWO WAYS TO GO QUIET. `lastTickAt` is the
 * scheduler firing; `lastTickCompletedAt` is the work finishing. A suspended
 * host freezes both. A tick wedged on a hung await freezes only the second,
 * while the overlap guard turns every subsequent fire into a `debug`-level skip
 * — which is the same invisible absence wearing different clothes, and reading
 * `lastTickAt` alone would call it healthy. A widening distance between them is
 * the signal.
 */
export function getHeartbeatTickHealth(): {
  lastTickAt: string | null;
  lastTickCompletedAt: string | null;
  lastMissedTickAt: string | null;
  missedTickCount: number;
  sinceLastTickMs: number | null;
  sinceLastCompletedTickMs: number | null;
} {
  return {
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastTickCompletedAt: lastTickCompletedAt?.toISOString() ?? null,
    lastMissedTickAt: lastMissedTickAt?.toISOString() ?? null,
    missedTickCount,
    sinceLastTickMs: lastTickAt ? Date.now() - lastTickAt.getTime() : null,
    sinceLastCompletedTickMs: lastTickCompletedAt
      ? Date.now() - lastTickCompletedAt.getTime()
      : null,
  };
}

/**
 * Initialize the heartbeat service
 */
export function initHeartbeatService(config: HeartbeatConfig = {}): void {
  // Guard: stop any existing cron before creating a new one (prevents leaked tasks on hot reload)
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.warn('Stopped existing heartbeat cron before re-initializing');
  }

  const {
    interval = '*/5 * * * *', // Every 5 minutes
    enableLocalCron = process.env.NODE_ENV !== 'production',
    onHeartbeat,
  } = config;

  heartbeatCallback = onHeartbeat || null;

  // Initialize typed Supabase client
  supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

  // A fresh scheduler has not missed anything yet, and must not inherit the
  // previous one's gap: re-init is a new process's worth of history.
  lastTickAt = null;
  lastTickCompletedAt = null;
  lastMissedTickAt = null;
  missedTickCount = 0;

  if (enableLocalCron) {
    logger.info('Starting local heartbeat cron scheduler', { interval });

    cronTask = cron.schedule(interval, async () => {
      lastTickAt = new Date();
      if (heartbeatRunning) {
        logger.debug('Heartbeat tick skipped — previous tick still running');
        return;
      }
      heartbeatRunning = true;
      try {
        if (heartbeatCallback) {
          await heartbeatCallback();
        }
      } catch (error) {
        logger.error('Heartbeat cron error:', error);
      } finally {
        heartbeatRunning = false;
        lastTickCompletedAt = new Date();
      }
    });

    /**
     * node-cron already knows when a tick was missed. It compares the slot it
     * expected against the clock every time its own timer fires late, and for
     * each slot it skipped it warns and advances. We were discarding that:
     * node-cron's logger is its own, `console.warn` only, so the one component
     * in the system that noticed was writing to a terminal and reaching no
     * durable surface. Grepping `~/.ink/logs/combined.log` for `missed
     * execution` returned 0 against 732 for `Heartbeat tick`.
     *
     * THE EVENT, NOT THE OPTION, AND THE DIFFERENCE IS SILENT. The runner takes
     * an `onMissedExecution` hook, but it is not reachable from here:
     * `schedule()` accepts `TaskOptions`, which does not declare it, and
     * `InlineScheduledTask` copies four keys (`timezone`, `noOverlap`,
     * `maxExecutions`, `maxRandomDelay`) into its `RunnerOptions` by name. A
     * hook passed to `schedule()` is dropped without complaint — the wire would
     * be dead and a test against a mocked `cron.schedule` would still pass,
     * because asserting we passed an argument is not asserting anybody calls
     * it. The task wires that hook to `execution:missed` on its own emitter,
     * and that event is public, typed, and actually fires.
     *
     * The event's date is deliberately not read. The runner advances its
     * pointer BEFORE invoking the hook, so the date handed over is the next
     * match after the missed one, and the last call of a burst reports a slot
     * still in the future. `lastTickAt` is ours and is not off by one.
     */
    cronTask.on('execution:missed', () => {
      const detectedAt = new Date();
      missedTickCount += 1;
      lastMissedTickAt = detectedAt;
      logger.warn('Heartbeat tick missed — the scheduler did not run on schedule', {
        detectedAt: detectedAt.toISOString(),
        lastTickAt: lastTickAt?.toISOString() ?? null,
        sinceLastTickMs: lastTickAt ? detectedAt.getTime() - lastTickAt.getTime() : null,
        missedTickCount,
        // The overwhelmingly likely cause on a laptop, and the one worth ruling
        // in or out first: check `pmset -g log` for a Sleep spanning the gap.
        likelyCause: 'host suspended, blocking IO, or CPU starvation',
      });
    });

    cronTask.start();
    logger.info('Heartbeat service started (local cron mode)');
  } else {
    logger.info('Heartbeat service initialized (cloud mode - waiting for pg_cron triggers)');
  }
}

/**
 * Stop the heartbeat service
 */
export function stopHeartbeatService(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info('Heartbeat service stopped');
  }
}

/**
 * What a delivery attempt actually did.
 *
 * A bare boolean was the whole reporting surface until 2026-09-11, and it is
 * why eight consecutive failed heartbeats produced exactly as much noise as
 * zero: the callback knew the backend was logged out, `false` could not carry
 * that, and the recorded reason was the literal string
 * "Delivery callback returned false". The error is the only part of a failed
 * beat worth keeping — carry it.
 *
 * Three states, not two. `false` conflated "the beat did not run" with "there
 * was deliberately nothing to do" — a strategy watchdog cancels itself when its
 * group completes and returns false, which is correct behaviour and used to
 * read as an outage. A skipped beat is not a failure: it does not escalate, it
 * does not alert, and it does not touch the failure streak.
 */
export type HeartbeatDeliveryOutcome =
  | { status: 'delivered' }
  /** The failure as the delivery path saw it. Recorded and escalated verbatim. */
  | { status: 'failed'; error?: string }
  /** A deliberate no-op. Recorded for the trail, reported to nobody. */
  | { status: 'skipped'; reason: string };

/** Callbacks may still return a bare boolean; it means "no detail available". */
export type HeartbeatDeliverResult = boolean | HeartbeatDeliveryOutcome;

/**
 * What else this run already said to the same place, and which outage we are
 * talking about.
 *
 * `destinationAlreadyAlerted` means a sibling beat — same SB, same channel,
 * same address — has already SUCCESSFULLY produced this run's outage alert or
 * all-clear. Successfully is the operative word: an attempted-but-failed send
 * does not claim the destination, or one dead send would silence every sibling.
 * The durable per-reminder record is still written either way; it is only the
 * unsolicited message to the human that collapses.
 *
 * `episodeKey` identifies the outage itself, so "have we already told them
 * about THIS one" is answerable across beats and across restarts. It is a uuid
 * minted on the first failure of an episode and read back from
 * `heartbeat_notifications` on every beat after that, shared by the outage
 * notice and the recovery notice that closes it.
 *
 * It used to be derived from `reminder_history` — the timestamp of the oldest
 * failure in the current run — and that drifted between the first beat of an
 * outage (which had no prior row and fell back to an application timestamp) and
 * the second (which read the first's `triggered_at` from the database). Two
 * ordinary beats produced two keys and two alarms for one outage. An identity
 * has to be assigned once, not recomputed from a moving window.
 */
export interface HeartbeatEscalationContext {
  destinationAlreadyAlerted: boolean;
  episodeKey: string;
  destination: string | null;
}

/**
 * What a hook reports back.
 *
 * `alerted` must mean a notice actually reached the human, not that one was
 * attempted. It is what decides whether the destination is claimed for the rest
 * of the run, and treating an attempt as an outcome here is precisely the defect
 * that made a single failed send silence every subsequent beat.
 */
export interface HeartbeatNoticeResult {
  alerted: boolean;
}

/**
 * What `reminder_history` says about the beats leading up to this one.
 *
 * The count is NOT an identity. It once carried the timestamp the run began and
 * the escalation path used that as the episode key; identity is minted and
 * stored by `heartbeat-notification-store` now, because a value recomputed from
 * a bounded history window changed between the first and second beat of every
 * outage.
 *
 * The `boundary` is a different thing and is not identity either: it is the
 * evidence that separates one run from the next. The notification store cannot
 * derive it, because every record the store could consult is one the store
 * writes — and the run worth surviving is the one where those writes failed.
 * `reminder_history` is written here instead, so a failing notification store
 * cannot corrupt it.
 */
interface FailureStreak {
  streak: number;
  boundary: EpisodeBoundary;
}

export type HeartbeatFailureHook = (
  reminder: DueReminder,
  error: string,
  consecutive: number,
  context: HeartbeatEscalationContext
) => Promise<HeartbeatNoticeResult | void>;

export type HeartbeatRecoveryHook = (
  reminder: DueReminder,
  failedBeats: number,
  context: HeartbeatEscalationContext
) => Promise<HeartbeatNoticeResult | void>;

function normalizeDeliveryOutcome(result: HeartbeatDeliverResult): HeartbeatDeliveryOutcome {
  if (typeof result !== 'boolean') return result;
  return result ? { status: 'delivered' } : { status: 'failed' };
}

/**
 * Process heartbeat - query due reminders and deliver via callback.
 *
 * The `deliver` callback is how the caller wakes the agent. Typically this
 * calls sessionHost.handleMessage() so the agent receives the reminder
 * through the same path as all other triggers.
 *
 * If no callback is provided, reminders are still queried and logged
 * but not delivered (useful for dry runs or external HTTP triggers).
 *
 * `onFailure` is the escalation hook. Heartbeats never enter the agent
 * gateway — `deliverReminderViaSession` calls sessionService.handleMessage()
 * directly — so the `trigger:error` → `[TriggerFailure]` machinery that
 * reports every OTHER kind of failed delivery has no path to a failed beat.
 * This is that path.
 *
 * `onRecovery` is its other half. An alert with no resolution is its own kind
 * of noise: the human is left holding a failure notice and has to ask the SB
 * whether it is back — and if it is not back, it cannot answer. So an outage
 * is exactly two messages, one at each edge.
 *
 * Both hooks receive the consecutive-failure count, derived from
 * `reminder_history` rather than process memory. It has to be durable: it is
 * the deduplication key for the direct alert, and a process-local counter
 * would re-alert on every server restart — which is precisely when a monitor
 * is most likely to be failing.
 */
export async function processHeartbeat(
  deliver?: (reminder: DueReminder) => Promise<HeartbeatDeliverResult>,
  onFailure?: HeartbeatFailureHook,
  onRecovery?: HeartbeatRecoveryHook
): Promise<{
  processed: number;
  delivered: number;
  failed: number;
  skipped: number;
}> {
  if (!supabase) {
    supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  const stats = { processed: 0, delivered: 0, failed: 0, skipped: 0 };
  const now = new Date().toISOString();

  logger.debug('Processing heartbeat', { timestamp: now });

  // Fetch due reminders
  const { data: dueReminders, error } = await supabase
    .from('scheduled_reminders')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', now)
    .order('next_run_at', { ascending: true })
    .limit(50); // Process in batches

  if (error) {
    logger.error('Failed to fetch due reminders:', error);
    throw error;
  }

  if (!dueReminders || dueReminders.length === 0) {
    logger.debug('No due reminders found');
    return stats;
  }

  logger.info(`Found ${dueReminders.length} due reminders`);

  // Destinations already told about an outage — or an all-clear — in THIS run.
  // Scoped to the run rather than to a clock window because "the same tick" is
  // exactly the collision being collapsed, and a duration would be a guess
  // about how long a tick takes. Beats far enough apart to land in different
  // runs still alert separately, and their own durable streak is what stops
  // them repeating.
  const alertedThisRun = new Set<string>();
  const recoveredThisRun = new Set<string>();

  /**
   * Whether this destination has already been told, WITHOUT claiming it.
   *
   * Peek and claim are separate because the claim has to wait for the send to
   * succeed. The original single `claimDestination` added the key before the
   * hook ran — so if the first beat's send failed, it had still claimed the
   * destination and silenced its sibling, and no alert reached anyone. An
   * attempt is not an outcome.
   */
  const destinationAlreadyTold = (seen: Set<string>, reminder: DueReminder): boolean => {
    const destination = alertDestination(reminder);
    if (!destination) return false;
    return seen.has(destination);
  };

  /** Claim the destination — only ever called after a notice actually landed. */
  const markDestinationTold = (seen: Set<string>, reminder: DueReminder): void => {
    const destination = alertDestination(reminder);
    if (destination) seen.add(destination);
  };

  // Process each reminder
  for (const reminder of dueReminders as DueReminder[]) {
    stats.processed++;

    try {
      // Check if user is in quiet hours
      const isQuiet = await isInQuietHours(reminder.user_id);
      if (isQuiet) {
        // `info`, not `debug`. Debug is not persisted to ~/.ink/logs, so this
        // deferral left no trace at all: a reminder due at 07:30 and delivered
        // at 08:06 looked from the outside like scheduler lag, and got
        // diagnosed as lag twice (2026-08-31, 2026-09-02). One line per held
        // reminder is cheap, and it is the difference between a deferral you
        // can see and a mystery you re-derive from tick timings.
        logger.info('Reminder held — user in quiet hours', {
          reminderId: reminder.id,
          dueAt: reminder.next_run_at,
        });
        stats.skipped++;
        continue;
      }

      // Atomically claim the reminder BEFORE delivery. The claim advances
      // next_run_at (or completes the reminder) only if the row still holds the
      // next_run_at we fetched — a compare-and-swap. This gives at-most-once
      // delivery two ways: (1) within one process, it stops the next tick from
      // re-picking a still-running reminder; (2) across processes, it stops
      // OVERLAPPING server incarnations (e.g. a tsx-watch reload that hasn't
      // reaped the old server yet) from both delivering the same beat. Only the
      // caller that wins the CAS delivers; the loser skips silently. Missing one
      // beat is far better than firing a heartbeat 2-3x.
      const claimed = await claimReminderForDelivery(reminder);
      if (!claimed) {
        logger.info('Reminder already claimed by another instance — skipping duplicate', {
          reminderId: reminder.id,
          nextRunAt: reminder.next_run_at,
        });
        stats.skipped++;
        continue;
      }

      // Deliver via caller-provided callback
      let outcome: HeartbeatDeliveryOutcome;
      if (deliver) {
        outcome = normalizeDeliveryOutcome(await deliver(reminder));
      } else {
        logger.warn(`No deliver callback for reminder ${reminder.id} - skipping`);
        outcome = { status: 'failed', error: 'no deliver callback registered' };
      }

      // Read the streak BEFORE recording this attempt, so it describes the run
      // of beats leading up to now. Recording first would make every failure
      // look like at least its own predecessor.
      const history: FailureStreak =
        outcome.status === 'skipped'
          ? { streak: 0, boundary: { kind: 'unknown' } }
          : await readBeatHistory(reminder.id);
      const priorFailures = history.streak;

      if (outcome.status === 'delivered') {
        stats.delivered++;
        await recordDeliveryAttempt(reminder.id, 'delivered');
        if (priorFailures > 0) {
          const alerted = await announceRecovery(
            reminder,
            priorFailures,
            onRecovery,
            destinationAlreadyTold(recoveredThisRun, reminder),
            // The episode that just ended, read back from the store so it is
            // the same key the outage notice used. The boundary is the healthy
            // beat BEFORE the outage, because `history` was read before this
            // beat's own delivered row was written — so it validates the
            // episode rather than invalidating it.
            await resolveEpisodeKey(reminder.id, history.boundary),
            alertDestination(reminder)
          );
          if (alerted) markDestinationTold(recoveredThisRun, reminder);
        } else {
          // A recovery notice whose send failed has no edge to fire on again:
          // once the beat is healthy the streak is zero, so the branch above
          // never runs. This is its retry. Without it, round two's "a failed
          // recovery send has no triggering edge on the next healthy beat"
          // stays true no matter how durable the record is.
          await retryOwedRecovery(reminder, onRecovery, recoveredThisRun);
        }
      } else if (outcome.status === 'skipped') {
        // Deliberate no-op — a self-cancelling watchdog on a finished group,
        // not a monitor that stopped working. Recorded, never escalated.
        logger.info('[Heartbeat] Delivery skipped (no action needed)', {
          reminderId: reminder.id,
          title: reminder.title,
          reason: outcome.reason,
        });
        stats.skipped++;
        await recordDeliveryAttempt(reminder.id, 'skipped', outcome.reason);
      } else {
        stats.failed++;
        const reason = outcome.error || 'delivery reported failure with no detail';
        // error, not info. A beat that did not run is the monitor failing,
        // and it belongs in error.log where a failing monitor is looked for.
        logger.error('[Heartbeat] Delivery FAILED', {
          reminderId: reminder.id,
          title: reminder.title,
          sbId: reminder.sb_id,
          deliveryChannel: reminder.delivery_channel,
          error: reason,
        });
        await recordDeliveryAttempt(reminder.id, 'failed', reason);
        const alerted = await escalate(
          reminder,
          reason,
          priorFailures + 1,
          onFailure,
          destinationAlreadyTold(alertedThisRun, reminder),
          // The episode in progress, minted on its first failure and reused by
          // every beat after that — but only while it is provably part of THIS
          // run of failures. See `EpisodeBoundary`.
          await resolveEpisodeKey(reminder.id, history.boundary),
          alertDestination(reminder)
        );
        if (alerted) markDestinationTold(alertedThisRun, reminder);
      }
    } catch (error) {
      logger.error(`Failed to process reminder ${reminder.id}:`, error);
      stats.failed++;
      const reason = error instanceof Error ? error.message : 'Unknown error';
      const history = await readBeatHistory(reminder.id);
      await recordDeliveryAttempt(reminder.id, 'failed', reason);
      // A throw is exactly as silent as a false return — escalate both.
      const alerted = await escalate(
        reminder,
        reason,
        history.streak + 1,
        onFailure,
        destinationAlreadyTold(alertedThisRun, reminder),
        await resolveEpisodeKey(reminder.id, history.boundary),
        alertDestination(reminder)
      );
      if (alerted) markDestinationTold(alertedThisRun, reminder);
    }
  }

  // A tick with failures is not a routine completion. Logging the whole run at
  // info was the last place the twelve-hour outage could have surfaced and
  // did not.
  if (stats.failed > 0) {
    logger.error('Heartbeat processing complete WITH FAILURES', stats);
  } else {
    logger.info('Heartbeat processing complete', stats);
  }
  return stats;
}

/**
 * Report a failed beat to whoever can act on it.
 *
 * Never throws: escalation runs inside the per-reminder catch, and an
 * escalation that breaks the loop would take the remaining reminders down
 * with it — turning one silent failure into several.
 */
async function escalate(
  reminder: DueReminder,
  reason: string,
  consecutive: number,
  onFailure?: HeartbeatFailureHook,
  destinationAlreadyAlerted = false,
  episodeKey = new Date().toISOString(),
  destination: string | null = null
): Promise<boolean> {
  if (!onFailure) return false;
  try {
    const result = await onFailure(reminder, reason, consecutive, {
      destinationAlreadyAlerted,
      episodeKey,
      destination,
    });
    return typeof result === 'object' && result !== null && result.alerted === true;
  } catch (err) {
    logger.error('[Heartbeat] Escalation itself failed', {
      reminderId: reminder.id,
      originalError: reason,
      escalationError: err instanceof Error ? err.message : String(err),
    });
    // A hook that threw did not alert anyone, so the destination stays unclaimed
    // and a sibling beat is still free to try.
    return false;
  }
}

/**
 * Report that a beat is running again, closing out an earlier outage alert.
 *
 * Same never-throws contract as `escalate`: a recovery notice that breaks the
 * loop would stop the remaining reminders from being delivered, which is a
 * worse outcome than a missing all-clear.
 */
async function announceRecovery(
  reminder: DueReminder,
  failedBeats: number,
  onRecovery?: HeartbeatRecoveryHook,
  destinationAlreadyAlerted = false,
  episodeKey = new Date().toISOString(),
  destination: string | null = null
): Promise<boolean> {
  logger.info('[Heartbeat] Recovered after failures', {
    reminderId: reminder.id,
    title: reminder.title,
    failedBeats,
  });
  if (!onRecovery) return false;
  try {
    const result = await onRecovery(reminder, failedBeats, {
      destinationAlreadyAlerted,
      episodeKey,
      destination,
    });
    return typeof result === 'object' && result !== null && result.alerted === true;
  } catch (err) {
    logger.error('[Heartbeat] Recovery notice itself failed', {
      reminderId: reminder.id,
      failedBeats,
      recoveryError: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The episode this reminder's current outage belongs to.
 *
 * Delegates to the store, which mints a uuid on an episode's first failure and
 * returns that same uuid on every beat afterwards. Falls back to a fresh uuid
 * when there is no database to ask, which fails toward a duplicate alert rather
 * than toward attaching a beat to an episode nobody can verify.
 *
 * `boundary` passes down what only the caller knows: where the current run of
 * failures begins, read from `reminder_history` before this beat was recorded.
 * The store cannot work that out for itself — every record it could consult is
 * one it writes, and the run worth surviving is the one where those writes were
 * failing.
 */
async function resolveEpisodeKey(reminderId: string, boundary: EpisodeBoundary): Promise<string> {
  if (!supabase) return randomUUID();
  return createHeartbeatNotificationStore(supabase).openEpisode(reminderId, boundary);
}

/**
 * Send an all-clear that is still owed from an earlier episode.
 *
 * A recovery notice has one natural trigger: the beat that goes from failing to
 * healthy. If its send fails there, the streak is already zero by the next beat,
 * so that edge never comes round again and the human is left holding an outage
 * alert for something that recovered hours ago. This sweep runs on healthy beats
 * that are NOT a recovery edge and gives the owed notice another go.
 *
 * The debt is read from the OUTAGE row — an episode announced and not yet
 * closed — rather than from a pending recovery row. That distinction is the
 * whole point: the case this has to survive is the one where the recovery row
 * was never written, because the store was failing at exactly the moment the
 * recovery notice was owed.
 */
async function retryOwedRecovery(
  reminder: DueReminder,
  onRecovery: HeartbeatRecoveryHook | undefined,
  recoveredThisRun: Set<string>
): Promise<void> {
  if (!onRecovery || !supabase) return;

  try {
    const store = createHeartbeatNotificationStore(supabase);
    const owed = await store.findOwedRecovery(reminder.id);
    if (!owed) return;

    const destination = alertDestination(reminder);
    const alreadyTold = destination ? recoveredThisRun.has(destination) : false;

    logger.info('[Heartbeat] Sending an all-clear that was owed from an earlier beat', {
      reminderId: reminder.id,
      episodeKey: owed.episodeKey,
      priorAttempts: owed.attempts,
    });

    const alerted = await announceRecovery(
      reminder,
      owed.failedBeats,
      onRecovery,
      alreadyTold,
      owed.episodeKey,
      destination
    );
    if (alerted && destination) recoveredThisRun.add(destination);
  } catch (err) {
    // Never let the retry take down the beat it is describing.
    logger.warn('[Heartbeat] Owed-recovery retry threw', {
      reminderId: reminder.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * How many beats in a row have failed, counting back from the most recent.
 *
 * Derived from `reminder_history` rather than held in memory, because this
 * number is the deduplication key for the direct outage alert. A process-local
 * counter resets on restart, and a server restart is exactly the moment a
 * monitor is most likely to be broken — so an in-memory streak would re-alert
 * on every bounce and go quiet on the one that mattered.
 *
 * `skipped` and `pending` rows are excluded rather than treated as successes:
 * a watchdog that self-cancels mid-outage has not fixed anything, and should
 * not read as a recovery. The same exclusion is why the boundary is a DELIVERED
 * beat and not merely a non-failed one.
 *
 * This reads the COUNT only. The boundary used to come off the same walk — the
 * row it stopped on — which made the two share a window, and a window is a thing
 * that can be full. See `lastDeliveredBeat`.
 */
async function consecutiveFailureCount(reminderId: string): Promise<number> {
  if (!supabase) return 0;

  // Never let the streak lookup take down the beat it is describing, whether
  // it resolves with an error (PostgREST's usual shape) or throws (a transport
  // failure). An unknown streak reports as zero, which fails toward alerting
  // rather than toward silence — silence is the bug this path exists to fix.
  try {
    const { data, error } = await selectFailureStreakWindow(supabase, reminderId);

    if (error) {
      logger.warn('[Heartbeat] Could not read failure streak', {
        reminderId,
        error: error.message,
      });
      return 0;
    }

    if (!Array.isArray(data)) return 0;

    // Rows arrive newest first; count back until a success or the end of the
    // window. Saturating at the window is fine for a count: the number is only
    // ever reported as "this many beats have failed", and an outage long enough
    // to fill the window alerted on its first beat, many beats ago.
    let streak = 0;
    for (const row of data as { status: string }[]) {
      if (row?.status !== 'failed') break;
      streak++;
    }
    return streak;
  } catch (err) {
    logger.warn('[Heartbeat] Failure streak lookup threw', {
      reminderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * The most recent DELIVERED beat: where the run of failures happening now began.
 *
 * Its own query, and that is the whole point of it. This used to be a by-product
 * of the streak walk — the row that walk stopped on — which quietly gave the
 * boundary the same 50-row window the count has. A window bounds a count
 * harmlessly and bounds a boundary catastrophically: after fifty failed beats
 * the healthy beat that separates this outage from the last one falls off the
 * end, the walk reports `none`, and `none` means "reuse the open episode". The
 * episode it then reuses is a finished one whose alert was already delivered, so
 * every retry is suppressed — the original silent-outage bug, reached by a
 * longer road. An outage of exactly the kind that most needs alerting (long) is
 * the one that would have been silenced.
 *
 * A status filter with LIMIT 1 has no such window. It returns the newest
 * delivered row if one exists, however many failures are stacked on top of it.
 *
 * The three answers are kept apart because two of them look alike and must not
 * behave alike — see `EpisodeBoundary`:
 *
 * - a row with a timestamp -> `healthy-beat`, the separator.
 * - no rows at all         -> `none`. Established absence, not truncation: this
 *                             reminder has never delivered, so there is no
 *                             earlier run to be confused with and the open
 *                             episode is still this one.
 * - unreadable, or a delivered row with no timestamp -> `unknown`. Nothing
 *                             verifiable, so nothing may be reused. Costs a
 *                             duplicate alert, never silence.
 */
async function lastDeliveredBeat(reminderId: string): Promise<EpisodeBoundary> {
  // No database is not "no healthy beat" — it is no evidence at all.
  if (!supabase) return { kind: 'unknown' };

  try {
    const { data, error } = await selectLastDeliveredBeat(supabase, reminderId);

    if (error) {
      logger.warn('[Heartbeat] Could not read the last delivered beat', {
        reminderId,
        error: error.message,
      });
      return { kind: 'unknown' };
    }

    if (!Array.isArray(data)) return { kind: 'unknown' };
    if (data.length === 0) return { kind: 'none' };

    const at = (data[0] as { triggered_at: string | null } | undefined)?.triggered_at;
    return at ? { kind: 'healthy-beat', at } : { kind: 'unknown' };
  } catch (err) {
    logger.warn('[Heartbeat] Last-delivered-beat lookup threw', {
      reminderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unknown' };
  }
}

/**
 * What the beats before this one did: how many failed in a row, and where that
 * run begins.
 *
 * Two reads, in this order deliberately. A delivered row landing between them
 * makes the boundary NEWER than the streak accounts for, which refuses an
 * episode that is still live and costs one duplicate alert. Reversed, the same
 * interleaving would hand back a boundary older than reality and accept an
 * episode that has already ended — which is silence, and silence is the bug.
 */
async function readBeatHistory(reminderId: string): Promise<FailureStreak> {
  const streak = await consecutiveFailureCount(reminderId);
  const boundary = await lastDeliveredBeat(reminderId);
  return { streak, boundary };
}

/**
 * Check if user is in quiet hours
 */
async function isInQuietHours(userId: string): Promise<boolean> {
  if (!supabase) return false;

  const { data: state } = await supabase
    .from('heartbeat_state')
    .select('quiet_start, quiet_end, timezone')
    .eq('user_id', userId)
    .single();

  if (!state?.quiet_start || !state?.quiet_end) {
    return false;
  }

  // One predicate, shared with the creation-time warning in reminder-handlers.
  // If these two ever computed the window separately they would eventually
  // disagree, and a warning that disagrees with the behaviour it describes is
  // worse than no warning.
  //
  // It also fixes the timezone: this used to read `now.getHours()` — the
  // SERVER's clock — while selecting the user's `timezone` column and never
  // using it, under a comment conceding "timezone handling can be enhanced".
  // Correct only while the server runs on the user's own machine.
  return isWithinQuietHours(new Date(), {
    start: state.quiet_start,
    end: state.quiet_end,
    timezone: state.timezone,
  });
}

/**
 * Get user's timezone from database
 */
async function getUserTimezone(userId: string): Promise<string> {
  if (!supabase) return 'UTC';

  const { data } = await supabase.from('users').select('timezone').eq('id', userId).single();

  return data?.timezone || 'UTC';
}

/**
 * Atomically claim a due reminder for delivery.
 *
 * Advances next_run_at (recurring) or marks it completed (one-time / max-runs),
 * but ONLY if the row's next_run_at still equals the value we fetched. Because
 * PostgreSQL applies the matching UPDATE atomically, exactly one caller can win
 * this compare-and-swap even if several fire it concurrently — the rest match
 * zero rows. Returns true if THIS caller won the claim and should deliver.
 *
 * This is the cross-process at-most-once guard: overlapping server incarnations
 * that each run processHeartbeat on the same tick will all fetch the same due
 * reminder, but only the first to land its CAS advances the row; the others see
 * the already-changed row, match nothing, and skip delivery.
 */
async function claimReminderForDelivery(reminder: DueReminder): Promise<boolean> {
  if (!supabase) return false;

  const now = new Date().toISOString();
  const newRunCount = reminder.run_count + 1;

  // Check if this is a one-time reminder or has reached max runs
  const isCompleted =
    !reminder.cron_expression || (reminder.max_runs !== null && newRunCount >= reminder.max_runs);

  const update: Database['public']['Tables']['scheduled_reminders']['Update'] = isCompleted
    ? { status: 'completed', last_run_at: now, run_count: newRunCount }
    : {
        last_run_at: now,
        run_count: newRunCount,
        next_run_at: calculateNextRun(
          reminder.cron_expression!,
          new Date(),
          await getUserTimezone(reminder.user_id)
        ).toISOString(),
      };

  // CAS: guard on id + next_run_at + status='active'. The next_run_at guard
  // fails the update for a loser whose fetched value was already advanced by a
  // recurring winner. But a COMPLETING claim (one-time / final max_runs) leaves
  // next_run_at unchanged and only flips status→completed — so the status guard
  // is what fails the loser there. Guarding both closes the race for every case:
  // whichever column the winner mutated, the loser's stale predicate no longer
  // matches. select('id') returns the affected rows so we can tell a win (1 row)
  // from a loss (0 rows).
  const { data, error } = await supabase
    .from('scheduled_reminders')
    .update(update)
    .eq('id', reminder.id)
    .eq('next_run_at', reminder.next_run_at)
    .eq('status', 'active')
    .select('id');

  if (error) {
    logger.error(`Failed to claim reminder ${reminder.id}:`, error);
    return false;
  }

  return Array.isArray(data) && data.length === 1;
}

/**
 * Record a delivery attempt in history
 */
async function recordDeliveryAttempt(
  reminderId: string,
  status: 'pending' | 'delivered' | 'failed' | 'skipped',
  errorMessage?: string
): Promise<void> {
  if (!supabase) return;

  await supabase.from('reminder_history').insert({
    reminder_id: reminderId,
    status,
    error_message: errorMessage || null,
    delivered_at: status === 'delivered' ? new Date().toISOString() : null,
  });
}

/**
 * Calculate next run time from a cron expression.
 * Uses cron-parser for correct handling of all standard cron patterns
 * including ranges (16-23), lists (0-7), and step values.
 *
 * @param cronExpr - Standard cron expression (interpreted in the given timezone)
 * @param fromTime - Calculate next run after this time
 * @param timezone - IANA timezone (e.g., 'America/Los_Angeles'). Defaults to UTC.
 */
function calculateNextRun(cronExpr: string, fromTime: Date, timezone?: string): Date {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: fromTime,
    tz: timezone || 'UTC',
  });
  return interval.next().toDate();
}

/**
 * Create a new reminder
 */
export async function createReminder(params: {
  userId: string;
  title: string;
  description?: string;
  deliveryChannel: string;
  deliveryTarget: string;
  cronExpression?: string;
  runAt?: Date;
  maxRuns?: number;
  sbId?: string;
  studioHint?: string;
  metadata?: Json;
}): Promise<{ id: string } | null> {
  if (!supabase) {
    supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  // Get user's timezone for cron interpretation
  const userTimezone = await getUserTimezone(params.userId);

  const nextRunAt =
    params.runAt ||
    (params.cronExpression
      ? calculateNextRun(params.cronExpression, new Date(), userTimezone)
      : new Date());

  const { data, error } = await supabase
    .from('scheduled_reminders')
    .insert({
      user_id: params.userId,
      title: params.title,
      description: params.description || null,
      delivery_channel: params.deliveryChannel,
      delivery_target: params.deliveryTarget,
      cron_expression: params.cronExpression || null,
      next_run_at: nextRunAt.toISOString(),
      max_runs: params.maxRuns || null,
      sb_id: params.sbId || null,
      studio_hint: params.studioHint || null,
      metadata: params.metadata ?? {},
    })
    .select('id')
    .single();

  if (error) {
    logger.error('Failed to create reminder:', error);
    return null;
  }

  logger.info('Created reminder', { id: data.id, title: params.title });
  return { id: data.id };
}

/**
 * Ensure default reminders exist for a newly created identity.
 * Idempotent: checks metadata->>reminderType to avoid duplicates.
 * Fails gracefully: logs warnings but never throws.
 */
export async function ensureDefaultReminders(params: {
  userId: string;
  sbId: string;
  sbSlug: string;
  deliveryChannel?: string;
  deliveryTarget?: string;
}): Promise<void> {
  try {
    if (!supabase) {
      supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    }

    // Resolve delivery channel if not pre-resolved by caller
    let deliveryChannel = params.deliveryChannel;
    let deliveryTarget = params.deliveryTarget;

    if (!deliveryChannel || !deliveryTarget) {
      const { data: user } = await supabase
        .from('users')
        .select('telegram_id, whatsapp_id')
        .eq('id', params.userId)
        .single();

      if (!user) {
        logger.warn('ensureDefaultReminders: user not found, skipping', {
          userId: params.userId,
        });
        return;
      }

      if (user.telegram_id) {
        deliveryChannel = 'telegram';
        deliveryTarget = user.telegram_id.toString();
      } else if (user.whatsapp_id) {
        deliveryChannel = 'whatsapp';
        deliveryTarget = user.whatsapp_id;
      } else {
        logger.warn('ensureDefaultReminders: no delivery channel available, skipping', {
          userId: params.userId,
          sbSlug: params.sbSlug,
        });
        return;
      }
    }

    // Idempotency: one daily check-in per SB. Sep 10 2026 (Myra): an unscoped
    // twin row (version 1) was handed in as `sbId`, so a check scoped to that
    // row looked for a reminder bound to something seconds old, found none by
    // construction, and minted a duplicate of the agent's real check-in.
    //
    // "Related" rows are: this row; any UNSCOPED row of the same agent (a
    // twin, or a legacy row this one supersedes); and, when this row is itself
    // unscoped, every row of the agent, because a twin shadows them all.
    // Scoped siblings in other workspaces are distinct SBs and keep their own
    // check-in (Lumen, PR #595).
    const { data: identityRows, error: identityError } = await supabase
      .from('agent_identities')
      .select('id, workspace_id')
      .eq('user_id', params.userId)
      .eq('agent_id', params.sbSlug);
    if (identityError) {
      // Fail closed: without the candidate set we cannot prove there is no
      // check-in, and a duplicate reports to no one (Lumen, PR #595).
      logger.warn('ensureDefaultReminders: identity lookup failed, skipping seed', {
        sbSlug: params.sbSlug,
        sbId: params.sbId,
        error: identityError.message,
      });
      return;
    }
    const agentRows = identityRows ?? [];
    const thisRow = agentRows.find((row) => row.id === params.sbId);
    const scopedRows = agentRows.filter((row) => Boolean(row.workspace_id));
    const unscopedIds = agentRows.filter((row) => !row.workspace_id).map((row) => row.id);
    let relatedIds: string[];
    if (thisRow?.workspace_id) {
      // A scoped SB. An unscoped row can only be ITS twin when it is the only
      // scoped candidate; with siblings in other workspaces, whose twin it is
      // cannot be known here, so the SB is judged on its own UUID (Lumen).
      relatedIds = scopedRows.length === 1 ? unscopedIds : [];
    } else if (scopedRows.length > 1) {
      // An unscoped row alongside several scoped SBs: the same ambiguity the
      // identity resolver refuses. Seeding on a guess could either duplicate
      // or suppress a real check-in, so skip and say so.
      logger.warn(
        'ensureDefaultReminders: unscoped identity with several scoped siblings — ambiguous, skipping seed',
        { sbSlug: params.sbSlug, sbId: params.sbId, scopedRows: scopedRows.length }
      );
      return;
    } else {
      // Unscoped (or not yet visible): a twin shadows the single scoped row.
      relatedIds = agentRows.map((row) => row.id);
    }
    const candidateIds = Array.from(new Set([params.sbId, ...relatedIds]));
    const { data: existing } = await supabase
      .from('scheduled_reminders')
      .select('id, sb_id')
      .eq('user_id', params.userId)
      .in('sb_id', candidateIds)
      .in('status', ['active', 'paused'])
      .filter('metadata->>reminderType', 'eq', 'daily-checkin')
      .limit(1);

    if (existing && existing.length > 0) {
      logger.debug(
        'ensureDefaultReminders: daily-checkin already exists for this agent, skipping',
        {
          sbId: params.sbId,
          sbSlug: params.sbSlug,
          existingReminderId: existing[0].id,
          boundTo: existing[0].sb_id,
        }
      );
      return;
    }

    const result = await createReminder({
      userId: params.userId,
      title: 'Daily check-in',
      description: `Good morning! Time for your daily check-in with ${params.sbSlug}.`,
      deliveryChannel,
      deliveryTarget,
      cronExpression: '0 9 * * *',
      sbId: params.sbId,
      metadata: { autoCreated: true, reminderType: 'daily-checkin' },
    });

    if (result) {
      logger.info('ensureDefaultReminders: created daily check-in', {
        reminderId: result.id,
        sbId: params.sbId,
        sbSlug: params.sbSlug,
      });
    }
  } catch (error) {
    logger.error('ensureDefaultReminders: failed (non-fatal)', {
      error: error instanceof Error ? error.message : error,
      userId: params.userId,
      sbId: params.sbId,
    });
  }
}

/**
 * List reminders for a user
 */
export async function listReminders(userId: string, status?: string): Promise<DueReminder[]> {
  if (!supabase) {
    supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  let query = supabase
    .from('scheduled_reminders')
    .select('*')
    .eq('user_id', userId)
    .order('next_run_at', { ascending: true });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Failed to list reminders:', error);
    return [];
  }

  return (data || []) as DueReminder[];
}

/**
 * Cancel a reminder
 */
export async function cancelReminder(reminderId: string, userId: string): Promise<boolean> {
  if (!supabase) {
    supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  const { error } = await supabase
    .from('scheduled_reminders')
    .update({ status: 'completed' })
    .eq('id', reminderId)
    .eq('user_id', userId);

  if (error) {
    logger.error('Failed to cancel reminder:', error);
    return false;
  }

  return true;
}
