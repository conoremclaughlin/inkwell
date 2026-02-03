#!/usr/bin/env npx tsx
/**
 * Myra - Persistent Messaging Process
 *
 * This is a long-lived process that handles Telegram/WhatsApp connections.
 * It does NOT restart on code changes - only restart manually when needed.
 *
 * Communicates with:
 * - MCP Server (via HTTP) for tools and data access
 * - Claude Code backend for AI processing
 *
 * Also runs a small HTTP server for WhatsApp admin endpoints (QR streaming).
 *
 * Run: pm2 start myra
 *      yarn myra
 */

import path from 'path';
import http from 'http';
import QRCode from 'qrcode';
import { getDataComposer, DataComposer } from '../data/composer';
import { createTelegramListener, TelegramListener } from '../channels/telegram-listener';
import { createWhatsAppListener, WhatsAppListener } from '../channels/whatsapp-listener';
import { getAgentGateway, type AgentTriggerPayload } from '../channels/agent-gateway';
import { createSessionHost, SessionHost } from '../agent';
import { setTelegramListener } from '../mcp/tools';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import telegramifyMarkdown from 'telegramify-markdown';

// Activity stream - conversation to user mapping for outbound message logging
const conversationUserMap = new Map<string, string>(); // conversationId -> userId

// Configuration
interface MyraConfig {
  /** Backend type: 'claude-code' (default) or 'direct-api' */
  backend?: 'claude-code' | 'direct-api';
  /** Model to use (default: sonnet) */
  model?: string;
  /** Working directory for Claude Code */
  workingDirectory?: string;
  /** Path to MCP config file */
  mcpConfigPath?: string;
  /** Telegram polling interval in ms */
  telegramPollingInterval?: number;
  /** WhatsApp account ID (default: 'default') */
  whatsappAccountId?: string;
  /** Whether to enable WhatsApp */
  enableWhatsApp?: boolean;
  /** System prompt to append */
  systemPrompt?: string;
  /** Whether to enable message listeners (Telegram/WhatsApp) */
  enableListeners?: boolean;
}

// TEMPORARY: Disable listeners when MCP Server owns the ChannelGateway
// Set ENABLE_MYRA_LISTENERS=true to use Myra's own listeners (legacy mode)
const ENABLE_LISTENERS = process.env.ENABLE_MYRA_LISTENERS === 'true';

// Global state
let sessionHost: SessionHost | null = null;
let telegramListener: TelegramListener | null = null;
let whatsappListener: WhatsAppListener | null = null;
let dataComposer: DataComposer | null = null;
let httpServer: http.Server | null = null;
let isShuttingDown = false;

// Cache the most recent QR code for new SSE clients
let cachedQrCode: string | null = null;

// Typing indicator management
const activeTypingIntervals: Map<string, NodeJS.Timeout> = new Map();
const TYPING_INTERVAL_MS = 4000;

function startTypingIndicator(conversationId: string, channel: 'telegram' | 'whatsapp' = 'telegram'): void {
  stopTypingIndicator(conversationId);

  if (channel === 'telegram' && telegramListener) {
    telegramListener.sendTypingIndicator(conversationId);
  } else if (channel === 'whatsapp' && whatsappListener) {
    whatsappListener.sendTypingIndicator(conversationId);
  }

  const interval = setInterval(() => {
    if (channel === 'telegram' && telegramListener) {
      telegramListener.sendTypingIndicator(conversationId);
    } else if (channel === 'whatsapp' && whatsappListener) {
      whatsappListener.sendTypingIndicator(conversationId);
    }
  }, TYPING_INTERVAL_MS);

  activeTypingIntervals.set(conversationId, interval);
}

function stopTypingIndicator(conversationId: string): void {
  const interval = activeTypingIntervals.get(conversationId);
  if (interval) {
    clearInterval(interval);
    activeTypingIntervals.delete(conversationId);
  }
}

/**
 * Check Myra's inbox for messages from other agents and process them
 */
