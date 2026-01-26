/**
 * Memory Repository Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRepository } from './memory-repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('MemoryRepository', () => {
  let mockSupabase: MockSupabaseClient;
  let repo: MemoryRepository;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    repo = new MemoryRepository(mockSupabase as unknown as SupabaseClient);
  });

  describe('remember', () => {
    it('should create a memory with required fields', async () => {
      const mockMemoryRow = {
        id: 'mem-123',
        user_id: 'user-456',
        content: 'Test memory content',
        source: 'observation',
        salience: 'medium',
        topics: [],
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-01-26T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockMemoryRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Test memory content',
      });

      expect(result).toEqual({
        id: 'mem-123',
        userId: 'user-456',
        content: 'Test memory content',
        source: 'observation',
        salience: 'medium',
        topics: [],
        embedding: undefined,
        metadata: {},
        version: 1,
        createdAt: new Date('2026-01-26T12:00:00Z'),
        expiresAt: undefined,
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('memories');
    });

    it('should include optional fields when provided', async () => {
      const mockMemoryRow = {
        id: 'mem-123',
        user_id: 'user-456',
        content: 'Important memory',
        source: 'user_stated',
        salience: 'high',
        topics: ['work', 'project'],
        embedding: null,
        metadata: { key: 'value' },
        version: 1,
        created_at: '2026-01-26T12:00:00Z',
        expires_at: '2026-02-26T12:00:00Z',
      };

      mockSupabase._setReturnData(mockMemoryRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Important memory',
        source: 'user_stated',
        salience: 'high',
        topics: ['work', 'project'],
        metadata: { key: 'value' },
        expiresAt: new Date('2026-02-26T12:00:00Z'),
      });

      expect(result.source).toBe('user_stated');
      expect(result.salience).toBe('high');
      expect(result.topics).toEqual(['work', 'project']);
      expect(result.metadata).toEqual({ key: 'value' });
      expect(result.expiresAt).toEqual(new Date('2026-02-26T12:00:00Z'));
    });

    it('should throw on database error', async () => {
      mockSupabase._setReturnData(null, { message: 'Database error' });

      await expect(repo.remember({
        userId: 'user-456',
        content: 'Test',
      })).rejects.toThrow('Failed to create memory: Database error');
    });
  });

  describe('recall', () => {
    it('should return memories for a user', async () => {
      const mockMemories = [
        {
          id: 'mem-1',
          user_id: 'user-456',
          content: 'Memory 1',
          source: 'observation',
          salience: 'medium',
          topics: [],
          embedding: null,
          metadata: {},
          version: 1,
          created_at: '2026-01-26T12:00:00Z',
          expires_at: null,
        },
        {
          id: 'mem-2',
          user_id: 'user-456',
          content: 'Memory 2',
          source: 'conversation',
          salience: 'high',
          topics: ['important'],
          embedding: null,
          metadata: {},
          version: 1,
          created_at: '2026-01-25T12:00:00Z',
          expires_at: null,
        },
      ];

      mockSupabase._setArrayData(mockMemories);

      const results = await repo.recall('user-456');

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-1');
      expect(results[1].id).toBe('mem-2');
      expect(mockSupabase.from).toHaveBeenCalledWith('memories');
    });

    it('should apply text search filter', async () => {
      mockSupabase._setArrayData([]);

      await repo.recall('user-456', 'search term');

      expect(mockSupabase._queryBuilder.ilike).toHaveBeenCalledWith('content', '%search term%');
    });

    it('should apply salience filter', async () => {
      mockSupabase._setArrayData([]);

      await repo.recall('user-456', undefined, { salience: 'high' });

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('salience', 'high');
    });

    it('should apply topics filter', async () => {
      mockSupabase._setArrayData([]);

      await repo.recall('user-456', undefined, { topics: ['work', 'ai'] });

      expect(mockSupabase._queryBuilder.overlaps).toHaveBeenCalledWith('topics', ['work', 'ai']);
    });
  });

  describe('forget', () => {
    it('should delete a memory', async () => {
      // Set up no error for the delete operation
      mockSupabase._setReturnData(null, null);

      const result = await repo.forget('mem-123', 'user-456');

      expect(result).toBe(true);
      expect(mockSupabase.from).toHaveBeenCalledWith('memories');
      expect(mockSupabase._queryBuilder.delete).toHaveBeenCalled();
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('id', 'mem-123');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-456');
    });
  });

  describe('updateMemory', () => {
    it('should update memory fields', async () => {
      const mockUpdatedRow = {
        id: 'mem-123',
        user_id: 'user-456',
        content: 'Original content',
        source: 'observation',
        salience: 'critical',
        topics: ['updated', 'topics'],
        embedding: null,
        metadata: { new: 'metadata' },
        version: 2,
        created_at: '2026-01-26T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockUpdatedRow);

      const result = await repo.updateMemory('mem-123', 'user-456', {
        salience: 'critical',
        topics: ['updated', 'topics'],
        metadata: { new: 'metadata' },
      });

      expect(result?.salience).toBe('critical');
      expect(result?.topics).toEqual(['updated', 'topics']);
      expect(result?.metadata).toEqual({ new: 'metadata' });
    });

    it('should return null if memory not found', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      const result = await repo.updateMemory('nonexistent', 'user-456', {
        salience: 'high',
      });

      expect(result).toBeNull();
    });
  });

  describe('Session Management', () => {
    describe('startSession', () => {
      it('should create a new session', async () => {
        const mockSessionRow = {
          id: 'session-123',
          user_id: 'user-456',
          agent_id: 'claude-code',
          started_at: '2026-01-26T12:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.startSession({
          userId: 'user-456',
          agentId: 'claude-code',
        });

        expect(result.id).toBe('session-123');
        expect(result.userId).toBe('user-456');
        expect(result.agentId).toBe('claude-code');
        expect(result.endedAt).toBeUndefined();
      });
    });

    describe('endSession', () => {
      it('should end a session with summary', async () => {
        const mockSessionRow = {
          id: 'session-123',
          user_id: 'user-456',
          agent_id: 'claude-code',
          started_at: '2026-01-26T12:00:00Z',
          ended_at: '2026-01-26T14:00:00Z',
          summary: 'Session summary here',
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.endSession('session-123', 'Session summary here');

        expect(result?.endedAt).toEqual(new Date('2026-01-26T14:00:00Z'));
        expect(result?.summary).toBe('Session summary here');
      });
    });

    describe('getActiveSession', () => {
      it('should return active session for user', async () => {
        const mockSessionRow = {
          id: 'session-123',
          user_id: 'user-456',
          agent_id: 'claude-code',
          started_at: '2026-01-26T12:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.getActiveSession('user-456');

        expect(result?.id).toBe('session-123');
        expect(result?.endedAt).toBeUndefined();
        expect(mockSupabase._queryBuilder.is).toHaveBeenCalledWith('ended_at', null);
      });

      it('should return null if no active session', async () => {
        mockSupabase._setReturnData(null, { code: 'PGRST116' });

        const result = await repo.getActiveSession('user-456');

        expect(result).toBeNull();
      });
    });
  });

  describe('Session Logs', () => {
    describe('addSessionLog', () => {
      it('should add a log entry', async () => {
        const mockLogRow = {
          id: 'log-123',
          session_id: 'session-456',
          content: 'Log content',
          salience: 'medium',
          created_at: '2026-01-26T12:00:00Z',
        };

        mockSupabase._setReturnData(mockLogRow);

        const result = await repo.addSessionLog({
          sessionId: 'session-456',
          content: 'Log content',
          salience: 'medium',
        });

        expect(result.id).toBe('log-123');
        expect(result.content).toBe('Log content');
        expect(result.salience).toBe('medium');
      });
    });

    describe('markLogsCompacted', () => {
      it('should soft-delete logs by marking them compacted', async () => {
        mockSupabase._queryBuilder.select.mockResolvedValue({
          data: [{ id: 'log-1' }, { id: 'log-2' }],
          error: null,
        });

        const count = await repo.markLogsCompacted('session-123', 'mem-456');

        expect(count).toBe(2);
        expect(mockSupabase._queryBuilder.update).toHaveBeenCalled();
        expect(mockSupabase._queryBuilder.is).toHaveBeenCalledWith('compacted_at', null);
      });
    });

    describe('getSessionLogsBySalience', () => {
      it('should filter by minimum salience', async () => {
        mockSupabase._setArrayData([]);

        await repo.getSessionLogsBySalience('session-123', 'high');

        // Should include 'high' and 'critical'
        expect(mockSupabase._queryBuilder.in).toHaveBeenCalledWith('salience', ['high', 'critical']);
      });

      it('should exclude compacted logs by default', async () => {
        mockSupabase._setArrayData([]);

        await repo.getSessionLogsBySalience('session-123', 'medium');

        expect(mockSupabase._queryBuilder.is).toHaveBeenCalledWith('compacted_at', null);
      });
    });
  });
});
