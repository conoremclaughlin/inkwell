/**
 * Gmail Service
 *
 * Handles Gmail API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, gmail_v1 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import type {
  Email,
  EmailAddress,
  EmailAttachment,
  EmailLabel,
  EmailSearchResult,
  ListEmailsOptions,
  GetEmailOptions,
  SendEmailOptions,
  DraftEmailOptions,
  ReplyToEmailOptions,
  ModifyEmailOptions,
  ModifyEmailResult,
} from './types';

export class GmailService {
  private oauthService = getOAuthService();

  /**
   * Get an authenticated Gmail API client for a user
   */
  private async getClient(userId: string): Promise<gmail_v1.Gmail> {
    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.gmail({ version: 'v1', auth });
  }

  /**
   * List emails with optional filters
   */
  async listEmails(userId: string, options: ListEmailsOptions = {}): Promise<EmailSearchResult> {
    const gmail = await this.getClient(userId);

    const {
      maxResults = 10,
      query,
      labelIds,
      pageToken,
      includeSpamTrash = false,
    } = options;

    logger.info('Fetching emails', { userId, maxResults, query, labelIds });

    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      q: query,
      labelIds,
      pageToken,
      includeSpamTrash,
    });

    const messages = response.data.messages || [];

    // Fetch full details for each message
    const emails = await Promise.all(
      messages.map(async (msg) => {
        const fullMessage = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        return this.mapMessage(fullMessage.data);
      })
    );

    return {
      emails,
      nextPageToken: response.data.nextPageToken || undefined,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };
  }

  /**
   * Get a single email by ID
   */
  async getEmail(userId: string, options: GetEmailOptions): Promise<Email> {
    const gmail = await this.getClient(userId);

    const { messageId, format = 'full' } = options;

    logger.info('Fetching email', { userId, messageId });

    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format,
    });

    return this.mapMessage(response.data, true);
  }

  /**
   * Send a new email
   */
  async sendEmail(userId: string, options: SendEmailOptions): Promise<Email> {
    const gmail = await this.getClient(userId);

    const {
      to,
      cc,
      bcc,
      subject,
      body,
      isHtml = false,
      replyToMessageId,
      threadId,
    } = options;

    logger.info('Sending email', { userId, to, subject });

    // Build the email
    const headers: string[] = [
      `To: ${to.join(', ')}`,
      `Subject: ${subject}`,
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
    ];

    if (cc?.length) {
      headers.push(`Cc: ${cc.join(', ')}`);
    }
    if (bcc?.length) {
      headers.push(`Bcc: ${bcc.join(', ')}`);
    }

    // If replying, add threading headers
    if (replyToMessageId) {
      const originalMessage = await gmail.users.messages.get({
        userId: 'me',
        id: replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });

      const originalHeaders = originalMessage.data.payload?.headers || [];
      const messageIdHeader = originalHeaders.find(h => h.name === 'Message-ID')?.value;
      const referencesHeader = originalHeaders.find(h => h.name === 'References')?.value;

      if (messageIdHeader) {
        headers.push(`In-Reply-To: ${messageIdHeader}`);
        const references = referencesHeader
          ? `${referencesHeader} ${messageIdHeader}`
          : messageIdHeader;
        headers.push(`References: ${references}`);
      }
    }

    const email = `${headers.join('\r\n')}\r\n\r\n${body}`;
    const encodedEmail = Buffer.from(email).toString('base64url');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId,
      },
    });

    // Fetch the sent message to return full details
    const sentMessage = await gmail.users.messages.get({
      userId: 'me',
      id: response.data.id!,
      format: 'full',
    });

    return this.mapMessage(sentMessage.data, true);
  }

  /**
   * Reply to an existing email
   */
  async replyToEmail(userId: string, options: ReplyToEmailOptions): Promise<Email> {
    const gmail = await this.getClient(userId);

    const { messageId, body, isHtml = false, replyAll = false } = options;

    logger.info('Replying to email', { userId, messageId, replyAll });

    // Get the original message
    const originalMessage = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    });

    const originalHeaders = originalMessage.data.payload?.headers || [];
    const getHeader = (name: string) => originalHeaders.find(h => h.name === name)?.value;

    const originalFrom = getHeader('From') || '';
    const originalTo = getHeader('To') || '';
    const originalCc = getHeader('Cc');
    const originalSubject = getHeader('Subject') || '';

    // Build recipient list
    const to = [this.parseEmailAddress(originalFrom).email];
    let cc: string[] = [];

    if (replyAll) {
      // Add original To and Cc recipients (excluding self)
      const toAddresses = originalTo.split(',').map(e => this.parseEmailAddress(e.trim()).email);
      const ccAddresses = originalCc
        ? originalCc.split(',').map(e => this.parseEmailAddress(e.trim()).email)
        : [];

      // TODO: Filter out the user's own email
      cc = [...toAddresses, ...ccAddresses].filter(e => e !== to[0]);
    }

    // Build subject (add Re: if not already present)
    const subject = originalSubject.startsWith('Re:')
      ? originalSubject
      : `Re: ${originalSubject}`;

    return this.sendEmail(userId, {
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      body,
      isHtml,
      replyToMessageId: messageId,
      threadId: originalMessage.data.threadId || undefined,
    });
  }

  /**
   * Create a draft email
   */
  async createDraft(userId: string, options: DraftEmailOptions): Promise<{ draftId: string; message: Email }> {
    const gmail = await this.getClient(userId);

    const {
      to,
      cc,
      bcc,
      subject,
      body,
      isHtml = false,
      replyToMessageId,
      threadId,
    } = options;

    logger.info('Creating email draft', { userId, to, subject });

    const headers: string[] = [
      `To: ${to.join(', ')}`,
      `Subject: ${subject}`,
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
    ];

    if (cc?.length) {
      headers.push(`Cc: ${cc.join(', ')}`);
    }
    if (bcc?.length) {
      headers.push(`Bcc: ${bcc.join(', ')}`);
    }

    // Add threading headers if replying
    if (replyToMessageId) {
      const originalMessage = await gmail.users.messages.get({
        userId: 'me',
        id: replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });

      const originalHeaders = originalMessage.data.payload?.headers || [];
      const messageIdHeader = originalHeaders.find(h => h.name === 'Message-ID')?.value;
      const referencesHeader = originalHeaders.find(h => h.name === 'References')?.value;

      if (messageIdHeader) {
        headers.push(`In-Reply-To: ${messageIdHeader}`);
        const references = referencesHeader
          ? `${referencesHeader} ${messageIdHeader}`
          : messageIdHeader;
        headers.push(`References: ${references}`);
      }
    }

    const email = `${headers.join('\r\n')}\r\n\r\n${body}`;
    const encodedEmail = Buffer.from(email).toString('base64url');

    const response = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedEmail,
          threadId,
        },
      },
    });

    // Fetch the draft message details
    const draftMessage = await gmail.users.messages.get({
      userId: 'me',
      id: response.data.message?.id!,
      format: 'full',
    });

    return {
      draftId: response.data.id!,
      message: this.mapMessage(draftMessage.data, true),
    };
  }

  /**
   * List email labels
   */
  async listLabels(userId: string): Promise<EmailLabel[]> {
    const gmail = await this.getClient(userId);

    logger.info('Fetching email labels', { userId });

    const response = await gmail.users.labels.list({
      userId: 'me',
    });

    const labels = response.data.labels || [];

    return labels.map((label) => ({
      id: label.id || '',
      name: label.name || '',
      type: (label.type === 'system' ? 'system' : 'user') as 'system' | 'user',
      messagesTotal: label.messagesTotal || undefined,
      messagesUnread: label.messagesUnread || undefined,
    }));
  }

  /**
   * Modify email labels (mark as read/unread, star/unstar, archive, etc.)
   *
   * Uses Gmail's batchModify API for efficiency (up to 1000 emails per request).
   *
   * Common operations:
   * - Mark as read: removeLabelIds: ['UNREAD']
   * - Mark as unread: addLabelIds: ['UNREAD']
   * - Star: addLabelIds: ['STARRED']
   * - Unstar: removeLabelIds: ['STARRED']
   * - Archive: removeLabelIds: ['INBOX']
   * - Move to trash: addLabelIds: ['TRASH']
   */
  async modifyEmails(userId: string, options: ModifyEmailOptions): Promise<ModifyEmailResult> {
    const gmail = await this.getClient(userId);

    const { messageIds, addLabelIds, removeLabelIds } = options;

    logger.info('Modifying emails via batchModify', {
      userId,
      count: messageIds.length,
      addLabelIds,
      removeLabelIds,
    });

    const modified: string[] = [];
    const failed: Array<{ messageId: string; error: string }> = [];

    // Gmail batchModify supports up to 1000 IDs per request
    const batchSize = 1000;

    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(messageIds.length / batchSize);

      logger.info(`Processing batch ${batchNum}/${totalBatches} (${batch.length} emails)`, { userId });

      try {
        // Use batchModify for efficient bulk modification
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: batch,
            addLabelIds: addLabelIds || [],
            removeLabelIds: removeLabelIds || [],
          },
        });

        // batchModify succeeds atomically for all IDs in the batch
        modified.push(...batch);
        logger.info(`Batch ${batchNum} completed successfully`, {
          userId,
          modifiedCount: batch.length,
        });
      } catch (error) {
        // If batch fails, fall back to individual modifications to identify which failed
        logger.warn(`Batch ${batchNum} failed, falling back to individual modifications`, {
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        for (const messageId of batch) {
          try {
            await gmail.users.messages.modify({
              userId: 'me',
              id: messageId,
              requestBody: {
                addLabelIds: addLabelIds || [],
                removeLabelIds: removeLabelIds || [],
              },
            });
            modified.push(messageId);
          } catch (individualError) {
            const message = individualError instanceof Error ? individualError.message : 'Unknown error';
            failed.push({ messageId, error: message });
            logger.warn('Failed to modify email', { userId, messageId, error: message });
          }
        }
      }
    }

    logger.info('Emails modified', {
      userId,
      modifiedCount: modified.length,
      failedCount: failed.length,
    });

    return { modified, failed };
  }

  /**
   * Parse an email address string into EmailAddress
   */
  private parseEmailAddress(addressStr: string): EmailAddress {
    // Handle formats like: "Name <email@example.com>" or "email@example.com"
    const match = addressStr.match(/^(?:"?([^"<]+)"?\s*)?<?([^>]+)>?$/);
    if (match) {
      return {
        name: match[1]?.trim() || undefined,
        email: match[2]?.trim() || addressStr.trim(),
      };
    }
    return { email: addressStr.trim() };
  }

  /**
   * Map Gmail API message to our Email type
   */
  private mapMessage(message: gmail_v1.Schema$Message, includeBody = false): Email {
    const headers = message.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const labelIds = message.labelIds || [];

    // Parse body if requested
    let body: { text?: string; html?: string } | undefined;
    if (includeBody && message.payload) {
      body = this.extractBody(message.payload);
    }

    // Parse attachments
    const attachments = this.extractAttachments(message.payload);

    return {
      id: message.id || '',
      threadId: message.threadId || '',
      labelIds,
      snippet: message.snippet || '',
      subject: getHeader('Subject'),
      from: this.parseEmailAddress(getHeader('From')),
      to: getHeader('To').split(',').map(e => this.parseEmailAddress(e.trim())).filter(e => e.email),
      cc: getHeader('Cc')
        ? getHeader('Cc').split(',').map(e => this.parseEmailAddress(e.trim())).filter(e => e.email)
        : undefined,
      date: getHeader('Date'),
      body,
      attachments: attachments.length > 0 ? attachments : undefined,
      isUnread: labelIds.includes('UNREAD'),
      isStarred: labelIds.includes('STARRED'),
    };
  }

  /**
   * Extract body from message payload
   */
  private extractBody(payload: gmail_v1.Schema$MessagePart): { text?: string; html?: string } {
    const result: { text?: string; html?: string } = {};

    const extractFromPart = (part: gmail_v1.Schema$MessagePart) => {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        result.text = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        result.html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      }

      if (part.parts) {
        part.parts.forEach(extractFromPart);
      }
    };

    extractFromPart(payload);
    return result;
  }

  /**
   * Extract attachments from message payload
   */
  private extractAttachments(payload?: gmail_v1.Schema$MessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    const extractFromPart = (part: gmail_v1.Schema$MessagePart) => {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          id: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body.size || 0,
        });
      }

      if (part.parts) {
        part.parts.forEach(extractFromPart);
      }
    };

    if (payload) {
      extractFromPart(payload);
    }

    return attachments;
  }
}

// Singleton instance
let gmailService: GmailService | null = null;

export function getGmailService(): GmailService {
  if (!gmailService) {
    gmailService = new GmailService();
  }
  return gmailService;
}
