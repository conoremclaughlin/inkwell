/**
 * WhatsApp Listener Service
 *
 * Listens for incoming WhatsApp messages via Baileys (WhatsApp Web protocol)
 * and routes them to the SessionService for processing.
 *
 * Uses the same authorization model as Telegram:
 * - DMs: Only from trusted users
 * - Groups: Only authorized groups, with @mention or name trigger
 */

import { EventEmitter } from 'events';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import type { InboundMessage, ChannelPlatform } from './types';
import { logger } from '../utils/logger';
import { getAuthorizationService, type AuthorizationService } from '../services/authorization';
import { resolveAuthDir, ensureAuthDir, readSelfId, loadAuthState } from './whatsapp-auth';

// Baileys types - use any since it's an ESM module and type imports are problematic
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WASocket = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WAMessage = any;

export interface WhatsAppListenerConfig {
  /** Account ID (default: 'default') */
  accountId?: string;
  /** Whether to print QR code in terminal */
  printQr?: boolean;
  /** Callback when QR code is available */
  onQr?: (qr: string) => void;
  /** Allowed phone numbers (E.164 format, empty = use authorization service) */
  allowFrom?: string[];
}

export type MessageCallback = (message: InboundMessage) => Promise<void>;

// Ephemeral message storage for context (not persisted to DB)
interface EphemeralMessage {
  messageId: string;
  chatId: string;
  from: string;
  fromId: string;
  text: string;
  timestamp: Date;
}

export class WhatsAppListener extends EventEmitter {
  private config: WhatsAppListenerConfig;
  private sock: WASocket | null = null;
  private isRunning = false;
  private isConnected = false;
  private messageCallback?: MessageCallback;
  private authService: AuthorizationService;
  private selfJid: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  // Ephemeral message cache
  private messageCache = new Map<string, EphemeralMessage[]>();
  private readonly maxMessagesPerChat = 100;
  private readonly messageTtlMs = 30 * 60 * 1000; // 30 minutes

  constructor(config?: WhatsAppListenerConfig) {
    super();
    this.config = {
      accountId: config?.accountId ?? 'default',
      printQr: config?.printQr ?? true,
      ...config,
    };
    this.authService = getAuthorizationService();
  }

