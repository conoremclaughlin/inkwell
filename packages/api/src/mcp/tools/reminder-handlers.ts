/**
 * MCP Tool Handlers for Scheduled Reminders
 *
 * These tools enable AI agents to create, manage, and track scheduled reminders.
 * Reminders are delivered via the heartbeat service at their scheduled times.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';
import { resolveUser, type UserIdentifier } from '../../services/user-resolver';
import { env } from '../../config/env';
import type { Database } from '../../data/supabase/types';

// Common user identifier schema
// Usually unnecessary — userId and email are auto-resolved from OAuth token.
const userIdentifierSchema = z.object({
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
});

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

// Get typed Supabase client
function getSupabase() {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
}

// ============================================================================
// CALCULATE NEXT RUN
// ============================================================================

function calculateNextRun(cronExpr: string, fromTime: Date): Date {
  const next = new Date(fromTime);

  // Simple pattern matching for common cron expressions
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
      if (next.getHours() >= 9) {
        next.setDate(next.getDate() + 1);
      }
      next.setHours(9, 0, 0, 0);
      break;
    case '0 9 * * 1-5':
      // Weekdays at 9am
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
      next.setHours(9, 0, 0, 0);
      break;
    default:
      // Default: next day same time
      next.setDate(next.getDate() + 1);
  }

  return next;
}

// ============================================================================
// CREATE REMINDER
// ============================================================================

export const createReminderSchema = z.object({
  ...userIdentifierSchema.shape,
  title: z.string().min(1).max(500).describe('Reminder title/message'),
  description: z.string().optional().describe('Additional details'),
  agentId: z
    .string()
    .optional()
    .describe(
      'Agent that should handle this reminder (e.g., "myra", "lumen"). Resolved to identity_id.'
    ),
  identityId: z
    .string()
    .uuid()
    .optional()
    .describe('Direct identity UUID from agent_identities. Takes precedence over agentId.'),
  deliveryChannel: z
    .enum(['telegram', 'whatsapp', 'email'])
    .optional()
    .describe('How to deliver (default: uses platform from user lookup)'),
  deliveryTarget: z
    .string()
    .optional()
    .describe("Specific target ID (default: uses user's platform ID)"),
  cronExpression: z
    .string()
    .optional()
    .describe('Cron expression for recurring reminders (e.g., "0 9 * * *" for daily at 9am)'),
  runAt: z
    .string()
    .datetime()
    .optional()
    .describe('Specific time to run (ISO 8601). For one-time reminders.'),
  maxRuns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of times to run (for recurring reminders)'),
  studioHint: z
    .string()
    .optional()
    .describe(
      'Studio to run this reminder in (e.g., "main", or a studio slug like "wren-omega"). Overrides the agent\'s default. If omitted, inherits from agent identity.'
    ),
});

export async function handleCreateReminder(
  args: z.infer<typeof createReminderSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    // Determine delivery channel and target
    let deliveryChannel = args.deliveryChannel;
    let deliveryTarget = args.deliveryTarget;

    if (!deliveryChannel) {
      // Use the platform from args if provided, or infer from resolution method
      const inferredPlatform =
        args.platform || (resolved.resolvedBy === 'platform' ? args.platform : null);

      if (inferredPlatform === 'telegram') {
        deliveryChannel = 'telegram';
        deliveryTarget = deliveryTarget || resolved.user.telegram_id?.toString();
      } else if (inferredPlatform === 'whatsapp') {
        deliveryChannel = 'whatsapp';
        deliveryTarget = deliveryTarget || resolved.user.whatsapp_id || undefined;
      } else {
        // Default to telegram if user has telegram_id, otherwise whatsapp
        if (resolved.user.telegram_id) {
          deliveryChannel = 'telegram';
          deliveryTarget = deliveryTarget || resolved.user.telegram_id.toString();
        } else if (resolved.user.whatsapp_id) {
          deliveryChannel = 'whatsapp';
          deliveryTarget = deliveryTarget || resolved.user.whatsapp_id;
        } else {
          return mcpResponse(
            {
              success: false,
              error: 'No delivery channel available. User has no telegram_id or whatsapp_id.',
            },
            true
          );
        }
      }
    }

    if (!deliveryTarget) {
      return mcpResponse(
        {
          success: false,
          error: 'Could not determine delivery target. Please specify deliveryTarget.',
        },
        true
      );
    }

    // Resolve identity_id from agentId or direct identityId (always scoped to user)
    let identityId: string | null = args.identityId || null;
    if (identityId) {
      // Validate direct identityId belongs to this user
      const { data: owned } = await supabase
        .from('agent_identities')
        .select('id')
        .eq('id', identityId)
        .eq('user_id', resolved.user.id)
        .single();
      if (!owned) {
        return mcpResponse(
          { success: false, error: 'identityId not found or does not belong to this user.' },
          true
        );
      }
    } else if (args.agentId) {
      const { data: identity } = await supabase
        .from('agent_identities')
        .select('id')
        .eq('agent_id', args.agentId)
        .eq('user_id', resolved.user.id)
        .limit(1)
        .single();
      if (identity) {
        identityId = identity.id;
      } else {
        return mcpResponse(
          {
            success: false,
            error: `Unknown agent "${args.agentId}" for this user. Check agent_identities table.`,
          },
          true
        );
      }
    }

    // Calculate next run time
    let nextRunAt: Date;
    if (args.runAt) {
      nextRunAt = new Date(args.runAt);
    } else if (args.cronExpression) {
      nextRunAt = calculateNextRun(args.cronExpression, new Date());
    } else {
      // Default: run in 1 minute (for testing) or immediate
      nextRunAt = new Date();
      nextRunAt.setMinutes(nextRunAt.getMinutes() + 1);
    }

    const { data, error } = await supabase
      .from('scheduled_reminders')
      .insert({
        user_id: resolved.user.id,
        title: args.title,
        description: args.description || null,
        delivery_channel: deliveryChannel,
        delivery_target: deliveryTarget,
        identity_id: identityId,
        cron_expression: args.cronExpression || null,
        next_run_at: nextRunAt.toISOString(),
        max_runs: args.maxRuns || null,
        studio_hint: args.studioHint || null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    return mcpResponse({
      success: true,
      reminder: {
        id: data.id,
        title: data.title,
        description: data.description,
        agentId: args.agentId || null,
        identityId: data.identity_id,
        deliveryChannel: data.delivery_channel,
        deliveryTarget: data.delivery_target,
        cronExpression: data.cron_expression,
        nextRunAt: data.next_run_at,
        studioHint: data.studio_hint,
        status: data.status,
        isRecurring: !!data.cron_expression,
      },
      ...(!identityId
        ? {
            hint: 'Consider adding agentId (e.g., "myra") to route this reminder to a specific agent.',
          }
        : {}),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create reminder',
      },
      true
    );
  }
}

// ============================================================================
// LIST REMINDERS
// ============================================================================

export const listRemindersSchema = z.object({
  ...userIdentifierSchema.shape,
  agentId: z
    .string()
    .optional()
    .describe('Filter reminders assigned to a specific agent (e.g., "myra")'),
  status: z
    .enum(['active', 'paused', 'completed', 'failed'])
    .optional()
    .describe('Filter by status (default: active)'),
  includeCompleted: z.boolean().optional().describe('Include completed reminders (default: false)'),
  limit: z.number().min(1).max(100).optional().default(20),
});

export async function handleListReminders(
  args: z.infer<typeof listRemindersSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    // Resolve identity_id filter if agentId provided (scoped to user)
    let identityIdFilter: string | undefined;
    if (args.agentId) {
      const { data: identity } = await supabase
        .from('agent_identities')
        .select('id')
        .eq('agent_id', args.agentId)
        .eq('user_id', resolved.user.id)
        .limit(1)
        .single();
      if (identity) {
        identityIdFilter = identity.id;
      } else {
        // Unknown agent requested — return empty rather than silently ignoring the filter
        return mcpResponse({
          success: true,
          reminders: [],
          hint: `No agent "${args.agentId}" found for this user. No reminders to show.`,
        });
      }
    }

    // Query all reminders if includeCompleted, otherwise only active/paused
    let query = supabase
      .from('scheduled_reminders')
      .select('*')
      .eq('user_id', resolved.user.id)
      .limit(args.limit || 20);

    if (identityIdFilter) {
      query = query.eq('identity_id', identityIdFilter);
    }

    if (args.status) {
      query = query.eq('status', args.status);
    } else if (!args.includeCompleted) {
      query = query.in('status', ['active', 'paused']);
    }

    const { data, error } = await query;

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    const mapReminder = (r: (typeof data)[0]) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      identityId: r.identity_id,
      deliveryChannel: r.delivery_channel,
      cronExpression: r.cron_expression,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      studioHint: r.studio_hint,
      status: r.status,
      runCount: r.run_count,
      maxRuns: r.max_runs,
      isRecurring: !!r.cron_expression,
    });

    // Sort: active/paused first (by next_run_at), then completed/failed (by last_run_at desc)
    const active = (data || [])
      .filter((r) => r.status === 'active' || r.status === 'paused')
      .sort(
        (a, b) => new Date(a.next_run_at || 0).getTime() - new Date(b.next_run_at || 0).getTime()
      );

    const completed = (data || [])
      .filter((r) => r.status === 'completed' || r.status === 'failed')
      .sort(
        (a, b) => new Date(b.last_run_at || 0).getTime() - new Date(a.last_run_at || 0).getTime()
      );

    // Return grouped response if there are completed reminders
    if (completed.length > 0 && args.includeCompleted) {
      return mcpResponse({
        success: true,
        activeReminders: active.map(mapReminder),
        completedReminders: completed.map(mapReminder),
        summary: {
          active: active.length,
          completed: completed.length,
          total: active.length + completed.length,
        },
      });
    }

    // Return flat list if no completed or not including them
    return mcpResponse({
      success: true,
      reminders: active.map(mapReminder),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list reminders',
      },
      true
    );
  }
}

// ============================================================================
// UPDATE REMINDER
// ============================================================================

export const updateReminderSchema = z.object({
  ...userIdentifierSchema.shape,
  reminderId: z.string().uuid().describe('Reminder ID to update'),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  agentId: z.string().optional().describe('Reassign to a different agent (e.g., "myra")'),
  cronExpression: z
    .string()
    .optional()
    .describe('New cron expression (set to null to make one-time)'),
  nextRunAt: z.string().datetime().optional().describe('Reschedule to specific time'),
  status: z.enum(['active', 'paused']).optional().describe('Pause or resume the reminder'),
  studioHint: z
    .string()
    .optional()
    .describe(
      'Studio to run this reminder in. Set to override agent default, or empty string to clear override.'
    ),
});

export async function handleUpdateReminder(
  args: z.infer<typeof updateReminderSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    // Verify reminder belongs to user
    const { data: existing } = await supabase
      .from('scheduled_reminders')
      .select('*')
      .eq('id', args.reminderId)
      .eq('user_id', resolved.user.id)
      .single();

    if (!existing) {
      return mcpResponse({ success: false, error: 'Reminder not found' }, true);
    }

    // Build updates
    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.agentId !== undefined) {
      const { data: identity } = await supabase
        .from('agent_identities')
        .select('id')
        .eq('agent_id', args.agentId)
        .eq('user_id', resolved.user.id)
        .limit(1)
        .single();
      if (identity) {
        updates.identity_id = identity.id;
      } else {
        return mcpResponse(
          { success: false, error: `Unknown agent "${args.agentId}" for this user.` },
          true
        );
      }
    }
    if (args.cronExpression !== undefined) updates.cron_expression = args.cronExpression || null;
    if (args.nextRunAt !== undefined) updates.next_run_at = args.nextRunAt;
    if (args.status !== undefined) updates.status = args.status;
    if (args.studioHint !== undefined) updates.studio_hint = args.studioHint || null;

    if (Object.keys(updates).length === 0) {
      return mcpResponse({ success: false, error: 'No updates provided' }, true);
    }

    const { data, error } = await supabase
      .from('scheduled_reminders')
      .update(updates)
      .eq('id', args.reminderId)
      .select()
      .single();

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    return mcpResponse({
      success: true,
      reminder: {
        id: data.id,
        title: data.title,
        description: data.description,
        cronExpression: data.cron_expression,
        nextRunAt: data.next_run_at,
        studioHint: data.studio_hint,
        status: data.status,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update reminder',
      },
      true
    );
  }
}

// ============================================================================
// CANCEL REMINDER
// ============================================================================

export const cancelReminderSchema = z.object({
  ...userIdentifierSchema.shape,
  reminderId: z.string().uuid().describe('Reminder ID to cancel'),
});

export async function handleCancelReminder(
  args: z.infer<typeof cancelReminderSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    // Verify reminder belongs to user
    const { data: existing } = await supabase
      .from('scheduled_reminders')
      .select('id, title, status')
      .eq('id', args.reminderId)
      .eq('user_id', resolved.user.id)
      .single();

    if (!existing) {
      return mcpResponse({ success: false, error: 'Reminder not found' }, true);
    }

    if (existing.status === 'completed') {
      return mcpResponse({
        success: true,
        message: 'Reminder was already completed',
        reminder: { id: existing.id, title: existing.title, status: 'completed' },
      });
    }

    const { error } = await supabase
      .from('scheduled_reminders')
      .update({ status: 'completed' })
      .eq('id', args.reminderId);

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    return mcpResponse({
      success: true,
      message: 'Reminder cancelled',
      reminder: { id: existing.id, title: existing.title, status: 'completed' },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel reminder',
      },
      true
    );
  }
}

// ============================================================================
// GET REMINDER HISTORY
// ============================================================================

export const getReminderHistorySchema = z.object({
  ...userIdentifierSchema.shape,
  reminderId: z.string().uuid().describe('Reminder ID to get history for'),
  limit: z.number().min(1).max(100).optional().default(20),
});

export async function handleGetReminderHistory(
  args: z.infer<typeof getReminderHistorySchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    // Verify reminder belongs to user
    const { data: reminder } = await supabase
      .from('scheduled_reminders')
      .select('id, title, user_id')
      .eq('id', args.reminderId)
      .eq('user_id', resolved.user.id)
      .single();

    if (!reminder) {
      return mcpResponse({ success: false, error: 'Reminder not found' }, true);
    }

    // Get delivery history
    const { data: history, error } = await supabase
      .from('reminder_history')
      .select('*')
      .eq('reminder_id', args.reminderId)
      .order('triggered_at', { ascending: false })
      .limit(args.limit || 20);

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    return mcpResponse({
      success: true,
      reminder: {
        id: reminder.id,
        title: reminder.title,
      },
      history: (history || []).map((h) => ({
        id: h.id,
        triggeredAt: h.triggered_at,
        deliveredAt: h.delivered_at,
        status: h.status,
        errorMessage: h.error_message,
      })),
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get reminder history',
      },
      true
    );
  }
}

// ============================================================================
// SET QUIET HOURS
// ============================================================================

export const setQuietHoursSchema = z.object({
  ...userIdentifierSchema.shape,
  quietStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('Start of quiet hours (HH:MM, e.g., "23:00")'),
  quietEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('End of quiet hours (HH:MM, e.g., "08:00")'),
  timezone: z.string().optional().describe('Timezone (e.g., "America/New_York"). Default: UTC'),
  disable: z.boolean().optional().describe('Set to true to disable quiet hours'),
});

export async function handleSetQuietHours(
  args: z.infer<typeof setQuietHoursSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const supabase = getSupabase();

    if (args.disable) {
      // Clear quiet hours
      const { error } = await supabase.from('heartbeat_state').upsert({
        user_id: resolved.user.id,
        quiet_start: null,
        quiet_end: null,
      });

      if (error) {
        return mcpResponse({ success: false, error: error.message }, true);
      }

      return mcpResponse({
        success: true,
        message: 'Quiet hours disabled',
      });
    }

    if (!args.quietStart || !args.quietEnd) {
      return mcpResponse(
        {
          success: false,
          error: 'Both quietStart and quietEnd are required (or use disable: true)',
        },
        true
      );
    }

    const { data, error } = await supabase
      .from('heartbeat_state')
      .upsert({
        user_id: resolved.user.id,
        quiet_start: args.quietStart,
        quiet_end: args.quietEnd,
        timezone: args.timezone || 'UTC',
      })
      .select()
      .single();

    if (error) {
      return mcpResponse({ success: false, error: error.message }, true);
    }

    return mcpResponse({
      success: true,
      quietHours: {
        start: data.quiet_start,
        end: data.quiet_end,
        timezone: data.timezone,
      },
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set quiet hours',
      },
      true
    );
  }
}
