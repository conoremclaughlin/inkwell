/**
 * Gmail MCP Tool Handlers
 *
 * Exposes Gmail functionality via MCP tools.
 */

import { z } from 'zod';
import { getGmailService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';

// Shared user identifier schema
const userIdentifierBaseSchema = z.object({
  userId: z.string().uuid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional().describe('Platform name'),
  platformId: z.string().optional().describe('Platform-specific user ID or username'),
});

// Tool result type
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============================================================================
// Label Permissions (Whitelist)
// ============================================================================

/**
 * Labels that are allowed to be added via modify_emails.
 * This whitelist prevents destructive operations like moving to trash.
 *
 * To enable deletion later, add 'TRASH' to this list (with appropriate
 * permission checks from user/agent config).
 */
export const ALLOWED_ADD_LABELS: Set<string> = new Set([
  'STARRED',
  'IMPORTANT',
  'UNREAD',
  // Note: INBOX is allowed for "un-archiving" emails
  'INBOX',
  // User-created labels are allowed (checked separately)
]);

/**
 * Labels that are allowed to be removed via modify_emails.
 */
export const ALLOWED_REMOVE_LABELS: Set<string> = new Set([
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'INBOX', // Removing from INBOX = archiving
  'SPAM', // Allow moving out of spam
]);

/**
 * Labels that are NEVER allowed to be added (destructive operations).
 * These are explicitly blocked regardless of any other settings.
 */
export const BLOCKED_ADD_LABELS: Set<string> = new Set([
  'TRASH', // Deleting emails
  'SPAM', // Marking as spam
]);

/**
 * Check if a label operation is allowed.
 * User-created labels (not system labels) are generally allowed.
 *
 * @param label The label ID
 * @param operation 'add' or 'remove'
 * @returns { allowed: boolean, reason?: string }
 */
export function isLabelOperationAllowed(
  label: string,
  operation: 'add' | 'remove'
): { allowed: boolean; reason?: string } {
  // Check blocked list first (for add operations)
  if (operation === 'add' && BLOCKED_ADD_LABELS.has(label)) {
    return {
      allowed: false,
      reason: `Adding '${label}' label is not permitted. This operation could result in data loss.`,
    };
  }

  // Check allowlist
  const allowlist = operation === 'add' ? ALLOWED_ADD_LABELS : ALLOWED_REMOVE_LABELS;

  // System labels (all caps) must be in the allowlist
  const isSystemLabel = label === label.toUpperCase() && !label.startsWith('Label_');
  if (isSystemLabel && !allowlist.has(label)) {
    return {
      allowed: false,
      reason: `${operation === 'add' ? 'Adding' : 'Removing'} system label '${label}' is not permitted.`,
    };
  }

  // User-created labels are allowed
  return { allowed: true };
}

/**
 * Validate all label operations in a modify request.
 *
 * @returns null if all operations are valid, or an error message describing blocked operations
 */
export function validateLabelOperations(
  addLabelIds?: string[],
  removeLabelIds?: string[]
): string | null {
  const errors: string[] = [];

  for (const label of addLabelIds || []) {
    const result = isLabelOperationAllowed(label, 'add');
    if (!result.allowed) {
      errors.push(result.reason!);
    }
  }

  for (const label of removeLabelIds || []) {
    const result = isLabelOperationAllowed(label, 'remove');
    if (!result.allowed) {
      errors.push(result.reason!);
    }
  }

  return errors.length > 0 ? errors.join(' ') : null;
}

// ============================================================================
// Schemas
// ============================================================================

export const listEmailsSchema = userIdentifierBaseSchema.extend({
  maxResults: z
    .number()
    .optional()
    .default(10)
    .describe('Maximum number of emails to return (default: 10, max: 100)'),
  query: z
    .string()
    .optional()
    .describe('Gmail search query (e.g., "from:john@example.com is:unread", "subject:meeting")'),
  labelIds: z
    .array(z.string())
    .optional()
    .describe('Filter by label IDs (e.g., ["INBOX", "UNREAD"])'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

export const getEmailSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().describe('The email message ID to retrieve'),
  format: z
    .enum(['minimal', 'full', 'metadata'])
    .optional()
    .default('full')
    .describe('Level of detail to return (default: full)'),
});

export const sendEmailSchema = userIdentifierBaseSchema.extend({
  to: z.array(z.string().email()).describe('Recipient email addresses'),
  cc: z.array(z.string().email()).optional().describe('CC recipients'),
  bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe('Email body content'),
  isHtml: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether body is HTML (default: plain text)'),
});

export const replyToEmailSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().describe('The message ID to reply to'),
  body: z.string().describe('Reply body content'),
  isHtml: z.boolean().optional().default(false).describe('Whether body is HTML'),
  replyAll: z.boolean().optional().default(false).describe('Reply to all recipients'),
});

