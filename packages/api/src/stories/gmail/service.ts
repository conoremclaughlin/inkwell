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
    const startTime = Date.now();
    logger.debug('[Gmail:getClient] Fetching OAuth token', { userId });

    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    logger.debug('[Gmail:getClient] Got OAuth token', {
      userId,
      tokenLength: accessToken?.length,
      durationMs: Date.now() - startTime,
    });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.gmail({ version: 'v1', auth });
  }

  /**
   * List emails with optional filters
   */
  async listEmails(userId: string, options: ListEmailsOptions = {}): Promise<EmailSearchResult> {
    const gmail = await this.getClient(userId);

    const { maxResults = 10, query, labelIds, pageToken, includeSpamTrash = false } = options;

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

    const { to, cc, bcc, subject, body, isHtml = false, replyToMessageId, threadId } = options;

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
      const messageIdHeader = originalHeaders.find((h) => h.name === 'Message-ID')?.value;
      const referencesHeader = originalHeaders.find((h) => h.name === 'References')?.value;

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
    const getHeader = (name: string) => originalHeaders.find((h) => h.name === name)?.value;

    const originalFrom = getHeader('From') || '';
    const originalTo = getHeader('To') || '';
    const originalCc = getHeader('Cc');
    const originalSubject = getHeader('Subject') || '';

    // Build recipient list
    const to = [this.parseEmailAddress(originalFrom).email];
    let cc: string[] = [];

    if (replyAll) {
      // Add original To and Cc recipients (excluding self)
      const toAddresses = originalTo.split(',').map((e) => this.parseEmailAddress(e.trim()).email);
      const ccAddresses = originalCc
        ? originalCc.split(',').map((e) => this.parseEmailAddress(e.trim()).email)
        : [];

      // TODO: Filter out the user's own email
      cc = [...toAddresses, ...ccAddresses].filter((e) => e !== to[0]);
    }

    // Build subject (add Re: if not already present)
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

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
  async createDraft(
    userId: string,
    options: DraftEmailOptions
  ): Promise<{ draftId: string; message: Email }> {
    const gmail = await this.getClient(userId);

    const { to, cc, bcc, subject, body, isHtml = false, replyToMessageId, threadId } = options;

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
      const messageIdHeader = originalHeaders.find((h) => h.name === 'Message-ID')?.value;
      const referencesHeader = originalHeaders.find((h) => h.name === 'References')?.value;

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
    const startTime = Date.now();
    logger.info('[Gmail:modifyEmails] Starting', {
      userId,
      count: options.messageIds.length,
      addLabelIds: options.addLabelIds,
      removeLabelIds: options.removeLabelIds,
    });

    const clientStartTime = Date.now();
    const gmail = await this.getClient(userId);
    logger.debug('[Gmail:modifyEmails] Got authenticated client', {
      userId,
      durationMs: Date.now() - clientStartTime,
    });

    const { messageIds, addLabelIds, removeLabelIds } = options;

    const modified: string[] = [];
    const failed: Array<{ messageId: string; error: string }> = [];

    // Gmail batchModify supports up to 1000 IDs per request
    const batchSize = 1000;
    const totalBatches = Math.ceil(messageIds.length / batchSize);

    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      logger.info(`[Gmail:modifyEmails] Starting batch ${batchNum}/${totalBatches}`, {
        userId,
        batchSize: batch.length,
        firstMessageId: batch[0],
        lastMessageId: batch[batch.length - 1],
      });

      const batchStartTime = Date.now();

      try {
        // Use batchModify for efficient bulk modification
        logger.debug('[Gmail:modifyEmails] Calling Gmail API batchModify...', { userId, batchNum });

        const response = await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: batch,
            addLabelIds: addLabelIds || [],
            removeLabelIds: removeLabelIds || [],
          },
        });

        const batchDuration = Date.now() - batchStartTime;

        // batchModify succeeds atomically for all IDs in the batch
        modified.push(...batch);
        logger.info(`[Gmail:modifyEmails] Batch ${batchNum} completed`, {
          userId,
          modifiedCount: batch.length,
          durationMs: batchDuration,
          responseStatus: response.status,
          responseStatusText: response.statusText,
        });
      } catch (error) {
        const batchDuration = Date.now() - batchStartTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorDetails =
          error instanceof Error
            ? {
                name: error.name,
                stack: error.stack?.split('\n').slice(0, 3).join(' | '),
              }
            : {};

        // If batch fails, fall back to individual modifications to identify which failed
        logger.warn(`[Gmail:modifyEmails] Batch ${batchNum} failed after ${batchDuration}ms`, {
          userId,
          error: errorMessage,
          ...errorDetails,
        });

        logger.info(
          `[Gmail:modifyEmails] Falling back to individual modifications for ${batch.length} emails`,
          { userId }
        );

        let individualSuccess = 0;
        let individualFailed = 0;

        for (let j = 0; j < batch.length; j++) {
          const messageId = batch[j];
          const individualStartTime = Date.now();

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
            individualSuccess++;

            if ((j + 1) % 10 === 0) {
              logger.debug(`[Gmail:modifyEmails] Individual progress: ${j + 1}/${batch.length}`, {
                userId,
                successCount: individualSuccess,
                failedCount: individualFailed,
              });
            }
          } catch (individualError) {
            const message =
              individualError instanceof Error ? individualError.message : 'Unknown error';
            failed.push({ messageId, error: message });
            individualFailed++;
            logger.warn('[Gmail:modifyEmails] Individual modify failed', {
              userId,
              messageId,
              error: message,
              durationMs: Date.now() - individualStartTime,
            });
          }
        }

        logger.info(`[Gmail:modifyEmails] Individual fallback completed`, {
          userId,
          successCount: individualSuccess,
          failedCount: individualFailed,
        });
      }
    }

    const totalDuration = Date.now() - startTime;
    logger.info('[Gmail:modifyEmails] Completed', {
      userId,
      modifiedCount: modified.length,
      failedCount: failed.length,
      totalDurationMs: totalDuration,
      avgMsPerEmail: modified.length > 0 ? Math.round(totalDuration / modified.length) : 0,
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
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

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
      to: getHeader('To')
        .split(',')
        .map((e) => this.parseEmailAddress(e.trim()))
        .filter((e) => e.email),
      cc: getHeader('Cc')
        ? getHeader('Cc')
            .split(',')
            .map((e) => this.parseEmailAddress(e.trim()))
            .filter((e) => e.email)
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
   * Download an email attachment to ~/.ink/files/gmail/
   */
  async downloadAttachment(
    userId: string,
    messageId: string,
    attachmentId: string,
    filename: string
  ): Promise<{ path: string; filename: string; size: number }> {
    const gmail = await this.getClient(userId);

    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    if (!response.data.data) {
      throw new Error('Attachment data is empty');
    }

    const buffer = Buffer.from(response.data.data, 'base64url');

    const { join } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const { homedir } = await import('os');

    const dir = join(homedir(), '.ink', 'files', 'gmail');
    await mkdir(dir, { recursive: true });

    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destFilename = `${Date.now()}_${sanitized}`;
    const filePath = join(dir, destFilename);

    await writeFile(filePath, buffer);

    logger.info('Downloaded Gmail attachment', {
      userId,
      messageId,
      filename: sanitized,
      filePath,
      size: buffer.byteLength,
    });

    return { path: filePath, filename: sanitized, size: buffer.byteLength };
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
