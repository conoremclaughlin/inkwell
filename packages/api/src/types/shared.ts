/**
 * Types shared with @personal-context/shared.
 *
 * Duplicated here because the API (CJS) and shared (ESM) packages use
 * different module systems. These are simple type aliases — if they diverge,
 * update both locations.
 */

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

export interface RecurrenceConfig {
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  interval: number;
}