export const draftEmailSchema = userIdentifierBaseSchema.extend({
  to: z.array(z.string().email()).describe('Recipient email addresses'),
  cc: z.array(z.string().email()).optional().describe('CC recipients'),
  bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
  subject: z.string().describe('Email subject line'),
  body: z.string().describe('Email body content'),
  isHtml: z.boolean().optional().default(false).describe('Whether body is HTML'),
  replyToMessageId: z.string().optional().describe('Message ID if this is a reply draft'),
});

export const listLabelsSchema = userIdentifierBaseSchema.extend({});

export const modifyEmailsSchema = userIdentifierBaseSchema.extend({
  messageIds: z.array(z.string()).min(1).max(100).describe('Email message IDs to modify (max 100)'),
  addLabelIds: z
    .array(z.string())
    .optional()
    .describe('Label IDs to add (e.g., ["STARRED", "IMPORTANT"])'),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe('Label IDs to remove (e.g., ["UNREAD", "INBOX"])'),
});

export const downloadAttachmentSchema = userIdentifierBaseSchema.extend({
  messageId: z.string().describe('The email message ID containing the attachment'),
  attachmentId: z
    .string()
    .describe('The attachment ID (from the attachments array returned by get_email)'),
  filename: z.string().describe('Original filename of the attachment'),
});

// ============================================================================
// Handlers
// ============================================================================

/**
 * List emails with optional filters
 */