  /**
   * Set the callback for incoming messages
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start listening for messages
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('WhatsAppListener is already running');
      return;
    }

    logger.info('Starting WhatsApp listener...', { accountId: this.config.accountId });
    this.isRunning = true;

    await this.connect();
  }

  /**
   * Connect to WhatsApp
   */
  private async connect(): Promise<void> {
    const accountId = this.config.accountId!;
    const authDir = resolveAuthDir(accountId);
    await ensureAuthDir(authDir);

    // Dynamic import for ESM module
    const {
      makeWASocket,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
    } = await import('@whiskeysockets/baileys');

    // Create Baileys logger (silent unless debugging)
    const baileysLogger = pino({ level: 'silent' });

    // Load auth state
    const { state, saveCreds } = await loadAuthState(accountId);
    const { version } = await fetchLatestBaileysVersion();

    // Create socket
    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ['PCP', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Handle connection updates
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code for login
      if (qr) {
        logger.info('WhatsApp QR code available - scan with your phone');
        this.config.onQr?.(qr);
        if (this.config.printQr) {
          console.log('\n📱 Scan this QR code in WhatsApp (Settings → Linked Devices):\n');
          qrcode.generate(qr, { small: true });
        }
        this.emit('qr', qr);
      }

      // Connection state changes
      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.error('WhatsApp logged out - please re-link via QR code');
          this.emit('loggedOut');
          this.isRunning = false;
        } else if (shouldReconnect && this.isRunning) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
            logger.info(`WhatsApp reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
          } else {
            logger.error('WhatsApp max reconnect attempts reached');
            this.isRunning = false;
            this.emit('error', new Error('Max reconnect attempts reached'));
          }
        }
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.selfJid = this.sock?.user?.id || null;
        const { e164 } = readSelfId(accountId);
        logger.info(`WhatsApp connected: ${e164 || this.selfJid}`);
        this.emit('connected', { jid: this.selfJid, e164 });
      }
    });

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sock.ev.on('messages.upsert', async (m: any) => {
      await this.handleMessagesUpsert(m);
    });
  }

  /**
   * Stop listening for messages
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping WhatsApp listener...');
    this.isRunning = false;

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.emit('disconnected');
  }

  /**
   * Handle incoming messages
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessagesUpsert(m: any): Promise<void> {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        await this.handleMessage(msg);
      } catch (error) {
        logger.error('Error handling WhatsApp message:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Handle a single message
   */
  private async handleMessage(msg: WAMessage): Promise<void> {
    // Skip if no message content
    if (!msg.message) return;

    // Skip status broadcasts
    if (msg.key.remoteJid === 'status@broadcast') return;

    // Skip messages from self
    if (msg.key.fromMe) return;

    const chatId = msg.key.remoteJid!;
    const isGroup = chatId.endsWith('@g.us');
    const senderId = isGroup ? msg.key.participant! : chatId;

    // Extract text content
    const text = this.extractMessageText(msg);
    if (!text) return;

    // Normalize sender ID to E.164
    const senderE164 = this.jidToE164(senderId);

    // ========== AUTHORIZATION CHECK ==========

    if (isGroup) {
      // Check if group is authorized
      const isAuthorized = await this.authService.isGroupAuthorized('whatsapp', chatId);

      if (!isAuthorized) {
        // Only respond to /authorize command
        if (this.isAuthorizeCommand(text)) {
          await this.handleAuthorizeCommand(msg, chatId, text);
          return;
        }

        logger.debug(`Ignoring message from unauthorized WhatsApp group: ${chatId}`);
        return;
      }

      // Group mention filtering is handled by the ChannelGateway's isAgentMentioned()
      // which uses dynamic agent names. The listener passes all authorized group messages through.
    } else {
      // DM: Check if user is trusted
      const trustedUser = await this.authService.isUserTrusted('whatsapp', senderE164);

      if (!trustedUser) {
        logger.debug(`Ignoring DM from untrusted WhatsApp user: ${senderE164}`);
        return;
      }

      // Handle DM commands for trusted users
      if (await this.handleTrustedUserCommand(msg, chatId, senderE164, text)) {
        return;
      }
    }

    // ========== NORMAL MESSAGE PROCESSING ==========

    const message = await this.convertMessage(msg, isGroup);

    // Cache message for context
    this.cacheMessage({
      messageId: msg.key.id!,
      chatId,
      from: message.sender.name || senderE164,
      fromId: senderE164,
      text: message.body,
      timestamp: new Date(Number(msg.messageTimestamp) * 1000),
    });

    logger.info(`Received WhatsApp message from ${senderE164}`, {
      chatId,
      messageId: msg.key.id,
      isGroup,
      body: message.body.substring(0, 50),
    });

    this.emit('message', message);

    if (this.messageCallback) {
      try {
        await this.messageCallback(message);
      } catch (error) {
        logger.error('Error in message callback:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Extract text content from a message
   */
  private extractMessageText(msg: WAMessage): string | null {
    const m = msg.message!;

    // Regular text
    if (m.conversation) return m.conversation;

    // Extended text (with link preview, etc.)
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

    // Image/video caption
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;

    // Button response
    if (m.buttonsResponseMessage?.selectedDisplayText) {
      return m.buttonsResponseMessage.selectedDisplayText;
    }

    // List response
    if (m.listResponseMessage?.title) {
      return m.listResponseMessage.title;
    }

    return null;
  }

  /**
   * Convert JID to E.164 format
   */
  private jidToE164(jid: string): string {
    // JID format: 1234567890@s.whatsapp.net or 1234567890:123@s.whatsapp.net
    const match = jid.match(/^(\d+)/);
    return match ? `+${match[1]}` : jid;
  }

  /**
   * Check if text is an /authorize command
   */
  private isAuthorizeCommand(text: string): boolean {
    return text.trim().toLowerCase().startsWith('/authorize');
  }

  /**
   * Handle /authorize command in unauthorized group
   */
  private async handleAuthorizeCommand(
    _msg: WAMessage,
    chatId: string,
    text: string
  ): Promise<void> {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return;

    const code = parts[1];

    // Get group name if available
    let groupName: string | null = null;
    try {
      if (this.sock) {
        const metadata = await this.sock.groupMetadata(chatId);
        groupName = metadata.subject;
      }
    } catch {
      // Ignore metadata fetch errors
    }

    const result = await this.authService.authorizeGroupWithCode(
      'whatsapp',
      chatId,
      groupName,
      code
    );

    if (result.success) {
      await this.sendMessage(chatId, `✓ Group authorized! I'm now active in this chat.`);
      logger.info('WhatsApp group authorized via challenge code', { chatId, groupName });
    } else if (result.error === 'Invalid or expired code') {
      await this.sendMessage(
        chatId,
        `✗ Invalid or expired code. Please get a new code from a trusted user.`
      );
    }
  }

