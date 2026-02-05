/**
 * Google Calendar Types
 *
 * Type definitions for Calendar API interactions.
 */

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  location?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }>;
  organizer?: {
    email: string;
    displayName?: string;
    self?: boolean;
  };
  status: string;
  htmlLink: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  visibility?: string;
  iCalUID?: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  accessRole: string;
  backgroundColor?: string;
  foregroundColor?: string;
  timeZone?: string;
}

export interface ListEventsOptions {
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
  calendarId?: string; // Defaults to 'primary'
  maxResults?: number; // Defaults to 10
  query?: string; // Free text search
  singleEvents?: boolean; // Expand recurring events
  orderBy?: 'startTime' | 'updated';
}

export interface GetEventOptions {
  calendarId?: string;
  eventId: string;
}

/**
 * Valid response statuses for calendar events.
 * Maps to Google Calendar API's responseStatus values.
 */
export type EventResponseStatus = 'accepted' | 'declined' | 'tentative';

export interface RespondToEventOptions {
  calendarId?: string;
  eventId: string;
  responseStatus: EventResponseStatus;
}

/**
 * Fields that can be updated on a calendar event.
 */
export interface UpdateEventFields {
  summary?: string;
  description?: string;
  location?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
}

export interface UpdateEventOptions {
  calendarId?: string;
  eventId: string;
  fields: UpdateEventFields;
}

/**
 * Calendar operations that can be validated against whitelist/blocklist.
 */
export type CalendarOperation =
  | 'respond_to_event'
  | 'create_event'
  | 'update_event'
  | 'delete_event'
  | 'update_attendees';

/**
 * Fields that are allowed to be updated via update_calendar_event.
 */
export type UpdateableEventField = 'summary' | 'description' | 'location' | 'start' | 'end';
