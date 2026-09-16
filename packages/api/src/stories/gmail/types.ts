/**
 * Gmail Types
 *
 * Type definitions for Gmail API interactions.
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface Email {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  date: string;
  body?: {
    text?: string;
    html?: string;
  };
  attachments?: EmailAttachment[];
  isUnread: boolean;
  isStarred: boolean;
  headers?: Record<string, string>;
}

export interface EmailThread {
  id: string;
  historyId: string;
  messages: Email[];
}

export interface EmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface ListEmailsOptions {
  maxResults?: number;
  query?: string; // Gmail search query (e.g., "from:john@example.com is:unread")
  labelIds?: string[]; // Filter by labels (e.g., ['INBOX', 'UNREAD'])
  pageToken?: string;
  includeSpamTrash?: boolean;
}

export interface GetEmailOptions {
  messageId: string;
  format?: 'minimal' | 'full' | 'raw' | 'metadata';
}

/**
 * A file to attach to an outgoing message. `path` must resolve inside the
 * shared media root (~/.ink/files) — see stories/gmail/attachments.ts.
 */
export interface AttachmentInput {
  path: string;
  filename?: string; // Defaults to the file's own basename
}

export interface SendEmailOptions {
  to: string[]; // Email addresses
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  replyToMessageId?: string; // For threading
  threadId?: string; // For threading
  attachments?: AttachmentInput[];
}

export interface DraftEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  replyToMessageId?: string;
  threadId?: string;
  attachments?: AttachmentInput[];
}

export interface ReplyToEmailOptions {
  messageId: string;
  body: string;
  isHtml?: boolean;
  replyAll?: boolean; // Reply to all recipients
  attachments?: AttachmentInput[];
}

export interface EmailSearchResult {
  emails: Email[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface ModifyEmailOptions {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface ModifyEmailResult {
  modified: string[];
  failed: Array<{ messageId: string; error: string }>;
}
