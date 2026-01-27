/**
 * Channel integration types for personal-context-protocol
 * These types are designed to be compatible with clawdbot's message context format
 */

export type ChannelPlatform =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'signal'
  | 'imessage';

export type ChatType = 'direct' | 'group' | 'channel';

/**
 * Normalized inbound message from any channel
 * Derived from clawdbot's MsgContext format
 */
export interface InboundMessage {
  // Core message data
  body: string;
  rawBody: string;
  timestamp?: number;
  messageId?: string;

  // Channel info
  platform: ChannelPlatform;
  chatType: ChatType;
  accountId?: string;

  // Sender info
  sender: {
    id?: string;
    username?: string;
    name?: string;
    phone?: string;
  };

  // Conversation info
  conversationId?: string;
  conversationLabel?: string;
  groupSubject?: string;

  // Reply context
  replyTo?: {
    id?: string;
    body?: string;
    sender?: string;
  };

  // Forwarded content
  forwarded?: {
    from?: string;
    fromId?: string;
    date?: number;
  };

  // Media attachments
  media?: MediaAttachment[];

  // Mentions (for group chat @mention detection)
  mentions?: {
    users: string[];      // @usernames mentioned
    botMentioned: boolean; // Was the bot specifically @mentioned?
  };

  // Location data
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };

  // Raw platform-specific context (for advanced use cases)
  raw?: unknown;
}

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'document';
  path?: string;
  url?: string;
  contentType?: string;
  filename?: string;
}

/**
 * Extracted context from a message
 * This is what we derive from analyzing the message content
 */
export interface ExtractedContext {
  // URLs found in the message
  links: ExtractedLink[];

  // Notes/thoughts to save
  notes: ExtractedNote[];

  // Tasks/todos mentioned
  tasks: ExtractedTask[];

  // Reminders requested
  reminders: ExtractedReminder[];

  // Whether this message is a command (e.g., "/save", "/remind")
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
}

export interface ExtractedLink {
  url: string;
  title?: string;
  description?: string;
  context?: string; // surrounding text
}

export interface ExtractedNote {
  content: string;
  title?: string;
  tags?: string[];
}

export interface ExtractedTask {
  title: string;
  description?: string;
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
}

export interface ExtractedReminder {
  message: string;
  time: string; // ISO datetime or relative time
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    interval?: number;
  };
}

/**
 * Result of processing a message through our context system
 */
export interface ProcessingResult {
  success: boolean;
  userId?: string;
  saved: {
    links: number;
    notes: number;
    tasks: number;
    reminders: number;
  };
  errors?: string[];
  response?: string; // Optional response to send back to the user
}

/**
 * Configuration for the channel adapter
 */
export interface ChannelConfig {
  // Which platforms to enable
  enabledPlatforms: ChannelPlatform[];

  // Auto-extract options
  autoExtract: {
    links: boolean;
    notes: boolean;
    tasks: boolean;
    reminders: boolean;
  };

  // Command prefix (e.g., "/", "!")
  commandPrefix: string;

  // Whether to send confirmation messages
  sendConfirmations: boolean;
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  enabledPlatforms: ['telegram', 'whatsapp', 'discord', 'slack'],
  autoExtract: {
    links: true,
    notes: false, // Notes require explicit command
    tasks: false, // Tasks require explicit command
    reminders: false, // Reminders require explicit command
  },
  commandPrefix: '/',
  sendConfirmations: true,
};
