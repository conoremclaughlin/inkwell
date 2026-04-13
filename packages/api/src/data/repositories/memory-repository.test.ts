/**
 * Memory Repository Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRepository, computeKnowledgeMemoryScore } from './memory-repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('MemoryRepository', () => {
  let mockSupabase: MockSupabaseClient;
  let repo: MemoryRepository;
  const disableEmbeddings = () => {
    (repo as any).embeddingRouter = {
      isEnabled: vi.fn().mockReturnValue(false),
    };
  };

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    repo = new MemoryRepository(mockSupabase as unknown as SupabaseClient);
  });

  describe('remember', () => {
    it('should create a memory with required fields', async () => {
      disableEmbeddings();
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
      disableEmbeddings();
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

    it('should support reflection source type for agent reflections', async () => {
      disableEmbeddings();
      const mockMemoryRow = {
        id: 'mem-123',
        user_id: 'user-456',
        content: 'Reflection on recent experiences: I notice patterns in how I approach problems.',
        source: 'reflection',
        salience: 'high',
        topics: ['self-awareness', 'growth'],
        embedding: null,
        metadata: { agentId: 'wren', reflectionType: 'periodic' },
        version: 1,
        created_at: '2026-01-26T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockMemoryRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Reflection on recent experiences: I notice patterns in how I approach problems.',
        source: 'reflection',
        salience: 'high',
        topics: ['self-awareness', 'growth'],
        metadata: { agentId: 'wren', reflectionType: 'periodic' },
      });

      expect(result.source).toBe('reflection');
      expect(result.topics).toContain('self-awareness');
      expect(result.metadata).toHaveProperty('agentId', 'wren');
    });

    it('should throw on database error', async () => {
      disableEmbeddings();
      mockSupabase._setReturnData(null, { message: 'Database error' });

      await expect(
        repo.remember({
          userId: 'user-456',
          content: 'Test',
        })
      ).rejects.toThrow('Failed to create memory: Database error');
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

      await repo.recall('user-456', 'search term', { recallMode: 'text' });

      expect(mockSupabase._queryBuilder.or).toHaveBeenCalledWith(
        'content.ilike.%search term%,summary.ilike.%search term%,topic_key.ilike.%search term%,content.ilike.%search%,summary.ilike.%search%,topic_key.ilike.%search%,content.ilike.%term%,summary.ilike.%term%,topic_key.ilike.%term%'
      );
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

    it('passes semantic chunk type filters through to chunked semantic recall', async () => {
      const semanticSpy = vi
        .spyOn(repo as any, 'trySemanticRecallCandidates')
        .mockResolvedValue([]);

      await repo.recall('user-456', 'latest policy', {
        recallMode: 'semantic',
        semanticChunkTypes: ['content'],
        applyChunkTypeBoosts: false,
      });

      expect(semanticSpy).toHaveBeenCalledWith(
        'user-456',
        'latest policy',
        expect.objectContaining({
          recallMode: 'semantic',
          semanticChunkTypes: ['content'],
          applyChunkTypeBoosts: false,
        }),
        20,
        0,
        ['content']
      );
    });

    it('supports hybrid content-only ablations without derived semantic pass', async () => {
      const textMemory = {
        id: 'mem-text',
        userId: 'user-456',
        content: 'latest policy',
        source: 'observation',
        salience: 'medium',
        topics: [],
        metadata: {},
        version: 1,
        createdAt: new Date('2026-01-26T12:00:00Z'),
      };

      const semanticSpy = vi
        .spyOn(repo as any, 'trySemanticRecallCandidates')
        .mockImplementation(async (_userId, _query, _options, _limit, _offset, chunkTypes) => {
          if (Array.isArray(chunkTypes) && chunkTypes.includes('content')) {
            return [
              {
                memory: textMemory,
                semanticScore: 0.8,
                matchedChunkType: 'content',
                finalScore: 0.8,
              },
            ];
          }

          return [];
        });
      vi.spyOn(repo as any, 'textRecallCandidates').mockResolvedValue([
        {
          memory: textMemory,
          textScore: 1,
          finalScore: 1,
        },
      ]);

      const results = await repo.recall('user-456', 'latest policy', {
        recallMode: 'hybrid',
        hybridChunkStrategy: 'content-only',
        applyChunkTypeBoosts: false,
        applyMultiViewBoost: false,
        applyChronologyBoost: false,
      });

      expect(results).toHaveLength(1);
      expect(semanticSpy).toHaveBeenCalledTimes(1);
      expect(semanticSpy).toHaveBeenCalledWith(
        'user-456',
        'latest policy',
        expect.objectContaining({
          hybridChunkStrategy: 'content-only',
          applyChunkTypeBoosts: false,
          applyMultiViewBoost: false,
          applyChronologyBoost: false,
        }),
        expect.any(Number),
        0,
        ['content']
      );
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
          studio_id: null,
          workspace_id: null,
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
        expect(result.studioId).toBeUndefined();
        expect(result.studioId).toBeUndefined();
        expect(result.endedAt).toBeUndefined();
      });

      it('should include studio_id in insert when studioId is provided', async () => {
        const mockSessionRow = {
          id: 'session-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: 'ws-abc-123',
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.startSession({
          userId: 'user-456',
          agentId: 'wren',
          studioId: 'ws-abc-123',
        });

        expect(result.studioId).toBe('ws-abc-123');
        expect(result.studioId).toBe('ws-abc-123');

        expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            studio_id: 'ws-abc-123',
          })
        );
        const insertCall = mockSupabase._queryBuilder.insert.mock.calls[0][0];
        expect(insertCall).not.toHaveProperty('workspace_id');
      });

      it('should write studio_id from studioId input', async () => {
        const mockSessionRow = {
          id: 'session-studio-wins',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: 'studio-abc',
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        await repo.startSession({
          userId: 'user-456',
          agentId: 'wren',
          studioId: 'studio-abc',
        });

        expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            studio_id: 'studio-abc',
          })
        );
      });

      it('should not include studio_id in insert when studioId is omitted', async () => {
        const mockSessionRow = {
          id: 'session-no-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: null,
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        await repo.startSession({
          userId: 'user-456',
          agentId: 'wren',
        });

        const insertCall = mockSupabase._queryBuilder.insert.mock.calls[0][0];
        expect(insertCall).not.toHaveProperty('studio_id');
      });
    });

    describe('endSession', () => {
      it('should end a session with summary', async () => {
        const mockSessionRow = {
          id: 'session-123',
          user_id: 'user-456',
          agent_id: 'claude-code',
          studio_id: null,
          workspace_id: null,
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
          studio_id: null,
          workspace_id: null,
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

      it('should not filter by studio when studioId is undefined (backward compat)', async () => {
        const mockSessionRow = {
          id: 'session-any-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: 'ws-something',
          workspace_id: 'ws-something',
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.getActiveSession('user-456', 'wren');

        expect(result).not.toBeNull();
        // studio_id should not have been used as a filter
        // eq should have been called for user_id and agent_id but NOT studio_id
        const eqCalls = mockSupabase._queryBuilder.eq.mock.calls;
        const wsEqCalls = eqCalls.filter(([col]: [string]) => col === 'studio_id');
        expect(wsEqCalls).toHaveLength(0);

        const isCalls = mockSupabase._queryBuilder.is.mock.calls;
        const wsIsCalls = isCalls.filter(([col]: [string]) => col === 'studio_id');
        expect(wsIsCalls).toHaveLength(0);
      });

      it('should filter for null studio when studioId is explicitly null', async () => {
        const mockSessionRow = {
          id: 'session-no-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: null,
          workspace_id: null,
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        await repo.getActiveSession('user-456', 'wren', null);

        // Should have called is('studio_id', null)
        expect(mockSupabase._queryBuilder.is).toHaveBeenCalledWith('studio_id', null);
      });

      it('should filter for specific studio when studioId is a string', async () => {
        const mockSessionRow = {
          id: 'session-specific-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: 'ws-xyz',
          workspace_id: 'ws-xyz',
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        await repo.getActiveSession('user-456', 'wren', 'ws-xyz');

        // Should have called eq('studio_id', 'ws-xyz')
        expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('studio_id', 'ws-xyz');
      });
    });

    describe('listSessions', () => {
      it('should filter by studioId when provided', async () => {
        mockSupabase._setArrayData([]);

        await repo.listSessions('user-456', { studioId: 'studio-filter' });

        expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('studio_id', 'studio-filter');
      });

      it('should not filter by studio when studioId is omitted', async () => {
        mockSupabase._setArrayData([]);

        await repo.listSessions('user-456', { agentId: 'wren' });

        const eqCalls = mockSupabase._queryBuilder.eq.mock.calls;
        const wsEqCalls = eqCalls.filter(([col]: [string]) => col === 'studio_id');
        expect(wsEqCalls).toHaveLength(0);
      });
    });

    describe('rowToSession mapping', () => {
      it('should map studio_id to studioId', async () => {
        const mockSessionRow = {
          id: 'session-map',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: 'studio-mapped',
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.getSession('session-map');
        expect(result!.studioId).toBe('studio-mapped');
        expect(result!.studioId).toBe('studio-mapped');
      });

      it('should map null studio_id to undefined', async () => {
        const mockSessionRow = {
          id: 'session-null-ws',
          user_id: 'user-456',
          agent_id: 'wren',
          studio_id: null,
          started_at: '2026-02-10T00:00:00Z',
          ended_at: null,
          summary: null,
          metadata: {},
        };

        mockSupabase._setReturnData(mockSessionRow);

        const result = await repo.getSession('session-null-ws');
        expect(result!.studioId).toBeUndefined();
        expect(result!.studioId).toBeUndefined();
      });
    });
  });

  // =====================================================
  // updateSession (unified session state management)
  // =====================================================

  describe('updateSession', () => {
    const mockSessionRow = {
      id: 'session-123',
      user_id: 'user-123',
      agent_id: 'wren',
      studio_id: null,
      workspace_id: null,
      current_phase: 'implementing',
      started_at: '2026-02-10T10:00:00Z',
      ended_at: null,
      summary: null,
      metadata: {},
      status: 'active',
      backend_session_id: null,
      claude_session_id: null,
      context: null,
      working_dir: null,
    };

    it('should update current_phase', async () => {
      mockSupabase._setReturnData({ ...mockSessionRow, current_phase: 'reviewing' });

      const result = await repo.updateSession('session-123', {
        currentPhase: 'reviewing',
      });

      expect(result).not.toBeNull();
      expect(result!.currentPhase).toBe('reviewing');

      expect(mockSupabase.from).toHaveBeenCalledWith('sessions');
      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.current_phase).toBe('reviewing');
      // updated_at is handled by DB trigger, not the repository
      expect(updateCall).not.toHaveProperty('updated_at');
    });

    it('should update backendSessionId and also set claude_session_id for backward compat', async () => {
      mockSupabase._setReturnData({
        ...mockSessionRow,
        backend_session_id: 'claude-abc123',
        claude_session_id: 'claude-abc123',
      });

      await repo.updateSession('session-123', {
        backendSessionId: 'claude-abc123',
      });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.backend_session_id).toBe('claude-abc123');
      expect(updateCall.claude_session_id).toBe('claude-abc123');
    });

    it('should update status', async () => {
      mockSupabase._setReturnData({ ...mockSessionRow, status: 'resumable' });

      await repo.updateSession('session-123', { status: 'resumable' });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.status).toBe('resumable');
    });

    it('should update context and workingDir', async () => {
      mockSupabase._setReturnData(mockSessionRow);

      await repo.updateSession('session-123', {
        context: 'Working on tests',
        workingDir: '/Users/test/project',
      });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.context).toBe('Working on tests');
      expect(updateCall.working_dir).toBe('/Users/test/project');
    });

    it('should update multiple fields at once', async () => {
      mockSupabase._setReturnData(mockSessionRow);

      await repo.updateSession('session-123', {
        currentPhase: 'implementing',
        status: 'active',
        backendSessionId: 'abc',
        context: 'Building feature',
        workingDir: '/tmp',
      });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.current_phase).toBe('implementing');
      expect(updateCall.status).toBe('active');
      expect(updateCall.backend_session_id).toBe('abc');
      expect(updateCall.claude_session_id).toBe('abc');
      expect(updateCall.context).toBe('Building feature');
      expect(updateCall.working_dir).toBe('/tmp');
      // updated_at is handled by DB trigger, not the repository
      expect(updateCall).not.toHaveProperty('updated_at');
    });

    it('should only include provided fields in update (no undefined pollution)', async () => {
      mockSupabase._setReturnData(mockSessionRow);

      await repo.updateSession('session-123', {
        currentPhase: 'investigating',
      });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.current_phase).toBe('investigating');
      // updated_at is handled by DB trigger, not the repository
      expect(updateCall).not.toHaveProperty('updated_at');
      expect(updateCall).not.toHaveProperty('status');
      expect(updateCall).not.toHaveProperty('backend_session_id');
      expect(updateCall).not.toHaveProperty('claude_session_id');
      expect(updateCall).not.toHaveProperty('context');
      expect(updateCall).not.toHaveProperty('working_dir');
    });

    it('should allow setting phase to null (clearing phase)', async () => {
      mockSupabase._setReturnData({ ...mockSessionRow, current_phase: null });

      await repo.updateSession('session-123', {
        currentPhase: null,
      });

      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateCall.current_phase).toBeNull();
    });

    it('should return null when session not found', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      const result = await repo.updateSession('nonexistent', {
        currentPhase: 'implementing',
      });

      expect(result).toBeNull();
    });

    it('should throw on database error', async () => {
      mockSupabase._setReturnData(null, { message: 'Connection failed' });

      await expect(
        repo.updateSession('session-123', { currentPhase: 'implementing' })
      ).rejects.toThrow('Failed to update session: Connection failed');
    });

    it('should filter update by session ID', async () => {
      mockSupabase._setReturnData(mockSessionRow);

      await repo.updateSession('session-456', { currentPhase: 'reviewing' });

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('id', 'session-456');
    });
  });

  // =====================================================
  // rowToSession mapping (current_phase)
  // =====================================================

  describe('rowToSession current_phase mapping', () => {
    it('should map current_phase from row', async () => {
      mockSupabase._setReturnData({
        id: 'session-123',
        user_id: 'user-123',
        agent_id: 'wren',
        studio_id: 'studio-abc',
        workspace_id: 'workspace-abc',
        current_phase: 'blocked:awaiting-input',
        started_at: '2026-02-10T10:00:00Z',
        ended_at: null,
        summary: null,
        metadata: {},
      });

      const session = await repo.getSession('session-123');

      expect(session).not.toBeNull();
      expect(session!.currentPhase).toBe('blocked:awaiting-input');
    });

    it('should map null current_phase to undefined', async () => {
      mockSupabase._setReturnData({
        id: 'session-123',
        user_id: 'user-123',
        agent_id: 'wren',
        studio_id: null,
        workspace_id: null,
        current_phase: null,
        started_at: '2026-02-10T10:00:00Z',
        ended_at: null,
        summary: null,
        metadata: {},
      });

      const session = await repo.getSession('session-123');

      expect(session).not.toBeNull();
      expect(session!.currentPhase).toBeUndefined();
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
        expect(mockSupabase._queryBuilder.in).toHaveBeenCalledWith('salience', [
          'high',
          'critical',
        ]);
      });

      it('should exclude compacted logs by default', async () => {
        mockSupabase._setArrayData([]);

        await repo.getSessionLogsBySalience('session-123', 'medium');

        expect(mockSupabase._queryBuilder.is).toHaveBeenCalledWith('compacted_at', null);
      });
    });
  });

  // =====================================================
  // Hierarchical Memory (Phase 1): summary, topicKey, knowledge queries, cache
  // =====================================================

  describe('remember with summary and topicKey', () => {
    it('should pass summary and topic_key to insert', async () => {
      const mockRow = {
        id: 'mem-hm-1',
        user_id: 'user-456',
        content: 'Detailed content about JWT auth decision',
        summary: 'Using self-issued JWTs with 30-day expiry',
        topic_key: 'decision:jwt-auth',
        source: 'session',
        salience: 'high',
        topics: ['decision:jwt-auth', 'auth'],
        agent_id: null,
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Detailed content about JWT auth decision',
        summary: 'Using self-issued JWTs with 30-day expiry',
        topicKey: 'decision:jwt-auth',
        source: 'session',
        salience: 'high',
        topics: ['auth'],
      });

      // Verify insert included summary and topic_key
      expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Using self-issued JWTs with 30-day expiry',
          topic_key: 'decision:jwt-auth',
        })
      );

      // Verify result maps new fields
      expect(result.summary).toBe('Using self-issued JWTs with 30-day expiry');
      expect(result.topicKey).toBe('decision:jwt-auth');
    });

    it('should auto-prepend topicKey to topics array', async () => {
      const mockRow = {
        id: 'mem-hm-2',
        user_id: 'user-456',
        content: 'Some content',
        summary: null,
        topic_key: 'project:pcp',
        source: 'observation',
        salience: 'medium',
        topics: ['project:pcp', 'dev'],
        agent_id: null,
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);

      await repo.remember({
        userId: 'user-456',
        content: 'Some content',
        topicKey: 'project:pcp',
        topics: ['dev'],
      });

      // topicKey should be prepended to topics
      expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          topics: ['project:pcp', 'dev'],
        })
      );
    });

    it('should not duplicate topicKey in topics if already present', async () => {
      const mockRow = {
        id: 'mem-hm-3',
        user_id: 'user-456',
        content: 'Some content',
        summary: null,
        topic_key: 'project:pcp',
        source: 'observation',
        salience: 'medium',
        topics: ['project:pcp', 'dev'],
        agent_id: null,
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);

      await repo.remember({
        userId: 'user-456',
        content: 'Some content',
        topicKey: 'project:pcp',
        topics: ['project:pcp', 'dev'],
      });

      // Should NOT have duplicated project:pcp
      expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          topics: ['project:pcp', 'dev'],
        })
      );
    });

    it('should pass null when summary and topicKey are not provided', async () => {
      const mockRow = {
        id: 'mem-hm-4',
        user_id: 'user-456',
        content: 'Plain memory',
        summary: null,
        topic_key: null,
        source: 'observation',
        salience: 'medium',
        topics: [],
        agent_id: null,
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Plain memory',
      });

      expect(mockSupabase._queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: null,
          topic_key: null,
        })
      );

      // null maps to undefined in the domain model
      expect(result.summary).toBeUndefined();
      expect(result.topicKey).toBeUndefined();
    });

    it('persists chunk embeddings and records chunked metadata when embeddings are enabled', async () => {
      const mockRow = {
        id: 'mem-hm-5',
        user_id: 'user-456',
        content: 'A'.repeat(1800),
        summary: 'Chunked summary',
        topic_key: 'project:pcp/memory',
        source: 'observation',
        salience: 'high',
        topics: ['project:pcp/memory'],
        agent_id: 'lumen',
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);
      const embedDocument = vi.fn().mockResolvedValue({
        vector: new Array(1024).fill(0.1),
        provider: 'ollama',
        model: 'mxbai-embed-large',
        dimensions: 1024,
      });
      (repo as any).embeddingRouter = {
        isEnabled: vi.fn().mockReturnValue(true),
        embedDocument,
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          provider: 'ollama',
          model: 'mxbai-embed-large',
          dimensions: 1024,
          queryThreshold: 0.2,
          matchCountMultiplier: 5,
          ollamaBaseUrl: 'http://localhost:11434',
          openaiBaseUrl: 'https://api.openai.com',
          hasOpenAIKey: false,
        }),
      };

      const result = await repo.remember({
        userId: 'user-456',
        agentId: 'lumen',
        content: 'A'.repeat(1800),
        summary: 'Chunked summary',
        topicKey: 'project:pcp/memory',
        salience: 'high',
      });

      const chunkRows = mockSupabase._queryBuilder.upsert.mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(embedDocument).toHaveBeenCalledTimes(chunkRows.length);
      expect(chunkRows.length).toBeGreaterThan(1);
      expect(mockSupabase.from).toHaveBeenCalledWith('memory_embedding_chunks');
      expect(mockSupabase._queryBuilder.upsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            memory_id: 'mem-hm-5',
            chunk_type: 'summary',
            chunk_index: 0,
            chunk_text: 'Chunked summary',
          }),
        ]),
        expect.objectContaining({ onConflict: 'memory_id,chunk_index' })
      );
      expect(chunkRows.some((row) => row.chunk_type === 'content')).toBe(true);
      expect(chunkRows.some((row) => row.chunk_type === 'topic')).toBe(true);
      expect(mockSupabase._queryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          embedding_chunks_version: 2,
          embedding_chunk_count: chunkRows.length,
          metadata: expect.objectContaining({
            embedding_chunks: expect.objectContaining({
              chunkCount: chunkRows.length,
              version: 2,
              viewCounts: expect.objectContaining({
                summary: 1,
              }),
            }),
            embedding: expect.objectContaining({
              provider: 'ollama',
              model: 'mxbai-embed-large',
            }),
          }),
        })
      );
      expect(result.embedding).toEqual(new Array(1024).fill(0.1));
    });
  });

  describe('rowToMemory mapping for new fields', () => {
    it('should map summary and topicKey from row', async () => {
      const mockRow = {
        id: 'mem-map-1',
        user_id: 'user-456',
        content: 'Full content here',
        summary: 'Short summary',
        topic_key: 'convention:git',
        source: 'user_stated',
        salience: 'high',
        topics: ['convention:git'],
        agent_id: 'wren',
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);
      const result = await repo.getMemory('mem-map-1');

      expect(result!.summary).toBe('Short summary');
      expect(result!.topicKey).toBe('convention:git');
    });

    it('should map null summary/topic_key to undefined', async () => {
      const mockRow = {
        id: 'mem-map-2',
        user_id: 'user-456',
        content: 'Content',
        summary: null,
        topic_key: null,
        source: 'observation',
        salience: 'medium',
        topics: [],
        agent_id: null,
        embedding: null,
        metadata: {},
        version: 1,
        created_at: '2026-02-18T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockRow);
      const result = await repo.getMemory('mem-map-2');

      expect(result!.summary).toBeUndefined();
      expect(result!.topicKey).toBeUndefined();
    });
  });

  describe('getKnowledgeMemories', () => {
    it('should query for critical and high salience memories', async () => {
      // The mock returns the same data for both parallel queries,
      // which means we'll get duplicates. That's a mock limitation.
      // We're testing that the method runs, calls the right table, and maps correctly.
      const mockMemories = [
        {
          id: 'mem-k1',
          user_id: 'user-456',
          content: 'Critical info',
          summary: 'Critical one-liner',
          topic_key: 'decision:auth',
          source: 'user_stated',
          salience: 'critical',
          topics: ['decision:auth'],
          agent_id: null,
          embedding: null,
          metadata: {},
          version: 1,
          created_at: '2026-02-18T12:00:00Z',
          expires_at: null,
        },
      ];

      mockSupabase._setArrayData(mockMemories);

      const results = await repo.getKnowledgeMemories('user-456');

      // Should have called from('memories') and filtered by salience
      expect(mockSupabase.from).toHaveBeenCalledWith('memories');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-456');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('salience', 'critical');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('salience', 'high');

      // Results should be mapped Memory objects
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].summary).toBe('Critical one-liner');
      expect(results[0].topicKey).toBe('decision:auth');
    });

    it('should filter by agentId when provided', async () => {
      mockSupabase._setArrayData([]);

      await repo.getKnowledgeMemories('user-456', 'wren');

      expect(mockSupabase._queryBuilder.or).toHaveBeenCalledWith(
        'agent_id.eq.wren,agent_id.is.null'
      );
    });

    it('should not filter by agentId when not provided', async () => {
      mockSupabase._setArrayData([]);

      await repo.getKnowledgeMemories('user-456');

      // or() should still be called for expires_at, but not for agent_id
      const orCalls = (mockSupabase._queryBuilder.or as ReturnType<typeof vi.fn>).mock.calls;
      const agentOrCalls = orCalls.filter(([arg]: [string]) => arg.includes('agent_id'));
      expect(agentOrCalls).toHaveLength(0);
    });

    it('should respect highLimit parameter', async () => {
      mockSupabase._setArrayData([]);

      await repo.getKnowledgeMemories('user-456', undefined, 25);

      // 3 queries: critical (30), high by count (25), high by window (50)
      const limitCalls = (mockSupabase._queryBuilder.limit as ReturnType<typeof vi.fn>).mock.calls;
      expect(limitCalls).toContainEqual([30]);
      expect(limitCalls).toContainEqual([25]);
      expect(limitCalls).toContainEqual([50]);
    });

    it('should apply time window for high memories', async () => {
      mockSupabase._setArrayData([]);

      await repo.getKnowledgeMemories('user-456', undefined, 10, 14);

      // gte should be called for the windowed high query
      const gteCalls = (mockSupabase._queryBuilder.gte as ReturnType<typeof vi.fn>).mock.calls;
      const createdAtFilter = gteCalls.find(([col]: [string]) => col === 'created_at');
      expect(createdAtFilter).toBeDefined();
      const cutoff = new Date(createdAtFilter![1]);
      const daysAgo = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
      expect(daysAgo).toBeGreaterThan(13);
      expect(daysAgo).toBeLessThan(15);
    });
  });

  describe('computeKnowledgeMemoryScore', () => {
    const baseMemory = {
      id: 'mem-score-1',
      userId: 'user-456',
      content: 'Review PR #204 blocker fixes and confirm tests pass',
      summary: 'PR #204 re-review notes',
      topicKey: 'pr:204',
      source: 'observation' as const,
      salience: 'high' as const,
      topics: ['pr:204', 'review'],
      metadata: { threadKey: 'pr:204' },
      version: 1,
      createdAt: new Date('2026-03-08T00:00:00Z'),
    };

    it('should boost score on exact thread match', () => {
      const now = new Date('2026-03-10T00:00:00Z');
      const baseline = computeKnowledgeMemoryScore(baseMemory, {}, now);
      const withThread = computeKnowledgeMemoryScore(baseMemory, { threadKey: 'pr:204' }, now);

      expect(withThread).toBeGreaterThan(baseline);
    });

    it('should boost score when focus text overlaps memory content', () => {
      const now = new Date('2026-03-10T00:00:00Z');
      const baseline = computeKnowledgeMemoryScore(baseMemory, {}, now);
      const withFocus = computeKnowledgeMemoryScore(
        baseMemory,
        { focusText: 're-review PR blocker fixes before merge' },
        now
      );

      expect(withFocus).toBeGreaterThan(baseline);
    });
  });

  describe('getCachedSummary', () => {
    it('should return null when no cache exists', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      const result = await repo.getCachedSummary('user-456');

      expect(result).toBeNull();
      expect(mockSupabase.from).toHaveBeenCalledWith('memory_summary_cache');
    });

    it('should use __shared__ as default agent_id', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      await repo.getCachedSummary('user-456');

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('agent_id', '__shared__');
    });

    it('should use provided agentId for cache key', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      await repo.getCachedSummary('user-456', 'wren');

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('agent_id', 'wren');
    });
  });

  describe('setCachedSummary', () => {
    it('should upsert cache entry with correct fields', async () => {
      mockSupabase._setReturnData(null); // upsert returns void-like

      await repo.setCachedSummary('user-456', 'wren', 'Summary text here', 42);

      expect(mockSupabase.from).toHaveBeenCalledWith('memory_summary_cache');
      expect(mockSupabase._queryBuilder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-456',
          agent_id: 'wren',
          summary_text: 'Summary text here',
          memory_count: 42,
        }),
        { onConflict: 'user_id,agent_id' }
      );
    });

    it('should use __shared__ when agentId is undefined', async () => {
      mockSupabase._setReturnData(null);

      await repo.setCachedSummary('user-456', undefined, 'Shared summary', 10);

      expect(mockSupabase._queryBuilder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: '__shared__',
        }),
        expect.anything()
      );
    });

    it('should not throw on error (warns only)', async () => {
      mockSupabase._setReturnData(null, { message: 'Write failed' });

      // Should not throw
      await expect(
        repo.setCachedSummary('user-456', 'wren', 'Summary', 5)
      ).resolves.toBeUndefined();
    });
  });

  describe('semantic recall integration', () => {
    it('serializes query embeddings for chunk matcher RPC', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: [
          {
            id: 'mem-sem-1',
            user_id: 'user-456',
            content: 'Semantic memory',
            summary: 'Semantic memory',
            topic_key: 'pr:214',
            source: 'observation',
            salience: 'high',
            topics: ['pr:214'],
            agent_id: 'lumen',
            embedding: '[0.1,0.2,0.3]',
            metadata: {
              embedding_chunks: {
                version: 2,
                viewCounts: {
                  summary: 1,
                  fact: 1,
                  topic: 1,
                  entity: 0,
                  content: 1,
                },
              },
            },
            version: 1,
            created_at: '2026-03-16T00:00:00Z',
            expires_at: null,
            identity_id: null,
            matched_chunk_index: 0,
            matched_chunk_text: 'Semantic memory',
            matched_chunk_type: 'summary',
            similarity: 0.9,
          },
        ],
        error: null,
      });
      (mockSupabase as any).rpc = rpc;
      (repo as any).embeddingRouter = {
        embedQuery: vi.fn().mockResolvedValue({
          vector: [0.1, 0.2, 0.3],
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
        }),
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
          queryThreshold: 0.2,
          matchCountMultiplier: 5,
          ollamaBaseUrl: 'http://localhost:11434',
          openaiBaseUrl: 'https://api.openai.com',
          hasOpenAIKey: true,
        }),
      };

      const results = await repo.recall('user-456', 'semantic query', { recallMode: 'semantic' });

      expect(rpc).toHaveBeenCalledWith(
        'match_memory_embedding_chunks',
        expect.objectContaining({
          query_embedding: '[0.1,0.2,0.3]',
        })
      );
      expect(results).toHaveLength(1);
      expect(results[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('falls back to legacy memory embeddings when chunk matches are empty', async () => {
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({
          data: [],
          error: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'mem-sem-legacy',
              user_id: 'user-456',
              content: 'Legacy semantic memory',
              summary: 'Legacy semantic memory',
              topic_key: 'project:pcp/memory',
              source: 'observation',
              salience: 'high',
              topics: ['project:pcp/memory'],
              agent_id: 'lumen',
              embedding: '[0.1,0.2,0.3]',
              metadata: {},
              version: 1,
              created_at: '2026-03-16T00:00:00Z',
              expires_at: null,
              identity_id: null,
              similarity: 0.88,
            },
          ],
          error: null,
        });

      (mockSupabase as any).rpc = rpc;
      (repo as any).embeddingRouter = {
        embedQuery: vi.fn().mockResolvedValue({
          vector: [0.1, 0.2, 0.3],
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
        }),
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
          queryThreshold: 0.2,
          matchCountMultiplier: 5,
          ollamaBaseUrl: 'http://localhost:11434',
          openaiBaseUrl: 'https://api.openai.com',
          hasOpenAIKey: true,
        }),
      };

      const results = await repo.recall('user-456', 'semantic query', { recallMode: 'semantic' });

      expect(rpc).toHaveBeenNthCalledWith(
        1,
        'match_memory_embedding_chunks',
        expect.objectContaining({
          query_embedding: '[0.1,0.2,0.3]',
        })
      );
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        'match_memories',
        expect.objectContaining({
          query_embedding: '[0.1,0.2,0.3]',
        })
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-sem-legacy');
    });

    it('skips RPC when query embedding dimensions do not match schema dimensions', async () => {
      const rpc = vi.fn();
      (mockSupabase as any).rpc = rpc;
      (repo as any).embeddingRouter = {
        embedQuery: vi.fn().mockResolvedValue({
          vector: [0.1, 0.2, 0.3],
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimensions: 768,
        }),
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimensions: 1024,
          queryThreshold: 0.2,
          matchCountMultiplier: 5,
          ollamaBaseUrl: 'http://localhost:11434',
          openaiBaseUrl: 'https://api.openai.com',
          hasOpenAIKey: false,
        }),
      };

      const results = await repo.recall('user-456', 'semantic query', { recallMode: 'semantic' });

      expect(rpc).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it('hybrid recall queries derived and raw chunk views separately', async () => {
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              id: 'mem-derived-1',
              user_id: 'user-456',
              content: 'Current policy override note',
              summary: 'Current policy override note',
              topic_key: 'policy:wound-care',
              source: 'observation',
              salience: 'high',
              topics: ['policy:wound-care'],
              agent_id: 'lumen',
              embedding: '[0.1,0.2,0.3]',
              metadata: {},
              version: 1,
              created_at: '2026-03-16T00:00:00Z',
              expires_at: null,
              identity_id: null,
              matched_chunk_index: 1,
              matched_chunk_text: 'Current policy override note',
              matched_chunk_type: 'fact',
              similarity: 0.88,
            },
          ],
          error: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'mem-derived-1',
              user_id: 'user-456',
              content: 'Current policy override note',
              summary: 'Current policy override note',
              topic_key: 'policy:wound-care',
              source: 'observation',
              salience: 'high',
              topics: ['policy:wound-care'],
              agent_id: 'lumen',
              embedding: '[0.1,0.2,0.3]',
              metadata: {},
              version: 1,
              created_at: '2026-03-16T00:00:00Z',
              expires_at: null,
              identity_id: null,
              matched_chunk_index: 4,
              matched_chunk_text: 'Current policy override note',
              matched_chunk_type: 'content',
              similarity: 0.81,
            },
          ],
          error: null,
        });

      (mockSupabase as any).rpc = rpc;
      (repo as any).embeddingRouter = {
        embedQuery: vi.fn().mockResolvedValue({
          vector: [0.1, 0.2, 0.3],
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
        }),
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1024,
          queryThreshold: 0.2,
          matchCountMultiplier: 5,
          ollamaBaseUrl: 'http://localhost:11434',
          openaiBaseUrl: 'https://api.openai.com',
          hasOpenAIKey: true,
        }),
      };
      (repo as any).textRecallCandidates = vi.fn().mockResolvedValue([]);

      const results = await repo.recall('user-456', 'current override policy', {
        recallMode: 'hybrid',
      });

      expect(rpc).toHaveBeenNthCalledWith(
        1,
        'match_memory_embedding_chunks',
        expect.objectContaining({
          p_chunk_types: ['summary', 'fact', 'topic', 'entity'],
        })
      );
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        'match_memory_embedding_chunks',
        expect.objectContaining({
          p_chunk_types: ['content'],
        })
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-derived-1');
    });

    it('chronology-aware reranking prefers newer override memories for current-policy queries', async () => {
      const olderMemory = {
        id: 'mem-old',
        userId: 'user-456',
        content: 'Wound-care escalation policy. Notify the old triage lead on call.',
        summary: 'Old escalation policy',
        topicKey: 'policy:wound-care',
        source: 'observation',
        salience: 'high',
        topics: ['policy:wound-care'],
        metadata: {},
        version: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      };
      const newerMemory = {
        id: 'mem-new',
        userId: 'user-456',
        content:
          'Current wound-care escalation policy now uses the inpatient lead and overrides the previous protocol.',
        summary: 'Current escalation policy overrides previous protocol',
        topicKey: 'policy:wound-care',
        source: 'observation',
        salience: 'high',
        topics: ['policy:wound-care'],
        metadata: {},
        version: 1,
        createdAt: new Date('2026-03-20T00:00:00Z'),
      };

      (repo as any).trySemanticRecallCandidates = vi
        .fn()
        .mockResolvedValueOnce([
          {
            memory: olderMemory,
            semanticScore: 0.95,
            matchedChunkType: 'summary',
            finalScore: 0.95,
          },
          {
            memory: newerMemory,
            semanticScore: 0.9,
            matchedChunkType: 'fact',
            finalScore: 0.9,
          },
        ])
        .mockResolvedValueOnce([
          {
            memory: olderMemory,
            semanticScore: 0.9,
            matchedChunkType: 'content',
            finalScore: 0.9,
          },
          {
            memory: newerMemory,
            semanticScore: 0.88,
            matchedChunkType: 'content',
            finalScore: 0.88,
          },
        ]);
      (repo as any).textRecallCandidates = vi.fn().mockResolvedValue([]);
      (repo as any).embeddingRouter = {
        getRuntimeConfig: vi.fn().mockReturnValue({
          matchCountMultiplier: 5,
        }),
      };

      const results = await (repo as any).hybridRecall(
        'user-456',
        'what is the current wound-care policy override',
        {},
        5,
        0
      );

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-new');
      expect(results[1].id).toBe('mem-old');
    });
  });

  // ─── Per-Sender Memory Isolation Tests ───

  describe('contact-scoped remember', () => {
    it('should write contact_id when provided', async () => {
      disableEmbeddings();
      const mockMemoryRow = {
        id: 'mem-contact-1',
        user_id: 'user-456',
        content: 'Alice told me her address',
        source: 'conversation',
        salience: 'medium',
        topics: [],
        embedding: null,
        contact_id: 'contact-alice',
        metadata: {},
        version: 1,
        created_at: '2026-03-25T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockMemoryRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'Alice told me her address',
        contactId: 'contact-alice',
      });

      expect(result.contactId).toBe('contact-alice');
      expect(mockSupabase.from).toHaveBeenCalledWith('memories');
    });

    it('should set contact_id to null when not provided', async () => {
      disableEmbeddings();
      const mockMemoryRow = {
        id: 'mem-owner-1',
        user_id: 'user-456',
        content: 'General knowledge',
        source: 'observation',
        salience: 'high',
        topics: [],
        embedding: null,
        contact_id: null,
        metadata: {},
        version: 1,
        created_at: '2026-03-25T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setReturnData(mockMemoryRow);

      const result = await repo.remember({
        userId: 'user-456',
        content: 'General knowledge',
      });

      expect(result.contactId).toBeUndefined();
    });
  });

  describe('contact-scoped recall', () => {
    it('should filter by contact_id when provided', async () => {
      disableEmbeddings();
      const contactMemory = {
        id: 'mem-1',
        user_id: 'user-456',
        content: 'Private to Alice',
        source: 'conversation',
        salience: 'medium',
        topics: [],
        embedding: null,
        contact_id: 'contact-alice',
        metadata: {},
        version: 1,
        created_at: '2026-03-25T12:00:00Z',
        expires_at: null,
      };

      mockSupabase._setArrayData([contactMemory]);

      const results = await repo.recall('user-456', undefined, {
        contactId: 'contact-alice',
        recallMode: 'text',
      });

      expect(results.length).toBe(1);
      expect(results[0].contactId).toBe('contact-alice');

      // Verify eq('contact_id', 'contact-alice') was called
      const eqCalls = (mockSupabase._queryBuilder.eq as ReturnType<typeof vi.fn>).mock.calls;
      const contactFilter = eqCalls.find(
        (call: unknown[]) => call[0] === 'contact_id' && call[1] === 'contact-alice'
      );
      expect(contactFilter).toBeDefined();
    });

    it('should not filter by contact_id when not provided (owner session)', async () => {
      disableEmbeddings();
      mockSupabase._setArrayData([]);

      await repo.recall('user-456', undefined, { recallMode: 'text' });

      const eqCalls = (mockSupabase._queryBuilder.eq as ReturnType<typeof vi.fn>).mock.calls;
      const contactFilter = eqCalls.find((call: unknown[]) => call[0] === 'contact_id');
      expect(contactFilter).toBeUndefined();
    });
  });
});
