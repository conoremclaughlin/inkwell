import type { Database } from '../supabase/types';
import type { Platform, MessageType } from '../../types/shared';

export type Conversation = Database['public']['Tables']['conversations']['Row'];
export type ConversationInsert = Database['public']['Tables']['conversations']['Insert'];
export type ConversationUpdate = Database['public']['Tables']['conversations']['Update'];

export type Message = Database['public']['Tables']['messages']['Row'];
export type MessageInsert = Database['public']['Tables']['messages']['Insert'];
export type MessageUpdate = Database['public']['Tables']['messages']['Update'];

export interface CreateConversationDTO {
  user_id: string;
  platform: Platform;
  platform_conversation_id: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMessageDTO {
  conversation_id: string;
  user_id: string;
  content: string;
  message_type?: MessageType;
  platform_message_id?: string;
  metadata?: Record<string, unknown>;
}