export async function handleListEmails(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = listEmailsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const result = await gmailService.listEmails(user.id, {
      maxResults: Math.min(params.maxResults ?? 10, 100),
      query: params.query,
      labelIds: params.labelIds,
      pageToken: params.pageToken,
    });

    logger.info('Listed emails', {
      userId: user.id,
      count: result.emails.length,
      query: params.query,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              query: {
                maxResults: params.maxResults,
                searchQuery: params.query,
                labelIds: params.labelIds,
              },
              emails: result.emails.map((e) => ({
                id: e.id,
                threadId: e.threadId,
                subject: e.subject,
                from: e.from,
                to: e.to,
                date: e.date,
                snippet: e.snippet,
                isUnread: e.isUnread,
                isStarred: e.isStarred,
                hasAttachments: !!e.attachments?.length,
              })),
              count: result.emails.length,
              nextPageToken: result.nextPageToken,
              resultSizeEstimate: result.resultSizeEstimate,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to list emails', { userId: user.id, error: message });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('No active google account')
                ? 'User needs to connect their Google account in the web dashboard'
                : message.includes('gmail')
                  ? 'User needs to re-authorize Google with Gmail permissions'
                  : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get a single email by ID
 */
export async function handleGetEmail(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getEmailSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const email = await gmailService.getEmail(user.id, {
      messageId: params.messageId,
      format: params.format,
    });

    logger.info('Retrieved email', {
      userId: user.id,
      messageId: params.messageId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              email,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get email', {
      userId: user.id,
      messageId: params.messageId,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Send a new email
 */
export async function handleSendEmail(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = sendEmailSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const email = await gmailService.sendEmail(user.id, {
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      body: params.body,
      isHtml: params.isHtml,
    });

    logger.info('Sent email', {
      userId: user.id,
      to: params.to,
      subject: params.subject,
      messageId: email.id,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: 'Email sent successfully',
              email: {
                id: email.id,
                threadId: email.threadId,
                to: email.to,
                subject: email.subject,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to send email', {
      userId: user.id,
      to: params.to,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('gmail.send')
                ? 'User needs to re-authorize Google with Gmail send permissions'
                : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Reply to an existing email
 */
export async function handleReplyToEmail(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = replyToEmailSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const email = await gmailService.replyToEmail(user.id, {
      messageId: params.messageId,
      body: params.body,
      isHtml: params.isHtml,
      replyAll: params.replyAll,
    });

    logger.info('Replied to email', {
      userId: user.id,
      originalMessageId: params.messageId,
      replyMessageId: email.id,
      replyAll: params.replyAll,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: 'Reply sent successfully',
              email: {
                id: email.id,
                threadId: email.threadId,
                to: email.to,
                subject: email.subject,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to reply to email', {
      userId: user.id,
      messageId: params.messageId,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Create a draft email
 */
export async function handleDraftEmail(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = draftEmailSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const { draftId, message } = await gmailService.createDraft(user.id, {
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      body: params.body,
      isHtml: params.isHtml,
      replyToMessageId: params.replyToMessageId,
    });

    logger.info('Created email draft', {
      userId: user.id,
      to: params.to,
      subject: params.subject,
      draftId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: 'Draft created successfully',
              draft: {
                draftId,
                messageId: message.id,
                threadId: message.threadId,
                to: message.to,
                subject: message.subject,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create draft', {
      userId: user.id,
      to: params.to,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * List email labels
 */
export async function handleListLabels(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = listLabelsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const labels = await gmailService.listLabels(user.id);

    logger.info('Listed email labels', {
      userId: user.id,
      count: labels.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              labels,
              count: labels.length,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to list labels', { userId: user.id, error: message });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Modify email labels (mark as read/unread, star/unstar, archive, etc.)
 *
 * Common operations:
 * - Mark as read: removeLabelIds: ['UNREAD']
 * - Mark as unread: addLabelIds: ['UNREAD']
 * - Star: addLabelIds: ['STARRED']
 * - Unstar: removeLabelIds: ['STARRED']
 * - Archive: removeLabelIds: ['INBOX']
 * - Move to trash: addLabelIds: ['TRASH']
 */
export async function handleModifyEmails(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = modifyEmailsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Validate at least one action
  if (!params.addLabelIds?.length && !params.removeLabelIds?.length) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: 'Must specify at least one of addLabelIds or removeLabelIds',
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Validate label operations against whitelist
  const labelValidationError = validateLabelOperations(params.addLabelIds, params.removeLabelIds);
  if (labelValidationError) {
    logger.warn('Blocked email modification due to label restrictions', {
      userId: user.id,
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
      error: labelValidationError,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: labelValidationError,
              hint: 'Only safe label operations are permitted. Allowed: mark read/unread, star/unstar, archive. Deletion (TRASH) is not permitted.',
              allowedAddLabels: Array.from(ALLOWED_ADD_LABELS),
              allowedRemoveLabels: Array.from(ALLOWED_REMOVE_LABELS),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const gmailService = getGmailService();

  try {
    const result = await gmailService.modifyEmails(user.id, {
      messageIds: params.messageIds,
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
    });

    logger.info('Modified emails', {
      userId: user.id,
      modifiedCount: result.modified.length,
      failedCount: result.failed.length,
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              message: `Modified ${result.modified.length} emails${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}`,
              modifiedCount: result.modified.length,
              failedCount: result.failed.length,
              modified: result.modified,
              failed: result.failed.length > 0 ? result.failed : undefined,
              operations: {
                addedLabels: params.addLabelIds,
                removedLabels: params.removeLabelIds,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to modify emails', {
      userId: user.id,
      messageIds: params.messageIds,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
              hint: message.includes('gmail.modify')
                ? 'User needs to re-authorize Google with Gmail modify permissions'
                : undefined,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Download an email attachment to disk
 */
export async function handleDownloadAttachment(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = downloadAttachmentSchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);

  const gmailService = getGmailService();

  try {
    const result = await gmailService.downloadAttachment(
      user.id,
      params.messageId,
      params.attachmentId,
      params.filename
    );

    logger.info('Downloaded email attachment', {
      userId: user.id,
      messageId: params.messageId,
      filename: result.filename,
      path: result.path,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              path: result.path,
              filename: result.filename,
              size: result.size,
              hint: 'Use this absolute path with send_response media or share with other agents',
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download attachment', {
      userId: user.id,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
      error: message,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}
