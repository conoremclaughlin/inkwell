/**
 * Gmail Service
 *
 * Handles Gmail API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, gmail_v1 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import { resolveOutboundAttachments } from './attachments';
import {
  buildRawMessage,
  headerLine,
  isValidAddress,
  parseAddress,
  parseAddressList,
  type OutboundAttachment,
} from './mime';
import type {
  AttachmentInput,
  Email,
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

  /** Per-user Gmail address, memoized for replyAll self-exclusion. */
  private ownAddressCache = new Map<string, string | undefined>();

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
   * Validate an outbound recipient list, rejecting anything that is not a
   * usable address.
   *
   * Callers reach this with addresses from two very different places:
   * schema-validated tool arguments, and addresses parsed out of a
   * received message (replyAll). Only the first is trustworthy, so the
   * check happens here where both converge — that is the invariant the
   * "Invalid Cc header" failure slipped past.
   */
  private validateRecipients(field: 'To' | 'Cc' | 'Bcc', addresses: string[]): string[] {
    const invalid = addresses.filter((a) => !isValidAddress(a));
    if (invalid.length > 0) {
      throw new Error(`Invalid ${field} address(es): ${invalid.join(', ')}`);
    }
    return addresses.map((a) => a.trim());
  }

  /**
   * Build the shared header block for an outgoing message.
   *
   * sendEmail and createDraft previously carried two copies of this; they
   * now share one so threading and sanitization cannot drift apart.
   */
  private async buildOutboundHeaders(
    gmail: gmail_v1.Gmail,
    options: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      replyToMessageId?: string;
    }
  ): Promise<string[]> {
    const { to, cc, bcc, subject, replyToMessageId } = options;

    const headers: string[] = [`To: ${this.validateRecipients('To', to).join(', ')}`];
    if (cc?.length) {
      headers.push(`Cc: ${this.validateRecipients('Cc', cc).join(', ')}`);
    }
    if (bcc?.length) {
      headers.push(`Bcc: ${this.validateRecipients('Bcc', bcc).join(', ')}`);
    }
    // headerLine strips CR/LF and RFC 2047-encodes: a Subject is free text
    // and on replies it is derived from a subject an untrusted sender chose.
    headers.push(headerLine('Subject', subject));

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
        const messageId = messageIdHeader.replace(/[\r\n]+/g, ' ').trim();
        headers.push(`In-Reply-To: ${messageId}`);
        const references = referencesHeader
          ? `${referencesHeader.replace(/[\r\n]+/g, ' ').trim()} ${messageId}`
          : messageId;
        headers.push(`References: ${references}`);
      }
    }

    return headers;
  }

  /** Read and verify attachment files before any message is assembled. */
  private async prepareAttachments(attachments?: AttachmentInput[]): Promise<OutboundAttachment[]> {
    if (!attachments?.length) return [];
    return resolveOutboundAttachments(attachments);
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
      attachments,
    } = options;

    logger.info('Sending email', {
      userId,
      to,
      subject,
      attachmentCount: attachments?.length ?? 0,
    });

    // Resolve attachments first: a rejected file must abort before anything
    // is sent, not leave a message already on its way without them.
    const resolvedAttachments = await this.prepareAttachments(attachments);

    const headers = await this.buildOutboundHeaders(gmail, {
      to,
      cc,
      bcc,
      subject,
      replyToMessageId,
    });

    const encodedEmail = buildRawMessage({
      headers,
      body,
      isHtml,
      attachments: resolvedAttachments,
    });

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

    const { messageId, body, isHtml = false, replyAll = false, attachments } = options;

    logger.info('Replying to email', { userId, messageId, replyAll });

    // Get the original message
    const originalMessage = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Message-ID', 'References'],
    });

    const originalHeaders = originalMessage.data.payload?.headers || [];
    const getHeader = (name: string) =>
      originalHeaders.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const originalFrom = getHeader('From');
    const originalReplyTo = getHeader('Reply-To');
    const originalSubject = getHeader('Subject');

    // Reply-To wins over From when the sender set one (RFC 5322 §3.6.2).
    //
    // Both fields are address-LISTS, not single mailboxes. `a@x.com,
    // b@x.com` parsed as one mailbox yields a comma-bearing string that
    // fails validation and kills the reply outright; `A <a@x>, B <b@x>`
    // silently keeps only the last one and drops an intended recipient.
    const replyToSource = originalReplyTo || originalFrom;
    const to = parseAddressList(replyToSource)
      .map((address) => address.email.trim())
      .filter((email) => isValidAddress(email))
      .filter(
        (email, index, all) =>
          all.findIndex((e) => e.toLowerCase() === email.toLowerCase()) === index
      );

    if (to.length === 0) {
      throw new Error(
        `Cannot reply: the original message has no usable sender address (Reply-To: "${originalReplyTo}", From: "${originalFrom}").`
      );
    }

    let cc: string[] = [];

    if (replyAll) {
      const self = await this.getOwnAddress(userId);

      // Everyone who saw the original, minus every address already in To and
      // minus the user themselves — replying should not Cc the sender back to
      // themselves.
      const seen = new Set([
        ...to.map((email) => email.toLowerCase()),
        ...(self ? [self.toLowerCase()] : []),
      ]);

      cc = [...parseAddressList(getHeader('To')), ...parseAddressList(getHeader('Cc'))]
        .map((a) => a.email.trim())
        // Drop anything unroutable rather than letting it reach the header.
        // Real inboxes carry group syntax, undisclosed-recipients, and
        // mailer noise that is not an address.
        .filter((email) => isValidAddress(email))
        .filter((email) => {
          const key = email.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }

    // Build subject (add Re: if not already present)
    const subject = /^re:/i.test(originalSubject.trim())
      ? originalSubject
      : `Re: ${originalSubject}`;

    return this.sendEmail(userId, {
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      body,
      isHtml,
      attachments,
      replyToMessageId: messageId,
      threadId: originalMessage.data.threadId || undefined,
    });
  }

  /**
   * The authenticated user's own address, used to keep replyAll from
   * Cc-ing them on their own reply. Best-effort: a profile lookup failure
   * degrades to a slightly noisy Cc, never a failed send.
   */
  private async getOwnAddress(userId: string): Promise<string | undefined> {
    if (this.ownAddressCache.has(userId)) return this.ownAddressCache.get(userId);
    try {
      const gmail = await this.getClient(userId);
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const address = profile.data.emailAddress || undefined;
      this.ownAddressCache.set(userId, address);
      return address;
    } catch (error) {
      logger.warn('[Gmail] could not resolve own address for replyAll', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Create a draft email
   */
  async createDraft(
    userId: string,
    options: DraftEmailOptions
  ): Promise<{ draftId: string; message: Email }> {
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
      attachments,
    } = options;

    logger.info('Creating email draft', {
      userId,
      to,
      subject,
      attachmentCount: attachments?.length ?? 0,
    });

    const resolvedAttachments = await this.prepareAttachments(attachments);

    const headers = await this.buildOutboundHeaders(gmail, {
      to,
      cc,
      bcc,
      subject,
      replyToMessageId,
    });

    const encodedEmail = buildRawMessage({
      headers,
      body,
      isHtml,
      attachments: resolvedAttachments,
    });

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
      from: parseAddress(getHeader('From')),
      to: parseAddressList(getHeader('To')),
      cc: getHeader('Cc') ? parseAddressList(getHeader('Cc')) : undefined,
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
