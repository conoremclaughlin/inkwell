/**
 * Heartbeat Service
 *
 * Manages scheduled reminders and periodic checks.
 * - In production: triggered by pg_cron via HTTP
 * - In development: uses node-cron as fallback
 */

import * as cron from 'node-cron';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { Database } from '../data/supabase/types.js';

// DueReminder is the subset of fields we need for processing
interface DueReminder {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  delivery_channel: string;
  delivery_target: string | null;
  cron_expression: string | null;
  next_run_at: string;
  run_count: number;
  max_runs: number | null;
}

interface DeliveryChannel {
  sendMessage: (target: string, message: string) => Promise<void>;
}

interface HeartbeatConfig {
  /** Cron expression for heartbeat interval (default: every 5 minutes) */
  interval?: string;
  /** Enable local cron scheduler */
  enableLocalCron?: boolean;
  /** Delivery channels */
  channels?: Record<string, DeliveryChannel>;
  /** Callback to run on each heartbeat (for inbox checking, etc.) */
  onHeartbeat?: () => Promise<void>;
}

// Singleton state
let cronTask: ReturnType<typeof cron.schedule> | null = null;
let supabase: SupabaseClient<Database> | null = null;
let deliveryChannels: Record<string, DeliveryChannel> = {};

/**
 * Initialize the heartbeat service
 */
// Store the onHeartbeat callback
let heartbeatCallback: (() => Promise<void>) | null = null;

export function initHeartbeatService(config: HeartbeatConfig = {}): void {
  const {
    interval = '*/5 * * * *', // Every 5 minutes
    enableLocalCron = process.env.NODE_ENV !== 'production',
    channels = {},
    onHeartbeat,
  } = config;

  // Store delivery channels and callback
  deliveryChannels = channels;
  heartbeatCallback = onHeartbeat || null;

  // Initialize typed Supabase client
  supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

  if (enableLocalCron) {
    logger.info('Starting local heartbeat cron scheduler', { interval });

    cronTask = cron.schedule(interval, async () => {
      try {
        await processHeartbeat();
        // Call the onHeartbeat callback if provided
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
 * Register a delivery channel
 */
export function registerDeliveryChannel(name: string, channel: DeliveryChannel): void {
  deliveryChannels[name] = channel;
  logger.info(`Registered delivery channel: ${name}`);
}

/**
 * Process heartbeat - called by cron (local or pg_cron via API)
 */
export async function processHeartbeat(): Promise<{
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

      // Deliver the reminder
      const delivered = await deliverReminder(reminder);

      if (delivered) {
        stats.delivered++;

        // Update reminder state
        await updateReminderAfterDelivery(reminder);
      } else {
        stats.failed++;
      }
    } catch (error) {
      logger.error(`Failed to process reminder ${reminder.id}:`, error);
      stats.failed++;

      // Record failure in history
      await recordDeliveryAttempt(reminder.id, 'failed', error instanceof Error ? error.message : 'Unknown error');
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
 * Deliver a reminder via the appropriate channel
 */
async function deliverReminder(reminder: DueReminder): Promise<boolean> {
  const channel = deliveryChannels[reminder.delivery_channel];

  if (!channel) {
    logger.warn(`No delivery channel registered for: ${reminder.delivery_channel}`);
    await recordDeliveryAttempt(reminder.id, 'failed', `Unknown channel: ${reminder.delivery_channel}`);
    return false;
  }

  const target = reminder.delivery_target;
  if (!target) {
    logger.warn(`No delivery target for reminder ${reminder.id}`);
    await recordDeliveryAttempt(reminder.id, 'failed', 'No delivery target');
    return false;
  }

  // Format the message
  const message = formatReminderMessage(reminder);

  try {
    await channel.sendMessage(target, message);
    await recordDeliveryAttempt(reminder.id, 'delivered');
    logger.info(`Delivered reminder ${reminder.id} via ${reminder.delivery_channel}`);
    return true;
  } catch (error) {
    logger.error(`Failed to deliver reminder ${reminder.id}:`, error);
    await recordDeliveryAttempt(reminder.id, 'failed', error instanceof Error ? error.message : 'Delivery failed');
    return false;
  }
}

/**
 * Format reminder message for delivery
 */
function formatReminderMessage(reminder: DueReminder): string {
  let message = `🔔 **Reminder:** ${reminder.title}`;

  if (reminder.description) {
    message += `\n\n${reminder.description}`;
  }

  return message;
}

/**
 * Update reminder after successful delivery
 */
async function updateReminderAfterDelivery(reminder: DueReminder): Promise<void> {
  if (!supabase) return;

  const now = new Date().toISOString();
  const newRunCount = reminder.run_count + 1;

  // Check if this is a one-time reminder or has reached max runs
  const isCompleted = !reminder.cron_expression ||
    (reminder.max_runs !== null && newRunCount >= reminder.max_runs);

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
    // Calculate next run time
    const nextRun = calculateNextRun(reminder.cron_expression!, new Date());

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

  await supabase
    .from('reminder_history')
    .insert({
      reminder_id: reminderId,
      status,
      error_message: errorMessage || null,
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
    });
}

/**
 * Calculate next run time from cron expression
 * Uses a simple implementation for common patterns
 */
function calculateNextRun(cronExpr: string, fromTime: Date): Date {
  const next = new Date(fromTime);

  // Simple pattern matching for common cron expressions
  // For production, consider using a library like 'cron-parser'
  switch (cronExpr) {
    case '* * * * *':
      next.setMinutes(next.getMinutes() + 1);
      break;
    case '*/5 * * * *':
      next.setMinutes(next.getMinutes() + 5);
      break;
    case '*/15 * * * *':
      next.setMinutes(next.getMinutes() + 15);
      break;
    case '*/30 * * * *':
      next.setMinutes(next.getMinutes() + 30);
      break;
    case '0 * * * *':
      next.setHours(next.getHours() + 1);
      next.setMinutes(0);
      break;
    case '0 0 * * *':
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      break;
    case '0 0 * * 0':
      next.setDate(next.getDate() + 7);
      next.setHours(0, 0, 0, 0);
      break;
    case '0 9 * * *':
      // Daily at 9am
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
      break;
    default:
      // Default: next day same time
      next.setDate(next.getDate() + 1);
  }

  return next;
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
}): Promise<{ id: string } | null> {
  if (!supabase) {
    supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  const nextRunAt = params.runAt || (params.cronExpression
    ? calculateNextRun(params.cronExpression, new Date())
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