async function checkAndProcessInbox(): Promise<void> {
  if (!dataComposer || !sessionHost) {
    logger.warn('[Inbox] Cannot check inbox - not initialized');
    return;
  }

  try {
    const supabase = dataComposer.getClient();

    // Fetch unread messages for Myra
    const { data: messages, error } = await supabase
      .from('agent_inbox')
      .select('*')
      .eq('recipient_agent_id', 'myra')
      .eq('status', 'unread')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      logger.error('[Inbox] Failed to fetch inbox:', error);
      return;
    }

    if (!messages || messages.length === 0) {
      logger.debug('[Inbox] No unread messages');
      return;
    }

    logger.info(`[Inbox] Found ${messages.length} unread message(s)`);

    for (const msg of messages) {
      logger.info(`[Inbox] Processing message from ${msg.sender_agent_id || 'unknown'}:`, {
        subject: msg.subject,
        type: msg.message_type,
        priority: msg.priority,
      });

      // Mark as read immediately to avoid reprocessing
      await supabase
        .from('agent_inbox')
        .update({ status: 'read', read_at: new Date().toISOString() })
        .eq('id', msg.id);

      // Build a prompt for the session host to process
      const inboxPrompt = `
[AGENT INBOX MESSAGE]
From: ${msg.sender_agent_id || 'unknown agent'}
Subject: ${msg.subject || 'No subject'}
Priority: ${msg.priority}
Type: ${msg.message_type}

${msg.content}

---
IMPORTANT: This message came through your agent inbox, NOT from a user on Telegram/WhatsApp.
Your normal response here will NOT reach anyone on messaging platforms.

If you need to send a message to a user on Telegram:
1. Check user.contacts in your bootstrap for their telegramId
2. Call the send_response MCP tool with:
   - channel: "telegram"
   - conversationId: the user's telegramId (e.g., "726555973" for Conor)
   - content: your message

Do NOT just respond - you MUST explicitly call send_response to reach external channels.
`;

      // Send to session host for processing (using a virtual "agent" channel)
      await sessionHost.handleMessage(
        'agent',
        `inbox:${msg.id}`,
        { id: msg.sender_agent_id || 'system', name: msg.sender_agent_id || 'system' },
        inboxPrompt,
        {
          chatType: 'direct',
        }
      );

      // Mark as acknowledged after processing
      await supabase
        .from('agent_inbox')
        .update({ status: 'acknowledged' })
        .eq('id', msg.id);

      logger.info(`[Inbox] Message ${msg.id} processed`);
    }
  } catch (error) {
    logger.error('[Inbox] Error checking inbox:', error);
  }
}

/**
 * Handle agent trigger - called when another agent wants to wake us up
 */
async function handleAgentTrigger(payload: AgentTriggerPayload): Promise<void> {
  logger.info(`[Trigger] Received trigger from ${payload.fromAgentId}`, {
    type: payload.triggerType,
    priority: payload.priority,
    summary: payload.summary,
  });

  // Check inbox for the message that triggered us
  await checkAndProcessInbox();
}

/**
 * Resolve or create a Telegram user
 */
async function resolveOrCreateTelegramUser(
  composer: DataComposer,
  message: { sender: { id: string; username?: string; name?: string } }
): Promise<{ id: string } | null> {
  try {
    const user = await composer.repositories.users.findByPlatformId('telegram', message.sender.id);
    if (user) return user;

    // Create new user - use snake_case field names matching database schema
    const displayName = message.sender.name || message.sender.username || `Telegram User ${message.sender.id}`;
    const newUser = await composer.repositories.users.create({
      email: `telegram_${message.sender.id}@placeholder.local`,
      first_name: displayName,
      telegram_id: parseInt(message.sender.id, 10) || null,
    });
    return newUser;
  } catch (error) {
    logger.error('Failed to resolve/create Telegram user:', error);
    return null;
  }
}

/**
 * Resolve or create a WhatsApp user
 */
async function resolveOrCreateWhatsAppUser(
  composer: DataComposer,
  message: { sender: { id: string; name?: string } }
): Promise<{ id: string } | null> {
  try {
    const user = await composer.repositories.users.findByPlatformId('whatsapp', message.sender.id);
    if (user) return user;

    // Create new user - use snake_case field names matching database schema
    const displayName = message.sender.name || `WhatsApp User ${message.sender.id}`;
    const newUser = await composer.repositories.users.create({
      email: `whatsapp_${message.sender.id}@placeholder.local`,
      first_name: displayName,
      whatsapp_id: message.sender.id,
    });
    return newUser;
  } catch (error) {
    logger.error('Failed to resolve/create WhatsApp user:', error);
    return null;
  }
}

