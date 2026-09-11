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
import { isWithinQuietHours } from './quiet-hours.js';
import { CronExpressionParser } from 'cron-parser';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
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

// Singleton state
let cronTask: ReturnType<typeof cron.schedule> | null = null;
let supabase: SupabaseClient<Database> | null = null;
let heartbeatRunning = false;

// Store the onHeartbeat callback
let heartbeatCallback: (() => Promise<void>) | null = null;

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

  if (enableLocalCron) {
    logger.info('Starting local heartbeat cron scheduler', { interval });

    cronTask = cron.schedule(interval, async () => {
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
      }
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
 */
export interface HeartbeatDeliveryOutcome {
  delivered: boolean;
  /** The failure as the delivery path saw it. Recorded and escalated verbatim. */
  error?: string;
}

/** Callbacks may still return a bare boolean; it means "no detail available". */
export type HeartbeatDeliverResult = boolean | HeartbeatDeliveryOutcome;

function normalizeDeliveryOutcome(result: HeartbeatDeliverResult): HeartbeatDeliveryOutcome {
  return typeof result === 'boolean' ? { delivered: result } : result;
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
 */
export async function processHeartbeat(
  deliver?: (reminder: DueReminder) => Promise<HeartbeatDeliverResult>,
  onFailure?: (reminder: DueReminder, error: string) => Promise<void>
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
      let outcome: HeartbeatDeliveryOutcome = { delivered: false };
      if (deliver) {
        outcome = normalizeDeliveryOutcome(await deliver(reminder));
      } else {
        logger.warn(`No deliver callback for reminder ${reminder.id} - skipping`);
        outcome = { delivered: false, error: 'no deliver callback registered' };
      }

      if (outcome.delivered) {
        stats.delivered++;
        await recordDeliveryAttempt(reminder.id, 'delivered');
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
        await escalate(reminder, reason, onFailure);
      }
    } catch (error) {
      logger.error(`Failed to process reminder ${reminder.id}:`, error);
      stats.failed++;
      const reason = error instanceof Error ? error.message : 'Unknown error';
      await recordDeliveryAttempt(reminder.id, 'failed', reason);
      // A throw is exactly as silent as a false return — escalate both.
      await escalate(reminder, reason, onFailure);
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
  onFailure?: (reminder: DueReminder, error: string) => Promise<void>
): Promise<void> {
  if (!onFailure) return;
  try {
    await onFailure(reminder, reason);
  } catch (err) {
    logger.error('[Heartbeat] Escalation itself failed', {
      reminderId: reminder.id,
      originalError: reason,
      escalationError: err instanceof Error ? err.message : String(err),
    });
  }
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
  agentId: string;
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
          agentId: params.agentId,
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
      .eq('agent_id', params.agentId);
    if (identityError) {
      // Fail closed: without the candidate set we cannot prove there is no
      // check-in, and a duplicate reports to no one (Lumen, PR #595).
      logger.warn('ensureDefaultReminders: identity lookup failed, skipping seed', {
        agentId: params.agentId,
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
        { agentId: params.agentId, sbId: params.sbId, scopedRows: scopedRows.length }
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
          agentId: params.agentId,
          existingReminderId: existing[0].id,
          boundTo: existing[0].sb_id,
        }
      );
      return;
    }

    const result = await createReminder({
      userId: params.userId,
      title: 'Daily check-in',
      description: `Good morning! Time for your daily check-in with ${params.agentId}.`,
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
        agentId: params.agentId,
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