  /**
   * Handle DM commands for trusted users
   */
  private async handleTrustedUserCommand(
    _msg: WAMessage,
    chatId: string,
    userId: string,
    text: string
  ): Promise<boolean> {
    const command = text.trim().toLowerCase().split(/\s+/)[0];

    switch (command) {
      case '/generate-group-code':
      case '/groupcode':
        return this.handleGenerateCodeCommand(chatId, userId);

      case '/list-groups':
      case '/groups':
        return this.handleListGroupsCommand(chatId);

      case '/list-trusted':
      case '/trusted':
        return this.handleListTrustedCommand(chatId);

      case '/add-trusted':
        return this.handleAddTrustedCommand(chatId, userId, text);

      case '/revoke-group':
        return this.handleRevokeGroupCommand(chatId, userId, text);

      default:
        return false;
    }
  }

  /**
   * Handle /generate-group-code command
   */
  private async handleGenerateCodeCommand(chatId: string, userId: string): Promise<boolean> {
    const code = await this.authService.generateChallengeCode('whatsapp', userId);

    if (code) {
      await this.sendMessage(
        chatId,
        `🔑 Group authorization code: *${code}*\n\n` +
          `This code expires in 24 hours.\n` +
          `To authorize a group, add me to the group and send:\n` +
          `/authorize ${code}`
      );
    } else {
      await this.sendMessage(
        chatId,
        `Unable to generate code. You may have reached the limit of 5 active codes.`
      );
    }
    return true;
  }

