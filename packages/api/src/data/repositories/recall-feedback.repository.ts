import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { logger } from '../../utils/logger';

export interface RecallFeedbackEntry {
  memoryId: string;
  verdict: 'accepted' | 'dismissed';
  semanticScore?: number;
  textScore?: number;
  finalScore?: number;
}

export interface RecallFeedbackInput {
  userId: string;
  sbSlug?: string;
  query: string;
  sessionId?: string;
  entries: RecallFeedbackEntry[];
}

export class RecallFeedbackRepository {
  constructor(private supabase: SupabaseClient<Database>) {}

  async saveFeedback(input: RecallFeedbackInput): Promise<number> {
    const rows = input.entries.map((e) => ({
      user_id: input.userId,
      agent_id: input.sbSlug ?? null,
      query: input.query,
      memory_id: e.memoryId,
      verdict: e.verdict,
      semantic_score: e.semanticScore ?? null,
      text_score: e.textScore ?? null,
      final_score: e.finalScore ?? null,
      session_id: input.sessionId ?? null,
    }));

    const { error } = await this.supabase.from('recall_feedback').insert(rows);

    if (error) {
      logger.error('Failed to save recall feedback:', error);
      throw new Error(`Failed to save recall feedback: ${error.message}`);
    }

    return rows.length;
  }

  async getDismissalCount(memoryId: string, sbSlug?: string): Promise<number> {
    let query = this.supabase
      .from('recall_feedback')
      .select('id', { count: 'exact', head: true })
      .eq('memory_id', memoryId)
      .eq('verdict', 'dismissed');

    if (sbSlug) {
      query = query.eq('agent_id', sbSlug);
    }

    const { count, error } = await query;

    if (error) {
      logger.error('Failed to get dismissal count:', error);
      return 0;
    }

    return count ?? 0;
  }
}
