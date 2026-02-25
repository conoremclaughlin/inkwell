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
  identity_id: string | null;
  cron_expression: string | null;
  next_run_at: string;
  run_count: number;
  max_runs: number | null;
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

// Store the onHeartbeat callback
let heartbeatCallback: (() => Promise<void>) | null = null;

/**
 * Initialize the heartbeat service
 */
export function initHeartbeatService(config: HeartbeatConfig = {}): void {
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
      try {
        if (heartbeatCallback) {
          await heartbeatCallback();
        }
      } catch (error) {
        logger.error('Heartbeat cron error:', error);
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
 * Process heartbeat - query due reminders and deliver via callback.
 *
 * The `deliver` callback is how the caller wakes the agent. Typically this
 * calls sessionHost.handleMessage() so the agent receives the reminder
 * through the same path as all other triggers.
 *
 * If no callback is provided, reminders are still queried and logged
 * but not delivered (useful for dry runs or external HTTP triggers).
 */
export async function processHeartbeat(
  deliver?: (reminder: DueReminder) => Promise<boolean>
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
        logger.debug(`Skipping reminder ${reminder.id} - user in quiet hours`);
        stats.skipped++;
        continue;
      }

      // Deliver via caller-provided callback
      let delivered = false;
      if (deliver) {
        delivered = await deliver(reminder);
      } else {
        logger.warn(`No deliver callback for reminder ${reminder.id} - skipping`);
      }

      if (delivered) {
        stats.delivered++;
        await recordDeliveryAttempt(reminder.id, 'delivered');
        await updateReminderAfterDelivery(reminder);
      } else {
        stats.failed++;
        await recordDeliveryAttempt(reminder.id, 'failed', 'Delivery callback returned false');
      }
    } catch (error) {
      logger.error(`Failed to process reminder ${reminder.id}:`, error);
      stats.failed++;
      await recordDeliveryAttempt(
        reminder.id,
        'failed',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  logger.info('Heartbeat processing complete', stats);
  return stats;
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

  // Simple time comparison (timezone handling can be enhanced)
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const quietStart = state.quiet_start;
  const quietEnd = state.quiet_end;

  // Handle overnight quiet hours (e.g., 23:00 - 08:00)
  if (quietStart > quietEnd) {
    return currentTime >= quietStart || currentTime < quietEnd;
  }

  return currentTime >= quietStart && currentTime < quietEnd;
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
 * Update reminder after successful delivery
 */
async function updateReminderAfterDelivery(reminder: DueReminder): Promise<void> {
  if (!supabase) return;

  const now = new Date().toISOString();
  const newRunCount = reminder.run_count + 1;

  // Check if this is a one-time reminder or has reached max runs
  const isCompleted =
    !reminder.cron_expression || (reminder.max_runs !== null && newRunCount >= reminder.max_runs);

  if (isCompleted) {
    // Mark as completed
    await supabase
      .from('scheduled_reminders')
      .update({
        status: 'completed',
        last_run_at: now,
        run_count: newRunCount,
      })
      .eq('id', reminder.id);
  } else {
    // Calculate next run time in user's timezone
    const userTimezone = await getUserTimezone(reminder.user_id);
    const nextRun = calculateNextRun(reminder.cron_expression!, new Date(), userTimezone);

    await supabase
      .from('scheduled_reminders')
      .update({
        last_run_at: now,
        next_run_at: nextRun.toISOString(),
        run_count: newRunCount,
      })
      .eq('id', reminder.id);
  }
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
  identityId?: string;
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
      identity_id: params.identityId || null,
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
  identityId: string;
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

    // Idempotency: check if a daily-checkin already exists for this identity
    const { data: existing } = await supabase
      .from('scheduled_reminders')
      .select('id')
      .eq('user_id', params.userId)
      .eq('identity_id', params.identityId)
      .in('status', ['active', 'paused'])
      .filter('metadata->>reminderType', 'eq', 'daily-checkin')
      .limit(1);

    if (existing && existing.length > 0) {
      logger.debug('ensureDefaultReminders: daily-checkin already exists, skipping', {
        identityId: params.identityId,
        existingReminderId: existing[0].id,
      });
      return;
    }

    const result = await createReminder({
      userId: params.userId,
      title: 'Daily check-in',
      description: `Good morning! Time for your daily check-in with ${params.agentId}.`,
      deliveryChannel,
      deliveryTarget,
      cronExpression: '0 9 * * *',
      identityId: params.identityId,
      metadata: { autoCreated: true, reminderType: 'daily-checkin' },
    });

    if (result) {
      logger.info('ensureDefaultReminders: created daily check-in', {
        reminderId: result.id,
        identityId: params.identityId,
        agentId: params.agentId,
      });
    }
  } catch (error) {
    logger.error('ensureDefaultReminders: failed (non-fatal)', {
      error: error instanceof Error ? error.message : error,
      userId: params.userId,
      identityId: params.identityId,
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