/**
 * Build the system prompt
 */
function buildSystemPrompt(additionalPrompt?: string): string {
  const parts: string[] = [];

  parts.push(`## Personal Context Protocol (PCP)

You are Myra, a helpful AI assistant connected to the Personal Context Protocol.
You're receiving messages from various channels (Telegram, WhatsApp, terminal, etc.).

## Response Instructions

Your response will be automatically routed back to the channel the message came from.
Be concise and helpful.

The message metadata shows:
- [Channel: X] - Which platform the message came from (telegram, whatsapp, etc.)
- [Conversation: X] - The conversation/chat ID
- [From: X] - The sender's name or phone number

### Group Chat Behavior (IMPORTANT)

In **group chats** (conversation ID is negative, or chatType is "group"/"supergroup"):
- **ONLY respond if you are directly mentioned** (@myra_help_bot) or called by name ("Myra")
- If the message doesn't mention you, stay silent - do NOT respond
- When you do respond in groups, keep it brief and relevant

In **private/direct chats**: respond to all messages normally.

### Telegram Formatting
When responding to Telegram, use plain text or simple markdown. Keep messages concise.

### WhatsApp Formatting
WhatsApp has limited formatting. Use plain text for best compatibility.
`);

  if (additionalPrompt) {
    parts.push(`\n## Additional Instructions\n\n${additionalPrompt}`);
  }

  return parts.join('\n');
}

/**
 * Start HTTP server for WhatsApp admin endpoints
 * This allows the web dashboard to stream QR codes from Myra
 */
