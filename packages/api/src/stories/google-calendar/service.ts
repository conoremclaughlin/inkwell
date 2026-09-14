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

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reject a bare date that `Date` would silently rewrite into a different one.
 *
 * The YYYY-MM-DD shape above accepts impossible dates and the MCP schema is
 * only `z.string()`, so "2026-02-31" arrives here intact. `Date` normalizes it
 * to March 3 rather than refusing it. That used to be survivable: the malformed
 * string was handed to Google and rejected there. Once an endDate is advanced
 * by a day before conversion, the same input turns into a *well-formed* query
 * over days nobody asked for — a bad input becoming a plausible answer, which
 * is the failure mode this whole file is about. So it has to be caught before
 * any arithmetic touches it.
 */
function assertRealCalendarDate(date: string, field: string): void {
  const parsed = new Date(`${date}T00:00:00Z`);
  // Round-trip rather than just a NaN check: month 13 fails to parse at all,
  // but February 31 parses cleanly and comes back as a different day.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${field} "${date}" is not a real calendar date`);
  }
}

/** The UTC offset of `timezone` at a given instant, in minutes east of UTC. */
function zoneOffsetMinutesAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  // "GMT-07:00", "GMT+05:30", or a bare "GMT" exactly at zero offset.
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return 0;

  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -magnitude : magnitude;
}

function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const rest = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${rest}`;
}

/**
 * The offset in force at the START of `date` in `timezone` — the REQUESTED
 * zone's midnight, never the host's.
 *
 * This used to sample `new Date(date + 'T00:00:00')`, which is midnight where
 * the server happens to sit, and then read the requested zone's offset at that
 * unrelated instant. The two coincide only when the server runs in the zone
 * being asked about, so the bug was invisible to any test whose host zone
 * matched the zone under test — and invisible in CI, which runs in UTC, for any
 * request in UTC.
 *
 * It bites whenever the sampled instant lands on the far side of a DST
 * transition from the requested midnight. Under a Los Angeles host,
 * `Europe/Berlin` on 2026-03-29 resolved to +02:00 when Berlin midnight is
 * still +01:00, dropping the day's last hour; on 2026-10-25 it resolved to
 * +01:00 instead of +02:00, pulling in the next day's first hour (found by
 * Lumen in review).
 */
function startOfDayOffset(date: string, timezone: string): string {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);

  // Seed with the offset at that calendar date's UTC midnight, then re-read it
  // at the instant the seed implies for local midnight. When the seed sat on
  // the far side of a transition, the second reading is the one actually in
  // force. One correction converges for every real zone, because DST shifts
  // (an hour or two) are far smaller than the offsets themselves.
  const seed = zoneOffsetMinutesAt(new Date(utcMidnight), timezone);
  const atLocalMidnight = zoneOffsetMinutesAt(new Date(utcMidnight - seed * 60_000), timezone);

  return formatUtcOffset(atLocalMidnight);
}

/**
 * Convert a bare YYYY-MM-DD date to an RFC 3339 timestamp at midnight in the
 * given IANA timezone. Already-qualified timestamps pass through unchanged.
 */
function bareDateToRfc3339(date: string, timezone: string, field: string): string {
  if (!BARE_DATE.test(date)) return date;
  assertRealCalendarDate(date, field);

  return `${date}T00:00:00${startOfDayOffset(date, timezone)}`;
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
 * met. Same-day is only the degenerate case. The expensive version is a
 * multi-day range whose last day happens to hold a recurring appointment: the
 * event stays invisible for as long as nobody queries a wider window, and a
 * false story gets built on the absence — that the series was cancelled or
 * reshuffled, when the far edge of every window was simply being cut off
 * (reported by Myra, 2026-09-04).
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
  if (!BARE_DATE.test(endDate)) return endDate;
  assertRealCalendarDate(endDate, 'endDate');

  // UTC arithmetic on the bare date: this only advances the calendar day, and
  // the zone conversion is left entirely to bareDateToRfc3339.
  const next = new Date(`${endDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextBare = next.toISOString().slice(0, 10);

  return bareDateToRfc3339(nextBare, timezone, 'endDate');
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
    timeMin: bareDateToRfc3339(startDate, timezone, 'startDate'),
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
