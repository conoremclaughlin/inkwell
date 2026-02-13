/**
 * Google Calendar MCP Tool Handlers
 *
 * Exposes Google Calendar functionality via MCP tools.
 */

import { z } from 'zod';
import { getGoogleCalendarService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import type {
  CalendarOperation,
  EventResponseStatus,
  UpdateableEventField,
  UpdateEventFields,
} from './types';

// Shared user identifier schema
const userIdentifierBaseSchema = z.object({
  userId: z.string().uuid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional().describe('Platform name'),
  platformId: z.string().optional().describe('Platform-specific user ID or username'),
});

// Tool result type
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============================================================================
// Operation Permissions (Whitelist/Blocklist)
// ============================================================================

/**
 * Calendar operations that are allowed.
 * This whitelist ensures only safe, non-destructive operations are permitted.
 */
export const ALLOWED_OPERATIONS: Set<CalendarOperation> = new Set([
  'respond_to_event', // Accept, decline, or tentative response to invites
  'update_event', // Update event details (summary, description, location, times)
  'create_event', // Creating new events
]);

/**
 * Event fields that are allowed to be updated via update_calendar_event.
 * This whitelist ensures only safe fields can be modified.
 */
export const ALLOWED_UPDATE_FIELDS: Set<UpdateableEventField> = new Set([
  'summary', // Event title
  'description', // Event description/notes
  'location', // Event location
  'start', // Start time
  'end', // End time
]);

/**
 * Validate that only allowed fields are being updated.
 *
 * @returns null if all fields are valid, or an error message describing blocked fields
 */
export function validateUpdateFields(fields: UpdateEventFields): string | null {
  const providedFields = Object.keys(fields) as UpdateableEventField[];
  const blockedFields = providedFields.filter((f) => !ALLOWED_UPDATE_FIELDS.has(f));

  if (blockedFields.length > 0) {
    return `Cannot update fields: ${blockedFields.join(', ')}. Only ${Array.from(ALLOWED_UPDATE_FIELDS).join(', ')} can be updated.`;
  }

  return null;
}

/**
 * Calendar operations that are NEVER allowed (destructive operations).
 * These are explicitly blocked regardless of any other settings.
 */
export const BLOCKED_OPERATIONS: Set<CalendarOperation> = new Set([
  'delete_event', // Deleting events could cause data loss
  'update_attendees', // Modifying other attendees could send unwanted invites
]);

/**
 * Check if a calendar operation is allowed.
 *
 * @param operation The operation to check
 * @returns { allowed: boolean, reason?: string }
 */
export function isCalendarOperationAllowed(operation: CalendarOperation): {
  allowed: boolean;
  reason?: string;
} {
  // Check blocked list first
  if (BLOCKED_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Calendar operation '${operation}' is not permitted. This operation could result in data loss or unwanted notifications.`,
    };
  }

  // Check allowlist
  if (!ALLOWED_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Calendar operation '${operation}' is not permitted. Only safe operations are allowed.`,
    };
  }

  return { allowed: true };
}

// ============================================================================
// Schemas
// ============================================================================

export const listCalendarsSchema = userIdentifierBaseSchema.extend({});

export const listCalendarEventsSchema = userIdentifierBaseSchema.extend({
  startDate: z
    .string()
    .describe('Start of date range (ISO 8601 format, e.g., 2026-01-30T00:00:00Z)'),
  endDate: z.string().describe('End of date range (ISO 8601 format, e.g., 2026-02-06T00:00:00Z)'),
  calendarId: z.string().optional().describe('Calendar ID to query (default: "primary")'),
  maxResults: z
    .number()
    .optional()
    .default(10)
    .describe('Maximum number of events to return (default: 10)'),
  query: z.string().optional().describe('Free text search query to filter events'),
});

export const getCalendarEventSchema = userIdentifierBaseSchema.extend({
  eventId: z.string().describe('The event ID to retrieve'),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar ID containing the event (default: "primary")'),
});

export const respondToCalendarEventSchema = userIdentifierBaseSchema.extend({
  eventId: z.string().describe('The event ID to respond to'),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar ID containing the event (default: "primary")'),
  responseStatus: z
    .enum(['accepted', 'declined', 'tentative'])
    .describe('Your response to the invitation: "accepted", "declined", or "tentative"'),
});

const eventTimeSchema = z.object({
  dateTime: z
    .string()
    .optional()
    .describe(
      'DateTime in RFC3339 format (e.g., "2026-02-10T10:00:00-08:00"). Use this for timed events.'
    ),
  date: z
    .string()
    .optional()
    .describe('Date in YYYY-MM-DD format (e.g., "2026-02-10"). Use this for all-day events.'),
  timeZone: z
    .string()
    .optional()
    .describe('IANA timezone (e.g., "America/Los_Angeles"). Optional if dateTime includes offset.'),
});

