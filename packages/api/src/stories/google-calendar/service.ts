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
} from './types';

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
  async listEvents(
    userId: string,
    options: ListEventsOptions
  ): Promise<CalendarEvent[]> {
    const calendar = await this.getClient(userId);

    const {
      startDate,
      endDate,
      calendarId = 'primary',
      maxResults = 10,
      query,
      singleEvents = true,
      orderBy = 'startTime',
    } = options;

    logger.info('Fetching calendar events', {
      userId,
      calendarId,
      startDate,
      endDate,
      maxResults,
    });

    const response = await calendar.events.list({
      calendarId,
      timeMin: startDate,
      timeMax: endDate,
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
  async getEvent(
    userId: string,
    options: GetEventOptions
  ): Promise<CalendarEvent> {
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
  async respondToEvent(
    userId: string,
    options: RespondToEventOptions
  ): Promise<CalendarEvent> {
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
      throw new Error(
        'Cannot respond to this event: you are not listed as an attendee'
      );
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
  async updateEvent(
    userId: string,
    options: UpdateEventOptions
  ): Promise<CalendarEvent> {
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
