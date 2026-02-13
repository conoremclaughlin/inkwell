import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { BaseRepository } from './base.repository';

export type ContextType = 'user' | 'assistant' | 'project' | 'session' | 'relationship';

export interface ContextSummary {
  id: string;
  user_id: string;
  context_type: ContextType;
  context_key: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ContextSummaryInsert {
  user_id: string;
  context_type: ContextType;
  context_key?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface ContextSummaryUpdate {
  summary?: string;
  metadata?: Record<string, unknown>;
  version?: number;
}

export class ContextRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async findByUserAndType(
    userId: string,
    contextType: ContextType,
    contextKey?: string | null
  ): Promise<ContextSummary | null> {
    try {
      let query = this.client
        .from('context_summaries')
        .select('*')
        .eq('user_id', userId)
        .eq('context_type', contextType);

      if (contextKey !== undefined) {
        query =
          contextKey === null ? query.is('context_key', null) : query.eq('context_key', contextKey);
      }

      const { data, error } = await query.single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as ContextSummary | null;
    } catch (error) {
      this.handleError(error, 'findByUserAndType');
    }
  }

  async findAllByUser(userId: string): Promise<ContextSummary[]> {
    try {
      const { data, error } = await this.client
        .from('context_summaries')
        .select('*')
        .eq('user_id', userId)
        .order('context_type')
        .order('context_key');

      if (error) throw error;
      return (data as ContextSummary[]) || [];
    } catch (error) {
      this.handleError(error, 'findAllByUser');
    }
  }

  async findByType(userId: string, contextType: ContextType): Promise<ContextSummary[]> {
    try {
      const { data, error } = await this.client
        .from('context_summaries')
        .select('*')
        .eq('user_id', userId)
        .eq('context_type', contextType)
        .order('context_key');

      if (error) throw error;
      return (data as ContextSummary[]) || [];
    } catch (error) {
      this.handleError(error, 'findByType');
    }
  }

  async upsert(data: ContextSummaryInsert): Promise<ContextSummary> {
    try {
      // Check if exists
      const existing = await this.findByUserAndType(
        data.user_id,
        data.context_type,
        data.context_key
      );

      if (existing) {
        // Update with incremented version
        const { data: updated, error } = await this.client
          .from('context_summaries')
          .update({
            summary: data.summary,
            metadata: data.metadata || existing.metadata,
            version: existing.version + 1,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw error;
        return updated as ContextSummary;
      } else {
        // Insert new
        const { data: inserted, error } = await this.client
          .from('context_summaries')
          .insert(data)
          .select()
          .single();

        if (error) throw error;
        return inserted as ContextSummary;
      }
    } catch (error) {
      this.handleError(error, 'upsert');
    }
  }

  async delete(
    userId: string,
    contextType: ContextType,
    contextKey?: string | null
  ): Promise<void> {
    try {
      let query = this.client
        .from('context_summaries')
        .delete()
        .eq('user_id', userId)
        .eq('context_type', contextType);

      if (contextKey !== undefined) {
        query =
          contextKey === null ? query.is('context_key', null) : query.eq('context_key', contextKey);
      }

      const { error } = await query;
      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
