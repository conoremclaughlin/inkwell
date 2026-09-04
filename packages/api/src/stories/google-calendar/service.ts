/**
 * Google Calendar Service
 *
 * Handles Google Calendar API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, calendar_v3 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import type {
  CalendarEvent,
  CalendarInfo,
  ListEventsOptions,
  GetEventOptions,
  RespondToEventOptions,
  UpdateEventOptions,
  CreateEventOptions,
} from './types';

/**
 * Convert a bare YYYY-MM-DD date to an RFC 3339 timestamp at midnight in the
 * given IANA timezone. Already-qualified timestamps pass through unchanged.
 */
function bareDateToRfc3339(date: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;

  // Intl.DateTimeFormat resolves the UTC offset for a given date + timezone.
  // We construct midnight local, then compute the UTC equivalent.
  const midnight = new Date(`${date}T00:00:00`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(midnight);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName');
  // offsetPart.value is like "GMT-07:00" or "GMT+01:00" or "GMT"
  const offsetStr = offsetPart?.value?.replace('GMT', '') || '+00:00';
  const offset = offsetStr === '' ? '+00:00' : offsetStr;

  return `${date}T00:00:00${offset}`;
}

/**
 * The RFC3339 instant that makes `endDate` INCLUSIVE.
 *
 * Google's `timeMax` is exclusive, and `endDate` was passed straight through
 * `bareDateToRfc3339` — which resolves a bare date to midnight at the START of
 * that day. So every range silently dropped its final day, and the same-day
 * case (`start === end`) produced a zero-width window that returned nothing.
 *
 * It was filed for eleven days as "same-day queries return empty", because
 * "what's on today" is the query anyone makes most and that is where it gets
 * met. Same-day is only the degenerate case. The real defect cost Conor two
 * Spravato appointments — Mon 14 and Wed 16 September — invisible from 25
 * August to 4 September, and a false story built on their absence: that the
 * series had been reshuffled, when the far edge of every window was simply
 * being cut off (Myra, 2026-09-04).
 *
 * A bare `endDate` therefore advances one calendar day before conversion, so
 * the window ends at midnight after it.
 *
 * The advance is done in UTC deliberately, and NOT because local-day arithmetic
 * would be wrong here — I first wrote that it was, and mutating `setUTCDate(+1)`
 * to `+ 24h` failed to break a single test, because a UTC day is always 24
 * hours and the two are identical. The real reason is division of labour: doing
 * the arithmetic on a bare date in UTC means DST cannot reach it at all, and
 * the entire zone question is delegated to bareDateToRfc3339, which resolves a
 * bare date to the correct offset FOR THAT DAY. That is where the DST
 * correctness lives, and it is why the tests below assert offsets (-08:00 after
 * the November fall-back, -07:00 after the March spring-forward) rather than
 * asserting an arithmetic style.
 *
 * A full timestamp is passed through untouched. Someone who wrote an instant
 * meant that instant, and silently extending it would be a second defect in the
 * opposite direction.
 */
export function inclusiveEndToRfc3339(endDate: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return endDate;

  // UTC arithmetic on the bare date: this only advances the calendar day, and
  // the zone conversion is left entirely to bareDateToRfc3339.
  const next = new Date(`${endDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextBare = next.toISOString().slice(0, 10);

  return bareDateToRfc3339(nextBare, timezone);
}

/**
 * Both bounds of a query window, together.
 *
 * Returned as a pair so the asymmetry is testable: the START is the instant the
 * first day begins, the END is the instant the day AFTER the last one begins.
 * A fix that shifted the whole window by a day would satisfy any same-day test
 * while quietly dropping the first day instead of the last — so the property
 * that matters is the relationship between the two, not either alone.
 */
export function calendarWindow(
  startDate: string,
  endDate: string,
  timezone: string
): { timeMin: string; timeMax: string } {
  return {
    timeMin: bareDateToRfc3339(startDate, timezone),
    timeMax: inclusiveEndToRfc3339(endDate, timezone),
  };
}

export class GoogleCalendarService {
  private oauthService = getOAuthService();

  /**
   * Get an authenticated Calendar API client for a user
   */
  private async getClient(userId: string): Promise<calendar_v3.Calendar> {
    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.calendar({ version: 'v3', auth });
  }

  /**
   * List calendars accessible by the user
   */
  async listCalendars(userId: string): Promise<CalendarInfo[]> {
    const calendar = await this.getClient(userId);

    logger.info('Fetching calendar list', { userId });

    const response = await calendar.calendarList.list({
      maxResults: 100,
    });

    const calendars = response.data.items || [];

    return calendars.map((cal) => ({
      id: cal.id || '',
      summary: cal.summary || '',
      description: cal.description || undefined,
      primary: cal.primary || false,
      accessRole: cal.accessRole || 'reader',
      backgroundColor: cal.backgroundColor || undefined,
      foregroundColor: cal.foregroundColor || undefined,
      timeZone: cal.timeZone || undefined,
    }));
  }

  /**
   * List events within a date range
   */
  async listEvents(userId: string, options: ListEventsOptions): Promise<CalendarEvent[]> {
    const calendar = await this.getClient(userId);

    const {
      startDate,
      endDate,
      calendarId = 'primary',
      maxResults = 10,
      query,
      singleEvents = true,
      orderBy = 'startTime',
      timezone = 'UTC',
    } = options;

    logger.info('Fetching calendar events', {
      userId,
      calendarId,
      startDate,
      endDate,
      timezone,
      maxResults,
    });

    const response = await calendar.events.list({
      calendarId,
      ...calendarWindow(startDate, endDate, timezone),
      maxResults,
      q: query,
      singleEvents,
      orderBy: singleEvents ? orderBy : undefined, // orderBy only works with singleEvents
    });

    const events = response.data.items || [];

    return events.map(this.mapEvent);
  }

  /**
   * Get a single event by ID
   */
  async getEvent(userId: string, options: GetEventOptions): Promise<CalendarEvent> {
    const calendar = await this.getClient(userId);

    const { calendarId = 'primary', eventId } = options;

    logger.info('Fetching calendar event', { userId, calendarId, eventId });

    const response = await calendar.events.get({
      calendarId,
      eventId,
    });

    return this.mapEvent(response.data);
  }

  /**
   * Respond to a calendar event invitation (accept, decline, tentative).
   *
   * This updates the user's response status on the event. The user must be
   * an attendee of the event for this to work.
   */
  async respondToEvent(userId: string, options: RespondToEventOptions): Promise<CalendarEvent> {
    const calendar = await this.getClient(userId);

    const { calendarId = 'primary', eventId, responseStatus } = options;

    logger.info('Responding to calendar event', {
      userId,
      calendarId,
      eventId,
      responseStatus,
    });

    // First, get the current event to find the user's attendee entry
    const currentEvent = await calendar.events.get({
      calendarId,
      eventId,
    });

    const attendees = currentEvent.data.attendees || [];

    // Find the user's attendee entry (marked with self: true)
    const selfAttendeeIndex = attendees.findIndex((a) => a.self === true);

    if (selfAttendeeIndex === -1) {
      throw new Error('Cannot respond to this event: you are not listed as an attendee');
    }

    // Update the user's response status
    attendees[selfAttendeeIndex].responseStatus = responseStatus;

    // Patch the event with updated attendees
    const response = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        attendees,
      },
      // Send notification to the organizer about the response
      sendUpdates: 'all',
    });

    logger.info('Responded to calendar event', {
      userId,
      eventId,
      responseStatus,
      eventSummary: response.data.summary,
    });

    return this.mapEvent(response.data);
  }

  /**
   * Update a calendar event's details (summary, description, location, times).
   *
   * This allows updating safe fields on events. The user should have edit
   * access to the event (typically the organizer or with writer access).
   */
  async updateEvent(userId: string, options: UpdateEventOptions): Promise<CalendarEvent> {
    const calendar = await this.getClient(userId);

    const { calendarId = 'primary', eventId, fields } = options;

    logger.info('Updating calendar event', {
      userId,
      calendarId,
      eventId,
      fieldsToUpdate: Object.keys(fields),
    });

    // Build the update payload with only the provided fields
    const updatePayload: calendar_v3.Schema$Event = {};

    if (fields.summary !== undefined) {
      updatePayload.summary = fields.summary;
    }
    if (fields.description !== undefined) {
      updatePayload.description = fields.description;
    }
    if (fields.location !== undefined) {
      updatePayload.location = fields.location;
    }
    if (fields.start !== undefined) {
      updatePayload.start = {
        dateTime: fields.start.dateTime,
        date: fields.start.date,
        timeZone: fields.start.timeZone,
      };
    }
    if (fields.end !== undefined) {
      updatePayload.end = {
        dateTime: fields.end.dateTime,
        date: fields.end.date,
        timeZone: fields.end.timeZone,
      };
    }

    // Patch the event with the updated fields
    const response = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: updatePayload,
      // Notify attendees of changes
      sendUpdates: 'all',
    });

    logger.info('Updated calendar event', {
      userId,
      eventId,
      eventSummary: response.data.summary,
      updatedFields: Object.keys(fields),
    });

    return this.mapEvent(response.data);
  }

  /**
   * Create a new calendar event.
   */
  async createEvent(userId: string, options: CreateEventOptions): Promise<CalendarEvent> {
    const calendar = await this.getClient(userId);

    const {
      calendarId = 'primary',
      summary,
      description,
      location,
      start,
      end,
      attendees,
    } = options;

    logger.info('Creating calendar event', {
      userId,
      calendarId,
      summary,
      hasAttendees: !!attendees?.length,
    });

    const requestBody: calendar_v3.Schema$Event = {
      summary,
      start: { dateTime: start.dateTime, date: start.date, timeZone: start.timeZone },
      end: { dateTime: end.dateTime, date: end.date, timeZone: end.timeZone },
    };

    if (description !== undefined) requestBody.description = description;
    if (location !== undefined) requestBody.location = location;
    if (attendees && attendees.length > 0) {
      requestBody.attendees = attendees.map((email) => ({ email }));
    }

    const response = await calendar.events.insert({
      calendarId,
      requestBody,
      sendUpdates: attendees?.length ? 'all' : 'none',
    });

    logger.info('Created calendar event', {
      userId,
      eventId: response.data.id,
      summary: response.data.summary,
      attendeeCount: attendees?.length ?? 0,
    });

    return this.mapEvent(response.data);
  }

  /**
   * Map Google Calendar API event to our CalendarEvent type
   */
  private mapEvent(event: calendar_v3.Schema$Event): CalendarEvent {
    return {
      id: event.id || '',
      summary: event.summary || '(No title)',
      description: event.description || undefined,
      start: {
        dateTime: event.start?.dateTime || undefined,
        date: event.start?.date || undefined,
        timeZone: event.start?.timeZone || undefined,
      },
      end: {
        dateTime: event.end?.dateTime || undefined,
        date: event.end?.date || undefined,
        timeZone: event.end?.timeZone || undefined,
      },
      location: event.location || undefined,
      attendees: event.attendees?.map((a) => ({
        email: a.email || '',
        displayName: a.displayName || undefined,
        responseStatus: a.responseStatus || undefined,
        self: a.self || false,
        organizer: a.organizer || false,
      })),
      organizer: event.organizer
        ? {
            email: event.organizer.email || '',
            displayName: event.organizer.displayName || undefined,
            self: event.organizer.self || false,
          }
        : undefined,
      status: event.status || 'confirmed',
      htmlLink: event.htmlLink || '',
      created: event.created || undefined,
      updated: event.updated || undefined,
      recurringEventId: event.recurringEventId || undefined,
      visibility: event.visibility || undefined,
      iCalUID: event.iCalUID || undefined,
    };
  }
}

// Singleton instance
let calendarService: GoogleCalendarService | null = null;

export function getGoogleCalendarService(): GoogleCalendarService {
  if (!calendarService) {
    calendarService = new GoogleCalendarService();
  }
  return calendarService;
}
