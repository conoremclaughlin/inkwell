import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { User, UserInsert, UserUpdate } from '../models/user.model';
import { BaseRepository } from './base.repository';

export class UsersRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async findById(id: string): Promise<User | null> {
    try {
      const { data, error } = await this.client.from('users').select('*').eq('id', id).single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 is "not found"
      return data;
    } catch (error) {
      this.handleError(error, 'findById');
    }
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 is "not found"
      return data;
    } catch (error) {
      this.handleError(error, 'findByTelegramId');
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('email', email)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findByEmail');
    }
  }

  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findByPhoneNumber');
    }
  }

  async findByWhatsAppId(whatsappId: string): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('whatsapp_id', whatsappId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findByWhatsAppId');
    }
  }

  async findByDiscordId(discordId: string): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('discord_id', discordId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findByDiscordId');
    }
  }

  async findBySlackId(slackId: string): Promise<User | null> {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('slack_id', slackId)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'findBySlackId');
    }
  }

  async findByPlatformId(
    platform: 'telegram' | 'whatsapp' | 'discord' | 'slack',
    platformId: string | number
  ): Promise<User | null> {
    switch (platform) {
      case 'telegram':
        return this.findByTelegramId(
          typeof platformId === 'string' ? parseInt(platformId, 10) : platformId
        );
      case 'whatsapp':
        return this.findByWhatsAppId(String(platformId));
      case 'discord':
        return this.findByDiscordId(String(platformId));
      case 'slack':
        return this.findBySlackId(String(platformId));
      default:
        return null;
    }
  }

  async create(userData: UserInsert): Promise<User> {
    try {
      const { data, error } = await this.client.from('users').insert(userData).select().single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async update(id: string, userData: UserUpdate): Promise<User> {
    try {
      const { data, error } = await this.client
        .from('users')
        .update(userData)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'update');
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const { error } = await this.client.from('users').delete().eq('id', id);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
