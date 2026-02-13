/**
 * User Settings MCP Tool Handlers
 *
 * Tools for managing user preferences and settings
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';

// Common IANA timezone identifiers for validation hints
const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

// =====================================================
// SCHEMAS
// =====================================================

export const setTimezoneSchema = userIdentifierBaseSchema.extend({
  timezone: z
    .string()
    .describe(
      `IANA timezone identifier (e.g., "America/Los_Angeles", "Europe/London", "Asia/Tokyo"). ` +
        `Common US timezones: America/New_York (Eastern), America/Chicago (Central), ` +
        `America/Denver (Mountain), America/Los_Angeles (Pacific)`
    ),
});

export const getTimezoneSchema = userIdentifierBaseSchema.extend({});

// =====================================================
// HANDLERS
// =====================================================

/**
 * Set the user's timezone
 */
export async function handleSetTimezone(args: unknown, dataComposer: DataComposer) {
  const params = setTimezoneSchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  const { timezone } = params;

  // Validate timezone by trying to use it
  try {
    new Date().toLocaleString('en-US', { timeZone: timezone });
  } catch {
    return {
      success: false,
      error: `Invalid timezone: "${timezone}". Use IANA timezone identifiers like "America/Los_Angeles" or "Europe/London".`,
      suggestions: COMMON_TIMEZONES,
    };
  }

  // Update user's timezone
  const { error } = await supabase.from('users').update({ timezone }).eq('id', user.id);

  if (error) {
    logger.error('Failed to set timezone:', error);
    throw new Error(`Failed to set timezone: ${error.message}`);
  }

  // Format current time in the new timezone for confirmation
  const now = new Date();
  const localTime = now.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  logger.info(`Set timezone for user ${user.id} to ${timezone}`);

  return {
    success: true,
    timezone,
    currentLocalTime: localTime,
    message: `Timezone set to ${timezone}. Current local time: ${localTime}`,
  };
}

/**
 * Get the user's timezone
 */
export async function handleGetTimezone(args: unknown, dataComposer: DataComposer) {
  const params = getTimezoneSchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  // Get user's timezone
  const { data, error } = await supabase
    .from('users')
    .select('timezone')
    .eq('id', user.id)
    .single();

  if (error) {
    logger.error('Failed to get timezone:', error);
    throw new Error(`Failed to get timezone: ${error.message}`);
  }

  const timezone = data?.timezone || 'UTC';

  // Format current time in the timezone
  const now = new Date();
  const localTime = now.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return {
    timezone,
    currentLocalTime: localTime,
    utcTime: now.toISOString(),
  };
}