export const updateCalendarEventSchema = userIdentifierBaseSchema.extend({
  eventId: z.string().describe('The event ID to update'),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar ID containing the event (default: "primary")'),
  summary: z.string().optional().describe('New title/summary for the event'),
  description: z.string().optional().describe('New description/notes for the event'),
  location: z.string().optional().describe('New location for the event'),
  start: eventTimeSchema
    .optional()
    .describe('New start time. Use dateTime for timed events, date for all-day events.'),
  end: eventTimeSchema
    .optional()
    .describe('New end time. Use dateTime for timed events, date for all-day events.'),
});

export const createCalendarEventSchema = userIdentifierBaseSchema.extend({
  summary: z.string().describe('Event title/summary'),
  description: z.string().optional().describe('Event description or notes'),
  location: z
    .string()
    .optional()
    .describe('Event location (address, room name, or virtual meeting URL)'),
  start: eventTimeSchema.describe(
    'Event start time. Use dateTime for timed events (e.g., "2026-02-10T10:00:00-08:00"), date for all-day events (e.g., "2026-02-10").'
  ),
  end: eventTimeSchema.describe(
    'Event end time. Use dateTime for timed events, date for all-day events.'
  ),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar ID to create the event in (default: "primary")'),
  attendees: z
    .array(z.string().email())
    .optional()
    .describe('Email addresses of attendees to invite'),
});

// ============================================================================
// Handlers
// ============================================================================

/**
 * List all calendars accessible by the user
 */
