import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { BaseRepository } from './base.repository';

export interface SessionFocus {
  id: string;
  user_id: string;
  session_id: string | null;
  project_id: string | null;
  focus_summary: string | null;
  context_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SessionFocusInsert {
  user_id: string;
  session_id?: string | null;
  project_id?: string | null;
  focus_summary?: string | null;
  context_snapshot?: Record<string, unknown>;
}

export interface SessionFocusUpdate {
  project_id?: string | null;
  focus_summary?: string | null;
  context_snapshot?: Record<string, unknown>;
}

export class SessionFocusRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async findByUserAndSession(
    userId: string,
    sessionId?: string | null
  ): Promise<SessionFocus | null> {
    try {
      let query = this.client.from('session_focus').select('*').eq('user_id', userId);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      } else {
        query = query.is('session_id', null);
      }

      const { data, error } = await query.single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as SessionFocus | null;
    } catch (error) {
      this.handleError(error, 'findByUserAndSession');
    }
  }

  async findLatestByUser(userId: string): Promise<SessionFocus | null> {
    try {
      const { data, error } = await this.client
        .from('session_focus')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as SessionFocus | null;
    } catch (error) {
      this.handleError(error, 'findLatestByUser');
    }
  }

  async upsert(data: SessionFocusInsert): Promise<SessionFocus> {
    try {
      const existing = await this.findByUserAndSession(data.user_id, data.session_id);

      if (existing) {
        const { data: updated, error } = await this.client
          .from('session_focus')
          .update({
            project_id: data.project_id ?? existing.project_id,
            focus_summary: data.focus_summary ?? existing.focus_summary,
            context_snapshot: data.context_snapshot ?? existing.context_snapshot,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw error;
        return updated as SessionFocus;
      } else {
        const { data: inserted, error } = await this.client
          .from('session_focus')
          .insert(data)
          .select()
          .single();

        if (error) throw error;
        return inserted as SessionFocus;
      }
    } catch (error) {
      this.handleError(error, 'upsert');
    }
  }

  async delete(userId: string, sessionId?: string | null): Promise<void> {
    try {
      let query = this.client.from('session_focus').delete().eq('user_id', userId);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      }

      const { error } = await query;
      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
