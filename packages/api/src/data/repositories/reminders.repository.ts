import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import type { Reminder, CreateReminderDTO, UpdateReminderDTO } from '../models/reminder.model';
import { BaseRepository } from './base.repository';

export class RemindersRepository extends BaseRepository {
  constructor(client: SupabaseClient<Database>) {
    super(client);
  }

  async create(reminderData: CreateReminderDTO): Promise<Reminder> {
    try {
      const { data, error } = await this.client
        .from('reminders')
        .insert({
          ...reminderData,
          reminder_time: reminderData.reminder_time.toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'create');
    }
  }

  async findById(id: string, userId: string): Promise<Reminder | null> {
    try {
      const { data, error } = await this.client
        .from('reminders')
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

  async list(userId: string, status?: string, limit = 20): Promise<Reminder[]> {
    try {
      let query = this.client
        .from('reminders')
        .select('*')
        .eq('user_id', userId)
        .order('reminder_time', { ascending: true });

      if (status) {
        query = query.eq('status', status);
      }

      query = query.limit(limit);

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'list');
    }
  }

  async findPending(beforeTime: Date): Promise<Reminder[]> {
    try {
      const { data, error } = await this.client
        .from('reminders')
        .select('*')
        .eq('status', 'pending')
        .lte('reminder_time', beforeTime.toISOString())
        .order('reminder_time', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.handleError(error, 'findPending');
    }
  }

  async update(id: string, userId: string, reminderData: UpdateReminderDTO): Promise<Reminder> {
    try {
      const updateData: Record<string, unknown> = { ...reminderData };

      if (reminderData.reminder_time) {
        updateData.reminder_time = reminderData.reminder_time.toISOString();
      }

      if (reminderData.sent_at) {
        updateData.sent_at = reminderData.sent_at.toISOString();
      }

      const { data, error } = await this.client
        .from('reminders')
        .update(updateData)
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

  async markAsSent(id: string, userId: string): Promise<Reminder> {
    try {
      const { data, error } = await this.client
        .from('reminders')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      this.handleError(error, 'markAsSent');
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    try {
      const { error } = await this.client
        .from('reminders')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) throw error;
    } catch (error) {
      this.handleError(error, 'delete');
    }
  }
}
