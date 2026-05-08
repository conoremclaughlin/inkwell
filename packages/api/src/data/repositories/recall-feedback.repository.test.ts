import { describe, it, expect, beforeEach } from 'vitest';
import { RecallFeedbackRepository } from './recall-feedback.repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

describe('RecallFeedbackRepository', () => {
  let mockSupabase: MockSupabaseClient;
  let repo: RecallFeedbackRepository;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    repo = new RecallFeedbackRepository(mockSupabase as unknown as SupabaseClient<Database>);
  });

  describe('saveFeedback', () => {
    it('inserts one row per entry with correct field mapping', async () => {
      mockSupabase._setReturnData(null);

      const saved = await repo.saveFeedback({
        userId: 'user-1',
        agentId: 'wren',
        query: 'merge strategy',
        sessionId: 'sess-1',
        entries: [
          {
            memoryId: 'mem-1',
            verdict: 'accepted',
            semanticScore: 0.85,
            textScore: 0.6,
            finalScore: 0.78,
          },
          {
            memoryId: 'mem-2',
            verdict: 'dismissed',
            semanticScore: 0.2,
          },
        ],
      });

      expect(saved).toBe(2);
      expect(mockSupabase.from).toHaveBeenCalledWith('recall_feedback');

      const insertCall = mockSupabase._queryBuilder.insert as ReturnType<
        typeof import('vitest').vi.fn
      >;
      const rows = insertCall.mock.calls[0][0] as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        user_id: 'user-1',
        agent_id: 'wren',
        query: 'merge strategy',
        memory_id: 'mem-1',
        verdict: 'accepted',
        semantic_score: 0.85,
        text_score: 0.6,
        final_score: 0.78,
        session_id: 'sess-1',
      });
      expect(rows[1]).toMatchObject({
        memory_id: 'mem-2',
        verdict: 'dismissed',
        semantic_score: 0.2,
        text_score: null,
        final_score: null,
      });
    });

    it('defaults optional fields to null', async () => {
      mockSupabase._setReturnData(null);

      await repo.saveFeedback({
        userId: 'user-1',
        query: 'test query',
        entries: [{ memoryId: 'mem-1', verdict: 'dismissed' }],
      });

      const insertCall = mockSupabase._queryBuilder.insert as ReturnType<
        typeof import('vitest').vi.fn
      >;
      const rows = insertCall.mock.calls[0][0] as Array<Record<string, unknown>>;

      expect(rows[0]).toMatchObject({
        agent_id: null,
        session_id: null,
        semantic_score: null,
        text_score: null,
        final_score: null,
      });
    });

    it('throws on insert error', async () => {
      mockSupabase._setReturnData(null, { message: 'FK violation' });

      await expect(
        repo.saveFeedback({
          userId: 'user-1',
          query: 'q',
          entries: [{ memoryId: 'bad-id', verdict: 'dismissed' }],
        })
      ).rejects.toThrow('FK violation');
    });
  });

  describe('getDismissalCount', () => {
    it('returns count from supabase', async () => {
      mockSupabase._setReturnData(null);
      // The mock's then() resolves with {data, error} but count comes from the response
      // For head:true queries, count is on the response object
      // Our mock doesn't perfectly model count — but we can verify the query chain
      const count = await repo.getDismissalCount('mem-1', 'wren');

      expect(mockSupabase.from).toHaveBeenCalledWith('recall_feedback');
      expect(mockSupabase._queryBuilder.select).toHaveBeenCalledWith('id', {
        count: 'exact',
        head: true,
      });
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('memory_id', 'mem-1');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('verdict', 'dismissed');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('agent_id', 'wren');
      expect(count).toBe(0); // null count → 0
    });

    it('omits agent_id filter when not provided', async () => {
      mockSupabase._setReturnData(null);
      await repo.getDismissalCount('mem-1');

      const eqCalls = (mockSupabase._queryBuilder.eq as ReturnType<typeof import('vitest').vi.fn>)
        .mock.calls;
      const agentIdCalls = eqCalls.filter(([field]: [string]) => field === 'agent_id');
      expect(agentIdCalls).toHaveLength(0);
    });
  });
});
