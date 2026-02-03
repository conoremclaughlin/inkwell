/**
 * Activity Stream Repository Tests
 *
 * Tests for the unified activity log that captures everything an SB does:
 * messages, tool calls, agent spawns, state changes, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityStreamRepository } from './activity-stream.repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('ActivityStreamRepository', () => {
  let mockSupabase: MockSupabaseClient;
  let repo: ActivityStreamRepository;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    repo = new ActivityStreamRepository(mockSupabase as unknown as SupabaseClient);
  });

  describe('logActivity', () => {
    it('should log a basic activity event', async () => {
      const mockActivityRow = {
        id: 'act-123',
        user_id: 'user-456',
        agent_id: 'myra',
        type: 'message_in',
        content: 'Hello from Telegram!',
        subtype: null,
        payload: {},
        contact_id: null,
        parent_id: null,
        correlation_id: null,
        platform: 'telegram',
        platform_message_id: 'tg-msg-789',
        platform_chat_id: 'tg-chat-123',
        is_dm: true,
        artifact_id: null,
        child_session_id: null,
        session_id: null,
        created_at: '2026-02-02T12:00:00Z',
        completed_at: null,
        duration_ms: null,
        status: 'completed',
      };

      mockSupabase._setReturnData(mockActivityRow);

      const result = await repo.logActivity({
        userId: 'user-456',
        agentId: 'myra',
        type: 'message_in',
        content: 'Hello from Telegram!',
        platform: 'telegram',
        platformMessageId: 'tg-msg-789',
        platformChatId: 'tg-chat-123',
        isDm: true,
      });

      expect(result.id).toBe('act-123');
      expect(result.type).toBe('message_in');
      expect(result.agentId).toBe('myra');
      expect(result.platform).toBe('telegram');
      expect(result.platformMessageId).toBe('tg-msg-789');
      expect(result.isDm).toBe(true);
      expect(mockSupabase.from).toHaveBeenCalledWith('activity_stream');
    });

    it('should log a tool_call activity with payload', async () => {
      const mockActivityRow = {
        id: 'act-456',
        user_id: 'user-456',
        agent_id: 'wren',
        type: 'tool_call',
        content: 'Searching for files...',
        subtype: 'Glob',
        payload: { pattern: '**/*.ts', path: '/src' },
        contact_id: null,
        parent_id: null,
        correlation_id: 'corr-123',
        platform: null,
        platform_message_id: null,
        platform_chat_id: null,
        is_dm: true,
        artifact_id: null,
        child_session_id: null,
        session_id: 'session-789',
        created_at: '2026-02-02T12:00:00Z',
        completed_at: null,
        duration_ms: null,
        status: 'running',
      };

      mockSupabase._setReturnData(mockActivityRow);

      const result = await repo.logActivity({
        userId: 'user-456',
        agentId: 'wren',
        type: 'tool_call',
        content: 'Searching for files...',
        subtype: 'Glob',
        payload: { pattern: '**/*.ts', path: '/src' },
        sessionId: 'session-789',
        correlationId: 'corr-123',
        status: 'running',
      });

      expect(result.type).toBe('tool_call');
      expect(result.subtype).toBe('Glob');
      expect(result.payload).toEqual({ pattern: '**/*.ts', path: '/src' });
      expect(result.status).toBe('running');
      expect(result.correlationId).toBe('corr-123');
    });

    it('should throw on database error', async () => {
      mockSupabase._setReturnData(null, { message: 'Database error' });

      await expect(
        repo.logActivity({
          userId: 'user-456',
          agentId: 'myra',
          type: 'message_in',
          content: 'Test',
        })
      ).rejects.toThrow('Failed to log activity: Database error');
    });
  });

  describe('logMessage', () => {
    it('should log an inbound Telegram message', async () => {
      const mockActivityRow = {
        id: 'act-123',
        user_id: 'user-456',
        agent_id: 'myra',
        type: 'message_in',
        content: 'Hey Myra, can you help me with something?',
        subtype: null,
        payload: { senderName: 'Conor' },
        contact_id: 'contact-789',
        parent_id: null,
        correlation_id: null,
        platform: 'telegram',
        platform_message_id: 'tg-12345',
        platform_chat_id: 'tg-chat-67890',
        is_dm: true,
        artifact_id: null,
        child_session_id: null,
        session_id: 'session-abc',
        created_at: '2026-02-02T12:00:00Z',
        completed_at: null,
        duration_ms: null,
        status: 'completed',
      };

      mockSupabase._setReturnData(mockActivityRow);

      const result = await repo.logMessage({
        userId: 'user-456',
        agentId: 'myra',
        direction: 'in',
        content: 'Hey Myra, can you help me with something?',
        sessionId: 'session-abc',
        contactId: 'contact-789',
        platform: 'telegram',
        platformMessageId: 'tg-12345',
        platformChatId: 'tg-chat-67890',
        isDm: true,
        payload: { senderName: 'Conor' },
      });

      expect(result.type).toBe('message_in');
      expect(result.content).toBe('Hey Myra, can you help me with something?');
      expect(result.platform).toBe('telegram');
      expect(result.contactId).toBe('contact-789');
      expect(result.isDm).toBe(true);
    });

    it('should log an outbound Telegram message', async () => {
      const mockActivityRow = {
        id: 'act-456',
        user_id: 'user-456',
        agent_id: 'myra',
        type: 'message_out',
        content: 'Of course! What do you need help with?',
        subtype: null,
        payload: {},
        contact_id: 'contact-789',
        parent_id: null,
        correlation_id: null,
        platform: 'telegram',
        platform_message_id: 'tg-12346',
        platform_chat_id: 'tg-chat-67890',
        is_dm: true,
        artifact_id: null,
        child_session_id: null,
        session_id: 'session-abc',
        created_at: '2026-02-02T12:01:00Z',
        completed_at: null,
        duration_ms: null,
        status: 'completed',
      };

      mockSupabase._setReturnData(mockActivityRow);

      const result = await repo.logMessage({
        userId: 'user-456',
        agentId: 'myra',
        direction: 'out',
        content: 'Of course! What do you need help with?',
        sessionId: 'session-abc',
        contactId: 'contact-789',
        platform: 'telegram',
        platformMessageId: 'tg-12346',
        platformChatId: 'tg-chat-67890',
        isDm: true,
      });

      expect(result.type).toBe('message_out');
      expect(result.content).toBe('Of course! What do you need help with?');
      expect(result.platform).toBe('telegram');
    });
  });

  describe('getConversationHistory', () => {
    it('should retrieve messages in chronological order', async () => {
      const mockMessages = [
        {
          id: 'act-1',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_in',
          content: 'Hello!',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-1',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: null,
          created_at: '2026-02-02T12:00:00Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
        {
          id: 'act-2',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_out',
          content: 'Hi there!',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-2',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: null,
          created_at: '2026-02-02T12:01:00Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
      ];

      mockSupabase._setArrayData(mockMessages);

      const result = await repo.getConversationHistory('user-456', {
        contactId: 'contact-789',
        platform: 'telegram',
        isDm: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('message_in');
      expect(result[0].content).toBe('Hello!');
      expect(result[1].type).toBe('message_out');
      expect(result[1].content).toBe('Hi there!');

      // Verify query was built correctly
      expect(mockSupabase.from).toHaveBeenCalledWith('activity_stream');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-456');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('contact_id', 'contact-789');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('platform', 'telegram');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('is_dm', true);
      expect(mockSupabase._queryBuilder.in).toHaveBeenCalledWith('type', ['message_in', 'message_out']);
    });

    it('should support pagination with limit and offset', async () => {
      const mockMessages = [
        {
          id: 'act-3',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_in',
          content: 'Third message',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-3',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: null,
          created_at: '2026-02-02T12:02:00Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
      ];

      mockSupabase._setArrayData(mockMessages);

      const result = await repo.getConversationHistory('user-456', {
        contactId: 'contact-789',
        limit: 10,
        offset: 2,
      });

      expect(result).toHaveLength(1);
      expect(mockSupabase._queryBuilder.range).toHaveBeenCalledWith(2, 11);
    });
  });

  describe('getSessionResumptionContext', () => {
    it('should load recent activity for session context', async () => {
      const mockActivities = [
        {
          id: 'act-1',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_in',
          content: 'Can you check my calendar?',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-1',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: 'session-abc',
          created_at: '2026-02-02T12:00:00Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
        {
          id: 'act-2',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'tool_call',
          content: 'Looking up calendar...',
          subtype: 'list_calendar_events',
          payload: { calendarId: 'primary' },
          contact_id: null,
          parent_id: null,
          correlation_id: null,
          platform: null,
          platform_message_id: null,
          platform_chat_id: null,
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: 'session-abc',
          created_at: '2026-02-02T12:00:01Z',
          completed_at: '2026-02-02T12:00:02Z',
          duration_ms: 1000,
          status: 'completed',
        },
        {
          id: 'act-3',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_out',
          content: 'You have a meeting at 3pm today.',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-2',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: 'session-abc',
          created_at: '2026-02-02T12:00:03Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
      ];

      // Note: The data comes back in reverse order from the query, then is reversed again
      mockSupabase._setArrayData([...mockActivities].reverse());

      const result = await repo.getSessionResumptionContext('user-456', {
        sessionId: 'session-abc',
        limit: 20,
      });

      // Result should be in chronological order after reversal
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('Can you check my calendar?');
      expect(result[1].type).toBe('tool_call');
      expect(result[2].content).toBe('You have a meeting at 3pm today.');
    });

    it('should load context for a specific contact', async () => {
      const mockActivities = [
        {
          id: 'act-1',
          user_id: 'user-456',
          agent_id: 'myra',
          type: 'message_in',
          content: 'Hey there!',
          subtype: null,
          payload: {},
          contact_id: 'contact-789',
          parent_id: null,
          correlation_id: null,
          platform: 'telegram',
          platform_message_id: 'tg-1',
          platform_chat_id: 'tg-chat-123',
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: null,
          created_at: '2026-02-02T12:00:00Z',
          completed_at: null,
          duration_ms: null,
          status: 'completed',
        },
      ];

      mockSupabase._setArrayData(mockActivities);

      const result = await repo.getSessionResumptionContext('user-456', {
        contactId: 'contact-789',
        platform: 'telegram',
      });

      expect(result).toHaveLength(1);
      expect(result[0].contactId).toBe('contact-789');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('contact_id', 'contact-789');
    });
  });

  describe('getActivity', () => {
    it('should filter by activity types', async () => {
      const mockActivities = [
        {
          id: 'act-1',
          user_id: 'user-456',
          agent_id: 'wren',
          type: 'tool_call',
          content: 'Reading file...',
          subtype: 'Read',
          payload: { file_path: '/src/index.ts' },
          contact_id: null,
          parent_id: null,
          correlation_id: null,
          platform: null,
          platform_message_id: null,
          platform_chat_id: null,
          is_dm: true,
          artifact_id: null,
          child_session_id: null,
          session_id: 'session-123',
          created_at: '2026-02-02T12:00:00Z',
          completed_at: '2026-02-02T12:00:01Z',
          duration_ms: 1000,
          status: 'completed',
        },
      ];

      mockSupabase._setArrayData(mockActivities);

      const result = await repo.getActivity('user-456', {
        types: ['tool_call', 'tool_result'],
        sessionId: 'session-123',
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('tool_call');
      expect(mockSupabase._queryBuilder.in).toHaveBeenCalledWith('type', ['tool_call', 'tool_result']);
    });

    it('should filter by date range', async () => {
      const mockActivities: unknown[] = [];
      mockSupabase._setArrayData(mockActivities);

      await repo.getActivity('user-456', {
        since: new Date('2026-02-01T00:00:00Z'),
        until: new Date('2026-02-02T00:00:00Z'),
      });

      expect(mockSupabase._queryBuilder.gte).toHaveBeenCalledWith('created_at', '2026-02-01T00:00:00.000Z');
      expect(mockSupabase._queryBuilder.lte).toHaveBeenCalledWith('created_at', '2026-02-02T00:00:00.000Z');
    });

    it('should support correlation ID filtering', async () => {
      const mockActivities: unknown[] = [];
      mockSupabase._setArrayData(mockActivities);

      await repo.getActivity('user-456', {
        correlationId: 'research-trail-123',
      });

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('correlation_id', 'research-trail-123');
    });
  });

  describe('completeActivity', () => {
    it('should mark an activity as completed with duration', async () => {
      // First call for fetching original activity
      const originalActivity = {
        created_at: '2026-02-02T12:00:00.000Z',
      };

      // Second call for update result
      const updatedActivity = {
        id: 'act-123',
        user_id: 'user-456',
        agent_id: 'wren',
        type: 'tool_call',
        content: 'File read successfully',
        subtype: 'Read',
        payload: { result: 'file contents...' },
        contact_id: null,
        parent_id: null,
        correlation_id: null,
        platform: null,
        platform_message_id: null,
        platform_chat_id: null,
        is_dm: true,
        artifact_id: null,
        child_session_id: null,
        session_id: 'session-123',
        created_at: '2026-02-02T12:00:00.000Z',
        completed_at: '2026-02-02T12:00:01.000Z',
        duration_ms: 1000,
        status: 'completed',
      };

      // Mock the sequence of calls
      let callCount = 0;
      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ data: originalActivity, error: null });
        }
        return Promise.resolve({ data: updatedActivity, error: null });
      });

      const result = await repo.completeActivity('act-123', {
        content: 'File read successfully',
        payload: { result: 'file contents...' },
      });

      expect(result.completedAt).not.toBeNull();
      expect(result.status).toBe('completed');
      expect(result.durationMs).toBe(1000);
    });
  });
});
