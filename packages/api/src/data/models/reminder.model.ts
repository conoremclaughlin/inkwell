import type { Database } from '../supabase/types';
import type { ReminderStatus, RecurrenceConfig, Platform } from '../../types/shared';

export type Reminder = Database['public']['Tables']['reminders']['Row'];
export type ReminderInsert = Database['public']['Tables']['reminders']['Insert'];
export type ReminderUpdate = Database['public']['Tables']['reminders']['Update'];

export interface CreateReminderDTO {
  user_id: string;
  message: string;
  reminder_time: Date;
  status?: ReminderStatus;
  recurrence?: RecurrenceConfig;
  channel: Platform;
  metadata?: Record<string, unknown>;
}

export interface UpdateReminderDTO {
  message?: string;
  reminder_time?: Date;
  status?: ReminderStatus;
  recurrence?: RecurrenceConfig;
  channel?: Platform;
  sent_at?: Date;
  metadata?: Record<string, unknown>;
}
