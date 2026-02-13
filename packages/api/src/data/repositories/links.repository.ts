import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { Link, CreateLinkDTO, UpdateLinkDTO, SearchLinksOptions } from '../models/link.model';
import { BaseRepository } from './base.repository';

export class LinksRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async create(linkData: CreateLinkDTO): Promise<Link> {
    try {
      const { data, error } = await this.client.from('links').insert(linkData).select().single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async findById(id: string, userId: string): Promise<Link | null> {
    try {
      const { data, error } = await this.client
        .from('links')
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

  async findByUser(userId: string, options?: SearchLinksOptions): Promise<Link[]> {
    try {
      let query = this.client
        .from('links')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (options?.tags?.length) {
        query = query.contains('tags', options.tags);
      }

      if (options?.startDate) {
        query = query.gte('created_at', options.startDate.toISOString());
      }

      if (options?.endDate) {
        query = query.lte('created_at', options.endDate.toISOString());
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

  async search(userId: string, options: SearchLinksOptions): Promise<Link[]> {
    try {
      let query = this.client.from('links').select('*').eq('user_id', userId);

      if (options.query) {
        query = query.or(
          `title.ilike.%${options.query}%,description.ilike.%${options.query}%,url.ilike.%${options.query}%`
        );
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

  async update(id: string, userId: string, linkData: UpdateLinkDTO): Promise<Link> {
    try {
      const { data, error } = await this.client
        .from('links')
        .update(linkData)
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
      const { error } = await this.client.from('links').delete().eq('id', id).eq('user_id', userId);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }

  async addTags(id: string, userId: string, tags: string[]): Promise<Link> {
    try {
      // First get current tags
      const link = await this.findById(id, userId);
      if (!link) throw new Error('Link not found');

      const newTags = [...new Set([...(link.tags || []), ...tags])];
      return this.update(id, userId, { tags: newTags });
    } catch (error) {
      this.handleError(error, 'addTags');
    }
  }

  async removeTags(id: string, userId: string, tags: string[]): Promise<Link> {
    try {
      const link = await this.findById(id, userId);
      if (!link) throw new Error('Link not found');

      const newTags = (link.tags || []).filter((tag) => !tags.includes(tag));
      return this.update(id, userId, { tags: newTags });
    } catch (error) {
      this.handleError(error, 'removeTags');
    }
  }
}
