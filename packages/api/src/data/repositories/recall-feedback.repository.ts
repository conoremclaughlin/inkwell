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
  agentId?: string;
  query: string;
  sessionId?: string;
  entries: RecallFeedbackEntry[];
}

export interface RecallFeedbackRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  query: string;
  memory_id: string;
  verdict: string;
  semantic_score: number | null;
  text_score: number | null;
  final_score: number | null;
  session_id: string | null;
  created_at: string;
}

// Table not yet in generated types — cast through unknown until types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any>;

export class RecallFeedbackRepository {
  private client: AnySupabase;

  constructor(supabase: SupabaseClient<Database>) {
    this.client = supabase as unknown as AnySupabase;
  }

  async saveFeedback(input: RecallFeedbackInput): Promise<number> {
    const rows = input.entries.map((e) => ({
      user_id: input.userId,
      agent_id: input.agentId ?? null,
      query: input.query,
      memory_id: e.memoryId,
      verdict: e.verdict,
      semantic_score: e.semanticScore ?? null,
      text_score: e.textScore ?? null,
      final_score: e.finalScore ?? null,
      session_id: input.sessionId ?? null,
    }));

    const { error } = await this.client.from('recall_feedback').insert(rows);

    if (error) {
      logger.error('Failed to save recall feedback:', error);
      throw new Error(`Failed to save recall feedback: ${error.message}`);
    }

    return rows.length;
  }

  async getDismissalCount(memoryId: string, agentId?: string): Promise<number> {
    let query = this.client
      .from('recall_feedback')
      .select('id', { count: 'exact', head: true })
      .eq('memory_id', memoryId)
      .eq('verdict', 'dismissed');

    if (agentId) {
      query = query.eq('agent_id', agentId);
    }

    const { count, error } = await query;

    if (error) {
      logger.error('Failed to get dismissal count:', error);
      return 0;
    }

    return count ?? 0;
  }
}