async function startHttpServer(): Promise<void> {
  const port = env.MYRA_HTTP_PORT;

  httpServer = http.createServer((req, res) => {
    // CORS headers for cross-origin requests from web dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'myra' }));
      return;
    }

    // WhatsApp status
    if (url.pathname === '/api/admin/whatsapp/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: whatsappListener?.connected ?? false,
        running: whatsappListener?.running ?? false,
        enabled: !!whatsappListener,
      }));
      return;
    }

    // WhatsApp QR SSE stream
    if (url.pathname === '/api/admin/whatsapp/qr') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send initial status
      if (whatsappListener?.connected) {
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
        // Send cached QR code if available (for clients that connect after QR was generated)
        if (cachedQrCode) {
          res.write(`data: ${JSON.stringify({ type: 'qr', qr: cachedQrCode })}\n\n`);
        }
      }

      if (!whatsappListener) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'WhatsApp not enabled' })}\n\n`);
        return;
      }

      // Event handlers
      const qrHandler = async (qrData: string) => {
        try {
          // Convert QR data to SVG
          const qrSvg = await QRCode.toString(qrData, { type: 'svg', margin: 2, width: 256 });
          cachedQrCode = qrSvg;
          res.write(`data: ${JSON.stringify({ type: 'qr', qr: qrSvg })}\n\n`);
        } catch (err) {
          logger.error('Failed to generate QR SVG:', err);
        }
      };

      const connectedHandler = (info: { jid: string; e164: string | null }) => {
        cachedQrCode = null; // Clear cached QR when connected
        res.write(`data: ${JSON.stringify({ type: 'connected', phoneNumber: info.e164 || info.jid })}\n\n`);
      };

      const disconnectedHandler = () => {
        res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
      };

      // Attach listeners
      whatsappListener.on('qr', qrHandler);
      whatsappListener.on('connected', connectedHandler);
      whatsappListener.on('disconnected', disconnectedHandler);
      whatsappListener.on('loggedOut', disconnectedHandler);

      // Clean up on close
      req.on('close', () => {
        whatsappListener?.off('qr', qrHandler);
        whatsappListener?.off('connected', connectedHandler);
        whatsappListener?.off('disconnected', disconnectedHandler);
        whatsappListener?.off('loggedOut', disconnectedHandler);
      });

      return;
    }

    // Send message endpoint - allows MCP server to route messages through Myra
    if (url.pathname === '/api/admin/send' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { channel, conversationId, content } = JSON.parse(body);
          logger.info(`External send request: ${channel}:${conversationId}`);

          if (channel === 'telegram' && telegramListener) {
            await telegramListener.sendMessage(conversationId, content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, channel, conversationId }));
          } else if (channel === 'whatsapp' && whatsappListener) {
            await whatsappListener.sendMessage(conversationId, content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, channel, conversationId }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Channel ${channel} not available` }));
          }
        } catch (error) {
          logger.error('Send message failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Send failed' }));
        }
      });
      return;
    }

    // Inbox check endpoint - manually trigger inbox processing
    if (url.pathname === '/api/admin/inbox/check' && req.method === 'POST') {
      (async () => {
        try {
          logger.info('Manual inbox check triggered via HTTP');
          await checkAndProcessInbox();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Inbox check completed',
            timestamp: new Date().toISOString(),
          }));
        } catch (error) {
          logger.error('Inbox check failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Inbox check failed',
          }));
        }
      })();
      return;
    }

    // Heartbeat endpoint - trigger reminder processing
    if (url.pathname === '/api/admin/heartbeat' && req.method === 'POST') {
      (async () => {
        try {
          const { processHeartbeat, registerDeliveryChannel } = await import('../services/heartbeat.js');

          // Ensure delivery channels are registered before processing
          const channels: string[] = [];
          if (telegramListener) {
            registerDeliveryChannel('telegram', {
              sendMessage: async (target: string, message: string) => {
                await telegramListener!.sendMessage(target, message);
              },
            });
            channels.push('telegram');
          }
          if (whatsappListener) {
            registerDeliveryChannel('whatsapp', {
              sendMessage: async (target: string, message: string) => {
                await whatsappListener!.sendMessage(target, message);
              },
            });
            channels.push('whatsapp');
          }
          logger.info('Heartbeat triggered', { availableChannels: channels });

          const stats = await processHeartbeat();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            ...stats,
            timestamp: new Date().toISOString(),
          }));
        } catch (error) {
          logger.error('Heartbeat processing failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Heartbeat failed',
          }));
        }
      })();
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    httpServer!.listen(port, () => {
      logger.info(`Myra HTTP server listening on port ${port}`);
      logger.info(`  WhatsApp QR stream: http://localhost:${port}/api/admin/whatsapp/qr`);
      resolve();
    });

    httpServer!.on('error', (err) => {
      logger.error('Failed to start Myra HTTP server:', err);
      reject(err);
    });
  });
}

/**
 * Start Myra
 */