export async function handleListCalendars(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = listCalendarsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const calendarService = getGoogleCalendarService();

  try {
    const calendars = await calendarService.listCalendars(user.id);

    logger.info('Listed calendars', {
      userId: user.id,
      count: calendars.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              calendars,
              count: calendars.length,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to list calendars', { userId: user.id, error: message });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('No active google account')
                ? 'User needs to connect their Google account in the web dashboard'
                : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * List events within a date range
 */
export async function handleListCalendarEvents(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = listCalendarEventsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const calendarService = getGoogleCalendarService();

  try {
    const events = await calendarService.listEvents(user.id, {
      startDate: params.startDate,
      endDate: params.endDate,
      calendarId: params.calendarId,
      maxResults: params.maxResults,
      query: params.query,
    });

    logger.info('Listed calendar events', {
      userId: user.id,
      calendarId: params.calendarId || 'primary',
      startDate: params.startDate,
      endDate: params.endDate,
      count: events.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              query: {
                startDate: params.startDate,
                endDate: params.endDate,
                calendarId: params.calendarId || 'primary',
                maxResults: params.maxResults,
              },
              events,
              count: events.length,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to list calendar events', {
      userId: user.id,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('No active google account')
                ? 'User needs to connect their Google account in the web dashboard'
                : message.includes('calendar.readonly')
                  ? 'User needs to re-authorize Google with Calendar permissions'
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get a single event by ID
 */
export async function handleGetCalendarEvent(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getCalendarEventSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const calendarService = getGoogleCalendarService();

  try {
    const event = await calendarService.getEvent(user.id, {
      eventId: params.eventId,
      calendarId: params.calendarId,
    });

    logger.info('Retrieved calendar event', {
      userId: user.id,
      eventId: params.eventId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              event,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get calendar event', {
      userId: user.id,
      eventId: params.eventId,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Respond to a calendar event invitation (accept, decline, or tentative).
 *
 * This allows users to respond to meeting invitations they've received.
 * The user must be listed as an attendee on the event.
 *
 * Note: This does NOT allow deleting events or modifying other attendees.
 */
export async function handleRespondToCalendarEvent(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  // Validate operation is allowed
  const operationCheck = isCalendarOperationAllowed('respond_to_event');
  if (!operationCheck.allowed) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: operationCheck.reason,
              allowedOperations: Array.from(ALLOWED_OPERATIONS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const params = respondToCalendarEventSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const calendarService = getGoogleCalendarService();

  try {
    const event = await calendarService.respondToEvent(user.id, {
      eventId: params.eventId,
      calendarId: params.calendarId,
      responseStatus: params.responseStatus as EventResponseStatus,
    });

    logger.info('Responded to calendar event', {
      userId: user.id,
      eventId: params.eventId,
      responseStatus: params.responseStatus,
      eventSummary: event.summary,
    });

    // Find the user's updated attendee status
    const selfAttendee = event.attendees?.find((a) => a.self);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: `Successfully ${params.responseStatus} the event invitation`,
              event: {
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                location: event.location,
                organizer: event.organizer,
                yourResponse: selfAttendee?.responseStatus,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to respond to calendar event', {
      userId: user.id,
      eventId: params.eventId,
      responseStatus: params.responseStatus,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('not listed as an attendee')
                ? 'You can only respond to events where you are an invited attendee'
                : message.includes('No active google account')
                  ? 'User needs to connect their Google account in the web dashboard'
                  : message.includes('calendar.events')
                    ? 'User needs to re-authorize Google with Calendar write permissions'
                    : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Update a calendar event's details (summary, description, location, times).
 *
 * This allows users to modify safe fields on events they have edit access to.
 * The user should be the organizer or have writer access to the calendar.
 *
 * Note: This does NOT allow deleting events, modifying attendees, or changing organizer.
 */
export async function handleUpdateCalendarEvent(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  // Validate operation is allowed
  const operationCheck = isCalendarOperationAllowed('update_event');
  if (!operationCheck.allowed) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: operationCheck.reason,
              allowedOperations: Array.from(ALLOWED_OPERATIONS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const params = updateCalendarEventSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Build the fields to update
  const fields: UpdateEventFields = {};
  if (params.summary !== undefined) fields.summary = params.summary;
  if (params.description !== undefined) fields.description = params.description;
  if (params.location !== undefined) fields.location = params.location;
  if (params.start !== undefined) fields.start = params.start;
  if (params.end !== undefined) fields.end = params.end;

  // Validate at least one field is being updated
  if (Object.keys(fields).length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error:
                'Must specify at least one field to update (summary, description, location, start, or end)',
              allowedFields: Array.from(ALLOWED_UPDATE_FIELDS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Validate fields against whitelist
  const fieldValidationError = validateUpdateFields(fields);
  if (fieldValidationError) {
    logger.warn('Blocked calendar update due to field restrictions', {
      userId: user.id,
      eventId: params.eventId,
      attemptedFields: Object.keys(fields),
      error: fieldValidationError,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: fieldValidationError,
              allowedFields: Array.from(ALLOWED_UPDATE_FIELDS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const calendarService = getGoogleCalendarService();

  try {
    const event = await calendarService.updateEvent(user.id, {
      eventId: params.eventId,
      calendarId: params.calendarId,
      fields,
    });

    logger.info('Updated calendar event', {
      userId: user.id,
      eventId: params.eventId,
      updatedFields: Object.keys(fields),
      eventSummary: event.summary,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: `Successfully updated event: ${Object.keys(fields).join(', ')}`,
              event: {
                id: event.id,
                summary: event.summary,
                description: event.description,
                start: event.start,
                end: event.end,
                location: event.location,
                organizer: event.organizer,
                htmlLink: event.htmlLink,
              },
              updatedFields: Object.keys(fields),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to update calendar event', {
      userId: user.id,
      eventId: params.eventId,
      attemptedFields: Object.keys(fields),
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('No active google account')
                ? 'User needs to connect their Google account in the web dashboard'
                : message.includes('calendar.events')
                  ? 'User needs to re-authorize Google with Calendar write permissions'
                  : message.includes('403') || message.includes('forbidden')
                    ? 'You may not have edit access to this event. Only the organizer or users with writer access can modify events.'
                    : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Create a new calendar event.
 *
 * Creates an event on the user's Google Calendar with optional attendees,
 * location, and description. Supports both timed and all-day events.
 */
export async function handleCreateCalendarEvent(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  // Validate operation is allowed
  const operationCheck = isCalendarOperationAllowed('create_event');
  if (!operationCheck.allowed) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: operationCheck.reason,
              allowedOperations: Array.from(ALLOWED_OPERATIONS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const params = createCalendarEventSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const calendarService = getGoogleCalendarService();

  try {
    const event = await calendarService.createEvent(user.id, {
      summary: params.summary,
      description: params.description,
      location: params.location,
      start: params.start,
      end: params.end,
      calendarId: params.calendarId,
      attendees: params.attendees,
    });

    logger.info('Created calendar event', {
      userId: user.id,
      eventId: event.id,
      summary: event.summary,
      attendeeCount: params.attendees?.length ?? 0,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: `Successfully created event: "${event.summary}"`,
              event: {
                id: event.id,
                summary: event.summary,
                description: event.description,
                start: event.start,
                end: event.end,
                location: event.location,
                attendees: event.attendees,
                organizer: event.organizer,
                htmlLink: event.htmlLink,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create calendar event', {
      userId: user.id,
      summary: params.summary,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('No active google account')
                ? 'User needs to connect their Google account in the web dashboard'
                : message.includes('calendar.events')
                  ? 'User needs to re-authorize Google with Calendar write permissions'
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}
