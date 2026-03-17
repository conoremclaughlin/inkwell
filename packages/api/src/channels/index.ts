/**
 * Channels module
 *
 * This module provides integration with messaging platforms through clawdbot.
 * It allows the personal context protocol to receive and process messages from:
 * - Telegram
 * - WhatsApp
 * - Discord
 * - Slack
 * - Signal
 * - iMessage
 *
 * Key components:
 * - ChannelAdapter: Processes inbound messages and saves context
 * - ClawdbotBridge: Converts clawdbot's message format to our system
 * - Extractor: Extracts links, notes, tasks, and reminders from messages
 */

// Types
export type {
  ChannelPlatform,
  ChatType,
  InboundMessage,
  MediaAttachment,
  ExtractedContext,
  ExtractedLink,
  ExtractedNote,
  ExtractedTask,
  ExtractedReminder,
  ProcessingResult,
  ChannelConfig,
} from './types';

export { DEFAULT_CHANNEL_CONFIG } from './types';

// Adapter
export { ChannelAdapter, createChannelAdapter } from './adapter';

// Extractor utilities
export { extractContext, extractLinks, hasExtractableContent } from './extractor';

// Clawdbot integration
export type { ClawdbotMsgContext } from './clawdbot-bridge';
export { ClawdbotBridge, createClawdbotBridge, convertClawdbotContext } from './clawdbot-bridge';

// Agent Gateway (agent-to-agent triggers)
export type { AgentTriggerPayload, AgentTriggerResponse, TriggerCallback } from './agent-gateway';
export { AgentGateway, getAgentGateway } from './agent-gateway';

// Channel Gateway (Telegram/WhatsApp/Discord listeners)
export type { ChannelGatewayConfig, IncomingMessageHandler, GatewayChannel } from './gateway';
export { ChannelGateway, getChannelGateway, createChannelGateway } from './gateway';

// Discord listener
export { DiscordListener, createDiscordListener } from './discord-listener';
