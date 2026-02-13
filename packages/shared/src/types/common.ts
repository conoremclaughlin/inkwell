// Common types

export type Platform =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'signal'
  | 'imessage'
  | 'api';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type ReminderStatus = 'pending' | 'sent' | 'cancelled';

export type MessageType = 'text' | 'link' | 'command' | 'system';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface RecurrenceConfig {
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  interval: number;
}