async function startMyra(config: MyraConfig = {}): Promise<void> {
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('  MYRA - Messaging Process');
  logger.info('  This process handles Telegram/WhatsApp connections');
  logger.info('  Restart only when needed: pm2 restart myra');
  logger.info('='.repeat(60));
  logger.info('');

  // Resolve configuration
  const workingDirectory = config.workingDirectory || path.resolve(__dirname, '../../../..');
  const mcpConfigPath = config.mcpConfigPath || path.resolve(workingDirectory, '.mcp.json');
  const model = config.model || env.DEFAULT_MODEL || 'sonnet';
  const backend = config.backend || 'claude-code';

  logger.info('Configuration:', {
    backend,
    workingDirectory,
    mcpConfigPath,
    model,
    enableWhatsApp: config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true'),
  });

  // 1. Initialize data layer (direct connection, not via MCP)
  logger.info('Initializing data layer...');
  dataComposer = await getDataComposer();
  logger.info('Data layer ready');

  // 2. Create Telegram listener (only if listeners are enabled)
  const enableListeners = config.enableListeners ?? ENABLE_LISTENERS;
  if (enableListeners && env.TELEGRAM_BOT_TOKEN) {
    logger.info('Creating Telegram listener...');
    telegramListener = createTelegramListener({
      pollingInterval: config.telegramPollingInterval || 1000,
    });
    setTelegramListener(telegramListener);
    logger.info('Telegram listener created');
  } else if (!enableListeners) {
    logger.info('Telegram listener DISABLED (MCP Server owns ChannelGateway)');
    logger.info('Set ENABLE_MYRA_LISTENERS=true to enable legacy mode');
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set - Telegram disabled');
  }

  // 3. Build system prompt
  const systemPrompt = buildSystemPrompt(config.systemPrompt);

  // 4. Create Session Host with Claude Code backend
  logger.info(`Creating Session Host with ${backend} backend...`);
  sessionHost = createSessionHost({
    dataComposer,
    agentId: 'myra',  // Identity for context injection
    backend: {
      primaryBackend: backend,
      backends: {
        'claude-code': {
          mcpConfigPath,
          workingDirectory,
          model,
          systemPrompt,
        },
        'direct-api': {
          model: 'claude-sonnet-4-20250514',
          systemPrompt,
        },
      },
      enableFailover: true,
    },
    channels: {
      ...(telegramListener ? {
        telegram: {
          sendMessage: async (conversationId, content, options) => {
            const hasMarkdown = /\*\*.+?\*\*|\*.+?\*|`.+?`|^#{1,6}\s/m.test(content);
            let parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' | undefined;
            let processedContent = content;

            if (options?.format === 'markdown' || hasMarkdown) {
              try {
                processedContent = telegramifyMarkdown(content, 'escape');
                parseMode = 'MarkdownV2';
              } catch {
                processedContent = content;
                parseMode = undefined;
              }
            }

            try {
              await telegramListener!.sendMessage(conversationId, processedContent, {
                replyToMessageId: options?.replyToMessageId,
                parseMode,
              });
            } catch (sendError) {
              // If MarkdownV2 formatting failed, retry as plain text
              if (parseMode === 'MarkdownV2') {
                logger.warn('MarkdownV2 send failed, retrying as plain text:', sendError);
                await telegramListener!.sendMessage(conversationId, content, {
                  replyToMessageId: options?.replyToMessageId,
                });
              } else {
                throw sendError;
              }
            }

            // Log outgoing message to activity stream
            const userId = conversationUserMap.get(conversationId);
            if (userId && dataComposer) {
              try {
                await dataComposer.repositories.activityStream.logMessage({
                  userId,
                  agentId: 'myra',
                  direction: 'out',
                  content,
                  platform: 'telegram',
                  platformChatId: conversationId,
                  isDm: true, // Will be corrected by context
                });
              } catch (activityError) {
                logger.warn('Failed to log outgoing message to activity stream:', activityError);
              }
            }
          },
        },
      } : {}),
    },
  });

  // Forward events to console
  sessionHost.on('text', (text: string) => {
    process.stdout.write(text);
  });

  sessionHost.on('backend:ready', (type: string) => {
    logger.info(`Backend ready: ${type}`);
  });

  sessionHost.on('backend:error', ({ type, error }: { type: string; error: Error }) => {
    logger.error(`Backend error (${type}):`, error);
  });

  sessionHost.on('response:sent', (response: { channel: string; conversationId: string }) => {
    logger.info(`Response sent to ${response.channel}:${response.conversationId}`);
    stopTypingIndicator(response.conversationId);
  });

  // 5. Initialize Session Host (starts Claude Code)
  logger.info('Initializing Session Host (starting Claude Code)...');
  await sessionHost.initialize();
  logger.info('Session Host ready');

  // 5b. Register agent trigger handler for instant wake-up
  const agentGateway = getAgentGateway();
  agentGateway.registerHandler('myra', handleAgentTrigger);
  logger.info('Agent trigger handler registered for myra');

  // 5c. Register 'agent' channel for inbox message responses
  // Responses to inbox messages get logged but don't go anywhere specific
  sessionHost.registerChannel('agent', {
    sendMessage: async (conversationId, content) => {
      logger.info(`[Agent Response] ${conversationId}: ${content.substring(0, 100)}...`);
      // For now, just log. Could send back to sender's inbox if needed.
    },
  });

  // 6. Wire up Telegram message handling (only if listeners are enabled)
  if (enableListeners && telegramListener) {
    telegramListener.onMessage(async (message) => {
      const senderId = message.sender.id ?? 'unknown';
      const conversationId = message.conversationId || senderId;
      // chatType is 'direct' | 'group' | 'channel' - treat 'group' and 'channel' as group contexts
      const isGroupChat = message.chatType === 'group' || message.chatType === 'channel';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`[Telegram] Message from @${message.sender.username || senderId}`, {
        chatType: message.chatType,
        botMentioned,
      });

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping group message - bot not mentioned');
        return;
      }

      startTypingIndicator(conversationId, 'telegram');

      try {
        // Ensure sender.id is defined for user resolution
        const senderForUser = {
          sender: {
            id: senderId,
            username: message.sender.username,
            name: message.sender.name,
          }
        };
        const user = await resolveOrCreateTelegramUser(dataComposer!, senderForUser);

        // Log incoming message to activity stream
        if (user?.id) {
          conversationUserMap.set(conversationId, user.id);
          try {
            await dataComposer!.repositories.activityStream.logMessage({
              userId: user.id,
              agentId: 'myra',
              direction: 'in',
              content: message.body,
              platform: 'telegram',
              platformMessageId: message.messageId,
              platformChatId: conversationId,
              isDm: !isGroupChat,
              payload: {
                senderName: message.sender.name || message.sender.username,
                senderId: senderId,
              },
            });
          } catch (activityError) {
            logger.warn('Failed to log incoming message to activity stream:', activityError);
          }
        }

        await sessionHost!.handleMessage(
          'telegram',
          conversationId,
          {
            id: senderId,
            name: message.sender.name || message.sender.username,
          },
          message.body,
          {
            userId: user?.id,
            chatType: message.chatType,
            mentions: message.mentions,
          }
        );
      } catch (error) {
        logger.error('Error handling Telegram message:', error);
        stopTypingIndicator(conversationId);
        try {
          await telegramListener!.sendMessage(
            conversationId,
            'Sorry, I encountered an error. Please try again.'
          );
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
    });

    await telegramListener.start();
    logger.info('Telegram listener started');
  }

  // 7. Create and start WhatsApp listener if enabled (and listeners are enabled)
  const enableWhatsApp = config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true');
  if (enableListeners && enableWhatsApp) {
    logger.info('Creating WhatsApp listener...');
    whatsappListener = createWhatsAppListener({
      accountId: config.whatsappAccountId || 'default',
      printQr: true,
      onQr: () => {
        logger.info('WhatsApp QR code ready for scanning');
      },
    });

    // Add WhatsApp channel to session host
    sessionHost.registerChannel('whatsapp', {
      sendMessage: async (conversationId: string, content: string) => {
        await whatsappListener!.sendMessage(conversationId, content);
      },
    });

    // Handle WhatsApp messages
    whatsappListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`[WhatsApp] Message from ${message.sender.name || senderId}`, {
        chatType: message.chatType,
        botMentioned,
      });

      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping WhatsApp group message - bot not mentioned');
        return;
      }

      startTypingIndicator(conversationId, 'whatsapp');

      try {
        // Ensure sender.id is defined for user resolution
        const senderForUser = {
          sender: {
            id: senderId,
            name: message.sender.name,
          }
        };
        const user = await resolveOrCreateWhatsAppUser(dataComposer!, senderForUser);

        await sessionHost!.handleMessage(
          'whatsapp',
          conversationId,
          {
            id: senderId,
            name: message.sender.name,
          },
          message.body,
          {
            userId: user?.id,
            chatType: message.chatType,
            mentions: message.mentions,
          }
        );
      } catch (error) {
        logger.error('Error handling WhatsApp message:', error);
        stopTypingIndicator(conversationId);
        try {
          await whatsappListener!.sendMessage(
            conversationId,
            'Sorry, I encountered an error. Please try again.'
          );
        } catch (sendError) {
          logger.error('Failed to send WhatsApp error message:', sendError);
        }
      }
    });

    whatsappListener.on('connected', (info: { jid: string; e164: string | null }) => {
      cachedQrCode = null; // Clear QR on connect
      logger.info(`WhatsApp connected: ${info.e164 || info.jid}`);
    });

    whatsappListener.on('qr', async (qrData: string) => {
      try {
        // Convert QR data to SVG for web dashboard
        cachedQrCode = await QRCode.toString(qrData, { type: 'svg', margin: 2, width: 256 });
        logger.info('WhatsApp QR code displayed - please scan with your phone');
      } catch (err) {
        logger.error('Failed to generate QR SVG:', err);
      }
    });

    whatsappListener.on('loggedOut', () => {
      logger.warn('WhatsApp logged out - please re-scan QR code');
    });

    whatsappListener.on('error', (error: Error) => {
      logger.error('WhatsApp error:', error);
    });

    await whatsappListener.start();
    logger.info('WhatsApp listener started');
  } else {
    logger.info('WhatsApp disabled (set ENABLE_WHATSAPP=true to enable)');
  }

  // 8. Start HTTP server for WhatsApp admin endpoints (QR streaming)
  await startHttpServer();

  // 9. Initialize heartbeat service for local development
  const { initHeartbeatService, registerDeliveryChannel } = await import('../services/heartbeat.js');

  // Register delivery channels
  if (telegramListener) {
    registerDeliveryChannel('telegram', {
      sendMessage: async (target: string, message: string) => {
        await telegramListener!.sendMessage(target, message);
      },
    });
  }

  if (whatsappListener) {
    registerDeliveryChannel('whatsapp', {
      sendMessage: async (target: string, message: string) => {
        await whatsappListener!.sendMessage(target, message);
      },
    });
  }

  // Start local cron scheduler (disabled in production - uses pg_cron instead)
  const enableLocalCron = process.env.NODE_ENV !== 'production' && process.env.ENABLE_LOCAL_HEARTBEAT !== 'false';
  initHeartbeatService({
    interval: process.env.HEARTBEAT_INTERVAL || '*/5 * * * *', // Every 5 minutes
    enableLocalCron,
    // Add inbox checking to heartbeat
    onHeartbeat: async () => {
      await checkAndProcessInbox();
    },
  });

  if (enableLocalCron) {
    logger.info('Heartbeat service started (local cron mode)');
  } else {
    logger.info('Heartbeat service initialized (cloud mode - uses pg_cron)');
  }

  // 10. Print status
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('  MYRA IS RUNNING');
  logger.info('='.repeat(60));
  const channels: string[] = [];
  if (telegramListener) channels.push('Telegram');
  if (whatsappListener) channels.push('WhatsApp');
  if (channels.length > 0) {
    logger.info(`Active channels: ${channels.join(', ')}`);
    logger.info('Send a message to start a conversation!');
  } else {
    logger.warn('No messaging channels enabled.');
  }
  if (enableLocalCron) {
    logger.info('Heartbeat: local cron (every 5 min)');
  }
  logger.info('');
  logger.info('To restart Myra: pm2 restart myra');
  logger.info('To view logs: pm2 logs myra');
  logger.info('');
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('');
  logger.info('Shutting down Myra...');

  // Clear all typing intervals
  for (const interval of activeTypingIntervals.values()) {
    clearInterval(interval);
  }
  activeTypingIntervals.clear();

  // Stop heartbeat service
  try {
    const { stopHeartbeatService } = await import('../services/heartbeat.js');
    stopHeartbeatService();
    logger.info('Heartbeat service stopped');
  } catch {
    // May not be initialized
  }

  // Stop HTTP server
  if (httpServer) {
    logger.info('Stopping HTTP server...');
    httpServer.close();
  }

  // Stop listeners
  if (telegramListener) {
    logger.info('Stopping Telegram listener...');
    await telegramListener.stop();
  }

  if (whatsappListener) {
    logger.info('Stopping WhatsApp listener...');
    await whatsappListener.stop();
  }

  // Shutdown session host
  if (sessionHost) {
    logger.info('Stopping Session Host...');
    await sessionHost.shutdown();
  }

  logger.info('Myra shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start Myra
startMyra({
  backend: (process.env.PCP_BACKEND as 'claude-code' | 'direct-api') || 'claude-code',
  model: env.DEFAULT_MODEL || 'sonnet',
  workingDirectory: process.env.PCP_WORKING_DIR || path.resolve(__dirname, '../../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
  systemPrompt: process.env.PCP_SYSTEM_PROMPT,
}).catch((error) => {
  logger.error('Failed to start Myra:', error);
  process.exit(1);
});
