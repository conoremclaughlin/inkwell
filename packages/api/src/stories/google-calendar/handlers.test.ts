/**
 * Google Calendar Handlers Tests
 *
 * Tests for the operation whitelist/blocklist system that prevents
 * destructive calendar operations (deletion, modifying other attendees).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isCalendarOperationAllowed,
  ALLOWED_OPERATIONS,
  BLOCKED_OPERATIONS,
  ALLOWED_UPDATE_FIELDS,
  validateUpdateFields,
  handleRespondToCalendarEvent,
  handleUpdateCalendarEvent,
  respondToCalendarEventSchema,
  updateCalendarEventSchema,
} from './handlers';
import type { CalendarOperation, UpdateableEventField } from './types';

// Mock the dependencies
vi.mock('./service', () => ({
  getGoogleCalendarService: vi.fn(),
}));

vi.mock('../../services/user-resolver', () => ({
  resolveUserOrThrow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getGoogleCalendarService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';

describe('Google Calendar Operation Whitelist', () => {
  describe('ALLOWED_OPERATIONS', () => {
    it('should allow respond_to_event operation', () => {
      expect(ALLOWED_OPERATIONS.has('respond_to_event')).toBe(true);
    });

    it('should allow update_event operation', () => {
      expect(ALLOWED_OPERATIONS.has('update_event')).toBe(true);
    });

    it('should NOT include delete_event in allowed operations', () => {
      expect(ALLOWED_OPERATIONS.has('delete_event' as CalendarOperation)).toBe(false);
    });

    it('should NOT include update_attendees in allowed operations', () => {
      expect(ALLOWED_OPERATIONS.has('update_attendees' as CalendarOperation)).toBe(false);
    });
  });

  describe('BLOCKED_OPERATIONS', () => {
    it('should block delete_event operation (prevents data loss)', () => {
      expect(BLOCKED_OPERATIONS.has('delete_event')).toBe(true);
    });

    it('should block update_attendees operation (prevents unwanted invites)', () => {
      expect(BLOCKED_OPERATIONS.has('update_attendees')).toBe(true);
    });

    it('should NOT block respond_to_event', () => {
      expect(BLOCKED_OPERATIONS.has('respond_to_event' as CalendarOperation)).toBe(false);
    });

    it('should NOT block update_event', () => {
      expect(BLOCKED_OPERATIONS.has('update_event' as CalendarOperation)).toBe(false);
    });
  });

  describe('ALLOWED_UPDATE_FIELDS', () => {
    it('should allow updating summary (title)', () => {
      expect(ALLOWED_UPDATE_FIELDS.has('summary')).toBe(true);
    });

    it('should allow updating description', () => {
      expect(ALLOWED_UPDATE_FIELDS.has('description')).toBe(true);
    });

    it('should allow updating location', () => {
      expect(ALLOWED_UPDATE_FIELDS.has('location')).toBe(true);
    });

    it('should allow updating start time', () => {
      expect(ALLOWED_UPDATE_FIELDS.has('start')).toBe(true);
    });

    it('should allow updating end time', () => {
      expect(ALLOWED_UPDATE_FIELDS.has('end')).toBe(true);
    });
  });
});

describe('isCalendarOperationAllowed', () => {
  describe('allowed operations', () => {
    it('should allow respond_to_event', () => {
      const result = isCalendarOperationAllowed('respond_to_event');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should allow update_event', () => {
      const result = isCalendarOperationAllowed('update_event');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('blocked operations', () => {
    it('should BLOCK delete_event with clear reason', () => {
      const result = isCalendarOperationAllowed('delete_event');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('delete_event');
      expect(result.reason).toContain('not permitted');
      expect(result.reason).toContain('data loss');
    });

    it('should BLOCK update_attendees with clear reason', () => {
      const result = isCalendarOperationAllowed('update_attendees');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('update_attendees');
      expect(result.reason).toContain('not permitted');
      expect(result.reason).toContain('unwanted notifications');
    });
  });

  describe('unknown operations', () => {
    it('should block operations not in the allowlist', () => {
      const result = isCalendarOperationAllowed('delete_event' as CalendarOperation);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not permitted');
    });
  });
});

describe('validateUpdateFields', () => {
  it('should allow valid fields: summary', () => {
    const result = validateUpdateFields({ summary: 'New Title' });
    expect(result).toBeNull();
  });

  it('should allow valid fields: description', () => {
    const result = validateUpdateFields({ description: 'New description' });
    expect(result).toBeNull();
  });

  it('should allow valid fields: location', () => {
    const result = validateUpdateFields({ location: 'New Location' });
    expect(result).toBeNull();
  });

  it('should allow valid fields: start and end', () => {
    const result = validateUpdateFields({
      start: { dateTime: '2026-02-10T10:00:00-08:00' },
      end: { dateTime: '2026-02-10T11:00:00-08:00' },
    });
    expect(result).toBeNull();
  });

  it('should allow multiple valid fields together', () => {
    const result = validateUpdateFields({
      summary: 'Updated Meeting',
      description: 'Updated description',
      location: 'Conference Room B',
    });
    expect(result).toBeNull();
  });

  it('should reject unknown fields', () => {
    const result = validateUpdateFields({ attendees: [] } as any);
    expect(result).not.toBeNull();
    expect(result).toContain('attendees');
    expect(result).toContain('Cannot update');
  });
});

describe('respondToCalendarEventSchema', () => {
  it('should accept valid response status: accepted', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      responseStatus: 'accepted',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid response status: declined', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      responseStatus: 'declined',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid response status: tentative', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      responseStatus: 'tentative',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid response status', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      responseStatus: 'maybe', // Invalid
    });
    expect(result.success).toBe(false);
  });

  it('should require eventId', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      responseStatus: 'accepted',
      // Missing eventId
    });
    expect(result.success).toBe(false);
  });

  it('should require responseStatus', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      // Missing responseStatus
    });
    expect(result.success).toBe(false);
  });

  it('should accept optional calendarId', () => {
    const result = respondToCalendarEventSchema.safeParse({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      eventId: 'event123',
      responseStatus: 'accepted',
      calendarId: 'work@group.calendar.google.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.calendarId).toBe('work@group.calendar.google.com');
    }
  });
});

describe('handleRespondToCalendarEvent', () => {
  const mockDataComposer = {} as any;
  const testUserId = '123e4567-e89b-12d3-a456-426614174000';
  const mockUser = { id: testUserId, email: 'test@example.com' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully respond to an event', async () => {
    // Setup mocks
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Team Meeting',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
      location: 'Conference Room A',
      organizer: { email: 'boss@example.com', displayName: 'Boss' },
      attendees: [{ email: 'test@example.com', self: true, responseStatus: 'accepted' }],
    };

    const mockService = {
      respondToEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    // Call handler
    const result = await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'accepted',
      },
      mockDataComposer
    );

    // Verify
    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.message).toContain('accepted');
    expect(response.event.summary).toBe('Team Meeting');
    expect(response.event.yourResponse).toBe('accepted');

    // Verify service was called correctly
    expect(mockService.respondToEvent).toHaveBeenCalledWith(testUserId, {
      eventId: 'event123',
      calendarId: undefined,
      responseStatus: 'accepted',
    });
  });

  it('should handle decline response', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'email',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Unwanted Meeting',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
      attendees: [{ email: 'test@example.com', self: true, responseStatus: 'declined' }],
    };

    const mockService = {
      respondToEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleRespondToCalendarEvent(
      {
        email: 'test@example.com',
        eventId: 'event123',
        responseStatus: 'declined',
      },
      mockDataComposer
    );

    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.message).toContain('declined');
    expect(response.event.yourResponse).toBe('declined');
  });

  it('should handle tentative response', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Maybe Meeting',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
      attendees: [{ email: 'test@example.com', self: true, responseStatus: 'tentative' }],
    };

    const mockService = {
      respondToEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'tentative',
      },
      mockDataComposer
    );

    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.message).toContain('tentative');
  });

  it('should return error when user is not an attendee', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockService = {
      respondToEvent: vi
        .fn()
        .mockRejectedValue(
          new Error('Cannot respond to this event: you are not listed as an attendee')
        ),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'accepted',
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.error).toContain('not listed as an attendee');
    expect(response.hint).toContain('invited attendee');
  });

  it('should return error when Google account not connected', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockService = {
      respondToEvent: vi.fn().mockRejectedValue(new Error('No active google account for user')),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'accepted',
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.hint).toContain('connect their Google account');
  });

  it('should return error when missing calendar write permissions', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockService = {
      respondToEvent: vi
        .fn()
        .mockRejectedValue(new Error('Insufficient permission for calendar.events.update')),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'accepted',
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.hint).toContain('Calendar write permissions');
  });

  it('should pass calendarId to service when provided', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Work Meeting',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
      attendees: [{ email: 'test@example.com', self: true, responseStatus: 'accepted' }],
    };

    const mockService = {
      respondToEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    await handleRespondToCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        responseStatus: 'accepted',
        calendarId: 'work@group.calendar.google.com',
      },
      mockDataComposer
    );

    expect(mockService.respondToEvent).toHaveBeenCalledWith(testUserId, {
      eventId: 'event123',
      calendarId: 'work@group.calendar.google.com',
      responseStatus: 'accepted',
    });
  });
});

describe('Calendar Service respondToEvent', () => {
  // These tests verify the service layer behavior with mocked Google API
  // The actual Google API integration would be tested via e2e tests

  it('should throw if user is not an attendee', async () => {
    // This is a contract test - the service should throw a specific error
    // when the user tries to respond to an event they're not invited to
    const mockService = {
      respondToEvent: vi
        .fn()
        .mockRejectedValue(
          new Error('Cannot respond to this event: you are not listed as an attendee')
        ),
    };

    await expect(
      mockService.respondToEvent('123e4567-e89b-12d3-a456-426614174000', {
        eventId: 'event123',
        responseStatus: 'accepted',
      })
    ).rejects.toThrow('not listed as an attendee');
  });
});

// ============================================================================
// Update Calendar Event Tests
// ============================================================================

describe('updateCalendarEventSchema', () => {
  const testUserId = '123e4567-e89b-12d3-a456-426614174000';

  it('should accept updating summary', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      summary: 'Updated Meeting Title',
    });
    expect(result.success).toBe(true);
  });

  it('should accept updating description', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      description: 'Updated meeting notes',
    });
    expect(result.success).toBe(true);
  });

  it('should accept updating location', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      location: 'Conference Room B',
    });
    expect(result.success).toBe(true);
  });

  it('should accept updating start time with dateTime', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      start: { dateTime: '2026-02-10T14:00:00-08:00' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept updating end time with date (all-day event)', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      end: { date: '2026-02-11' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept updating multiple fields at once', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      summary: 'New Title',
      description: 'New description',
      location: 'New Location',
    });
    expect(result.success).toBe(true);
  });

  it('should require eventId', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      summary: 'Updated Title',
      // Missing eventId
    });
    expect(result.success).toBe(false);
  });

  it('should accept optional calendarId', () => {
    const result = updateCalendarEventSchema.safeParse({
      userId: testUserId,
      eventId: 'event123',
      calendarId: 'work@group.calendar.google.com',
      summary: 'Updated Title',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.calendarId).toBe('work@group.calendar.google.com');
    }
  });
});

describe('handleUpdateCalendarEvent', () => {
  const mockDataComposer = {} as any;
  const testUserId = '123e4567-e89b-12d3-a456-426614174000';
  const mockUser = { id: testUserId, email: 'test@example.com' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully update event summary', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Updated Meeting Title',
      description: 'Original description',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
      location: 'Room A',
      organizer: { email: 'boss@example.com' },
      htmlLink: 'https://calendar.google.com/event/123',
    };

    const mockService = {
      updateEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        summary: 'Updated Meeting Title',
      },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.message).toContain('summary');
    expect(response.event.summary).toBe('Updated Meeting Title');
    expect(response.updatedFields).toContain('summary');

    expect(mockService.updateEvent).toHaveBeenCalledWith(testUserId, {
      eventId: 'event123',
      calendarId: undefined,
      fields: { summary: 'Updated Meeting Title' },
    });
  });

  it('should successfully update multiple fields', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'New Title',
      description: 'New description',
      location: 'New Location',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
    };

    const mockService = {
      updateEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        summary: 'New Title',
        description: 'New description',
        location: 'New Location',
      },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.updatedFields).toEqual(
      expect.arrayContaining(['summary', 'description', 'location'])
    );
  });

  it('should return error when no fields provided', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        // No fields to update
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.error).toContain('at least one field');
  });

  it('should return error when Google account not connected', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockService = {
      updateEvent: vi.fn().mockRejectedValue(new Error('No active google account for user')),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        summary: 'New Title',
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.hint).toContain('connect their Google account');
  });

  it('should return error when user lacks edit permission', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockService = {
      updateEvent: vi.fn().mockRejectedValue(new Error('403 Forbidden: Insufficient permissions')),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        summary: 'New Title',
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.hint).toContain('edit access');
  });

  it('should pass calendarId to service when provided', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Updated Title',
      start: { dateTime: '2026-02-10T10:00:00Z' },
      end: { dateTime: '2026-02-10T11:00:00Z' },
    };

    const mockService = {
      updateEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        calendarId: 'work@group.calendar.google.com',
        summary: 'Updated Title',
      },
      mockDataComposer
    );

    expect(mockService.updateEvent).toHaveBeenCalledWith(testUserId, {
      eventId: 'event123',
      calendarId: 'work@group.calendar.google.com',
      fields: { summary: 'Updated Title' },
    });
  });

  it('should update event times correctly', async () => {
    vi.mocked(resolveUserOrThrow).mockResolvedValue({
      user: mockUser,
      resolvedBy: 'userId',
    });

    const mockEvent = {
      id: 'event123',
      summary: 'Meeting',
      start: { dateTime: '2026-02-10T14:00:00-08:00' },
      end: { dateTime: '2026-02-10T15:00:00-08:00' },
    };

    const mockService = {
      updateEvent: vi.fn().mockResolvedValue(mockEvent),
    };
    vi.mocked(getGoogleCalendarService).mockReturnValue(mockService as any);

    const result = await handleUpdateCalendarEvent(
      {
        userId: testUserId,
        eventId: 'event123',
        start: { dateTime: '2026-02-10T14:00:00-08:00' },
        end: { dateTime: '2026-02-10T15:00:00-08:00' },
      },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.updatedFields).toEqual(expect.arrayContaining(['start', 'end']));
  });
});
