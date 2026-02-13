import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { Note, CreateNoteDTO, UpdateNoteDTO, SearchNotesOptions } from '../models/note.model';
import { BaseRepository } from './base.repository';

export class NotesRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async create(noteData: CreateNoteDTO): Promise<Note> {
    try {
      const { data, error } = await this.client.from('notes').insert(noteData).select().single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async findById(id: string, userId: string): Promise<Note | null> {
    try {
      const { data, error } = await this.client
        .from('notes')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findById');
    }
  }

  async findByUser(userId: string, options?: SearchNotesOptions): Promise<Note[]> {
    try {
      let query = this.client
        .from('notes')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (options?.tags?.length) {
        query = query.contains('tags', options.tags);
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'findByUser');
    }
  }

  async search(userId: string, options: SearchNotesOptions): Promise<Note[]> {
    try {
      let query = this.client.from('notes').select('*').eq('user_id', userId);

      if (options.query) {
        query = query.or(`title.ilike.%${options.query}%,content.ilike.%${options.query}%`);
      }

      if (options.tags?.length) {
        query = query.contains('tags', options.tags);
      }

      query = query.order('created_at', { ascending: false });

      if (options.limit) {
        query = query.limit(options.limit);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'search');
    }
  }

  async update(id: string, userId: string, noteData: UpdateNoteDTO): Promise<Note> {
    try {
      const { data, error } = await this.client
        .from('notes')
        .update(noteData)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'update');
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    try {
      const { error } = await this.client.from('notes').delete().eq('id', id).eq('user_id', userId);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
