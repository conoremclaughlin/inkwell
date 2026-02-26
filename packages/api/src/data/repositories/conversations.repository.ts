import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type {
  Conversation,
  Message,
  CreateConversationDTO,
  CreateMessageDTO,
} from '../models/conversation.model';
import { BaseRepository } from './base.repository';

export class ConversationsRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  // Conversation methods
  async createConversation(conversationData: CreateConversationDTO): Promise<Conversation> {
    try {
      const { data, error } = await this.client
        .from('conversations')
        .insert(conversationData)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'createConversation');
    }
  }

  async upsertConversationByPlatformId(
    conversationData: CreateConversationDTO
  ): Promise<Conversation> {
    try {
      const { data, error } = await this.client
        .from('conversations')
        .upsert(conversationData, {
          onConflict: 'platform,platform_conversation_id',
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'upsertConversationByPlatformId');
    }
  }

  async findConversationById(id: string, userId: string): Promise<Conversation | null> {
    try {
      const { data, error } = await this.client
        .from('conversations')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findConversationById');
    }
  }

  async findConversationByPlatformId(
    platform: string,
    platformConversationId: string
  ): Promise<Conversation | null> {
    try {
      const { data, error } = await this.client
        .from('conversations')
        .select('*')
        .eq('platform', platform)
        .eq('platform_conversation_id', platformConversationId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findConversationByPlatformId');
    }
  }

  async listConversations(userId: string, limit = 20): Promise<Conversation[]> {
    try {
      const { data, error } = await this.client
        .from('conversations')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'listConversations');
    }
  }

  // Message methods
  async createMessage(messageData: CreateMessageDTO): Promise<Message> {
    try {
      const { data, error } = await this.client
        .from('messages')
        .insert(messageData)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'createMessage');
    }
  }

  async findMessageById(id: string, userId: string): Promise<Message | null> {
    try {
      const { data, error } = await this.client
        .from('messages')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findMessageById');
    }
  }

  async listMessages(conversationId: string, limit = 100): Promise<Message[]> {
    try {
      const { data, error } = await this.client
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'listMessages');
    }
  }

  async searchMessages(userId: string, query: string, limit = 50): Promise<Message[]> {
    try {
      const { data, error } = await this.client
        .from('messages')
        .select('*')
        .eq('user_id', userId)
        .ilike('content', `%${query}%`)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'searchMessages');
    }
  }
}