  /**
   * Handle /list-groups command
   */
  private async handleListGroupsCommand(chatId: string): Promise<boolean> {
    const groups = await this.authService.listAuthorizedGroups('whatsapp');

    if (groups.length === 0) {
      await this.sendMessage(chatId, `No authorized WhatsApp groups yet.`);
    } else {
      const lines = groups.map(
        (g) => `• ${g.groupName || g.platformGroupId} (${g.authorizationMethod})`
      );
      await this.sendMessage(chatId, `Authorized WhatsApp groups:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /list-trusted command
   */
  private async handleListTrustedCommand(chatId: string): Promise<boolean> {
    const users = await this.authService.listTrustedUsers('whatsapp');

    if (users.length === 0) {
      await this.sendMessage(chatId, `No trusted WhatsApp users configured.`);
    } else {
      const lines = users.map((u) => `• ${u.platformUserId} (${u.trustLevel})`);
      await this.sendMessage(chatId, `Trusted WhatsApp users:\n${lines.join('\n')}`);
    }
    return true;
  }

  /**
   * Handle /add-trusted command
   */
  private async handleAddTrustedCommand(
    chatId: string,
    addedByUserId: string,
    text: string
  ): Promise<boolean> {
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        chatId,
        `Usage: /add-trusted <phone_e164> [admin|member]\nExample: /add-trusted +14155551234 member`
      );
      return true;
    }

    const targetUserId = parts[1];
    const trustLevel = (parts[2]?.toLowerCase() === 'admin' ? 'admin' : 'member') as
      | 'admin'
      | 'member';

    const result = await this.authService.addTrustedUser(
      'whatsapp',
      targetUserId,
      trustLevel,
      addedByUserId
    );

    if (result.success) {
      await this.sendMessage(chatId, `✓ Added ${targetUserId} as trusted ${trustLevel}.`);
    } else {
      await this.sendMessage(chatId, `✗ ${result.error}`);
    }
    return true;
  }

  /**
   * Handle /revoke-group command
   */
  private async handleRevokeGroupCommand(
    chatId: string,
    userId: string,
    text: string
  ): Promise<boolean> {
    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
      await this.sendMessage(
        chatId,
        `Usage: /revoke-group <group_jid>\nExample: /revoke-group 123456789-1234567890@g.us`
      );
      return true;
    }

    const groupId = parts[1];
    const result = await this.authService.revokeGroup('whatsapp', groupId, userId);

    if (result.success) {
      // Leave the group
      try {
        if (this.sock) {
          await this.sock.groupLeave(groupId);
        }
        await this.sendMessage(chatId, `✓ Revoked and left group ${groupId}.`);
      } catch {
        await this.sendMessage(
          chatId,
          `✓ Revoked group ${groupId}. (Could not leave - may have already left)`
        );
      }
    } else {
      await this.sendMessage(chatId, `✗ ${result.error}`);
    }
    return true;
  }

  /**
   * Convert WhatsApp message to InboundMessage format
   */
  private async convertMessage(msg: WAMessage, isGroup: boolean): Promise<InboundMessage> {
    const chatId = msg.key.remoteJid!;
    const senderId = isGroup ? msg.key.participant! : chatId;
    const senderE164 = this.jidToE164(senderId);
    const text = this.extractMessageText(msg) || '';

    // Get sender name from push name
    const senderName = msg.pushName || null;

    // Get group subject if group chat
    let groupSubject: string | undefined;
    if (isGroup && this.sock) {
      try {
        const metadata = await this.sock.groupMetadata(chatId);
        groupSubject = metadata.subject;
      } catch {
        // Ignore
      }
    }

    // Account ID from WhatsApp self JID (e.g. "+16266621947")
    const accountId = this.selfJid ? this.jidToE164(this.selfJid) : undefined;

    const message: InboundMessage = {
      body: text,
      rawBody: text,
      timestamp: Number(msg.messageTimestamp) * 1000,
      messageId: msg.key.id!,
      platform: 'whatsapp' as ChannelPlatform,
      chatType: isGroup ? 'group' : 'direct',
      accountId,
      sender: {
        id: senderE164,
        name: senderName || undefined,
      },
      conversationId: chatId,
      conversationLabel: groupSubject || senderName || senderE164,
      groupSubject,
    };

    // WhatsApp doesn't have native bot @mentions.
    // Agent name matching is handled by ChannelGateway.isAgentMentioned().
    message.mentions = {
      users: [],
      botMentioned: false,
    };

    // Handle quoted/reply message
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (contextInfo?.quotedMessage) {
      const quotedText =
        contextInfo.quotedMessage.conversation ||
        contextInfo.quotedMessage.extendedTextMessage?.text ||
        '';
      message.replyTo = {
        id: contextInfo.stanzaId || '',
        body: quotedText,
        sender: contextInfo.participant ? this.jidToE164(contextInfo.participant) : undefined,
      };
    }

    message.raw = msg;

    return message;
  }

  /**
   * Send a message
   */
  async sendMessage(conversationId: string, content: string): Promise<void> {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    // Normalize conversation ID
    const jid = conversationId.startsWith('whatsapp:')
      ? conversationId.replace('whatsapp:', '')
      : conversationId;

    // Chunk long messages (WhatsApp limit ~4000)
    const chunks = this.chunkMessage(content, 4000);

    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
    }

    logger.info(`Sent WhatsApp message to ${jid}`);
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(conversationId: string): Promise<void> {
    if (!this.sock || !this.isConnected) return;

    const jid = conversationId.startsWith('whatsapp:')
      ? conversationId.replace('whatsapp:', '')
      : conversationId;

    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch {
      // Non-critical
    }
  }

  /**
   * Chunk message to fit WhatsApp limits
   */
  private chunkMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }

      // Try to split on newline
      let splitIndex = remaining.lastIndexOf('\n', limit);
      if (splitIndex === -1 || splitIndex < limit * 0.5) {
        // Fall back to space
        splitIndex = remaining.lastIndexOf(' ', limit);
      }
      if (splitIndex === -1 || splitIndex < limit * 0.5) {
        // Hard split
        splitIndex = limit;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  /**
   * Cache a message for context
   */
  private cacheMessage(message: EphemeralMessage): void {
    const { chatId } = message;

    if (!this.messageCache.has(chatId)) {
      this.messageCache.set(chatId, []);
    }

    const cache = this.messageCache.get(chatId)!;
    cache.push(message);

    if (cache.length > this.maxMessagesPerChat) {
      cache.shift();
    }

    this.cleanExpiredMessages(chatId);
  }

  /**
   * Clean expired messages
   */
  private cleanExpiredMessages(chatId: string): void {
    const cache = this.messageCache.get(chatId);
    if (!cache) return;

    const now = Date.now();
    const filtered = cache.filter((msg) => now - msg.timestamp.getTime() < this.messageTtlMs);

    if (filtered.length !== cache.length) {
      this.messageCache.set(chatId, filtered);
    }
  }

  /**
   * Get recent messages from cache
   */
  getRecentMessages(chatId: string, limit = 50): EphemeralMessage[] {
    this.cleanExpiredMessages(chatId);
    const cache = this.messageCache.get(chatId) || [];
    return cache.slice(-limit);
  }

  /**
   * Clear message cache
   */
  clearMessageCache(chatId: string): void {
    this.messageCache.delete(chatId);
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { chatCount: number; totalMessages: number } {
    let totalMessages = 0;
    for (const messages of this.messageCache.values()) {
      totalMessages += messages.length;
    }
    return {
      chatCount: this.messageCache.size,
      totalMessages,
    };
  }

  get running(): boolean {
    return this.isRunning;
  }

  get connected(): boolean {
    return this.isConnected;
  }
}

/**
 * Create a WhatsApp listener instance
 */
export function createWhatsAppListener(config?: WhatsAppListenerConfig): WhatsAppListener {
  return new WhatsAppListener(config);
}
