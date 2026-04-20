/**
 * Google Docs MCP Tool Handlers
 */

import { z } from 'zod';
import { getGoogleDocsService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import type { DocsOperation } from './types';

const userIdentifierBaseSchema = z.object({
  userId: z.string().uuid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional().describe('Platform name'),
  platformId: z.string().optional().describe('Platform-specific user ID or username'),
});

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============================================================================
// Operation Permissions
// ============================================================================

export const ALLOWED_DOCS_OPERATIONS: Set<DocsOperation> = new Set([
  'create_document',
  'append_text',
  'replace_text',
]);

export const BLOCKED_DOCS_OPERATIONS: Set<DocsOperation> = new Set([
  'delete_content_range', // wholesale-deletion ranges are destructive
  'delete_document', // dropping the file is destructive — use Drive trash if needed
]);

export function isDocsOperationAllowed(operation: DocsOperation): {
  allowed: boolean;
  reason?: string;
} {
  if (BLOCKED_DOCS_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Docs operation '${operation}' is not permitted. This operation could result in data loss.`,
    };
  }
  if (!ALLOWED_DOCS_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Docs operation '${operation}' is not permitted. Only safe operations are allowed.`,
    };
  }
  return { allowed: true };
}

// ============================================================================
// Schemas
// ============================================================================

export const createDocumentSchema = userIdentifierBaseSchema.extend({
  title: z.string().min(1).describe('Title of the new document'),
  initialContent: z.string().optional().describe('Optional initial body text'),
});

export const getDocumentSchema = userIdentifierBaseSchema.extend({
  documentId: z.string().min(1).describe('Document ID (from the URL)'),
});

export const appendTextSchema = userIdentifierBaseSchema.extend({
  documentId: z.string().min(1).describe('Document ID (from the URL)'),
  text: z.string().min(1).describe('Text to append at the end of the document'),
  separateWithNewline: z
    .boolean()
    .optional()
    .default(true)
    .describe('Insert a leading newline so the appended text starts on a new line'),
});

export const replaceTextSchema = userIdentifierBaseSchema.extend({
  documentId: z.string().min(1).describe('Document ID (from the URL)'),
  find: z.string().min(1).describe('Text to find'),
  replaceWith: z.string().describe('Text to substitute (may be empty)'),
  matchCase: z.boolean().optional().default(true).describe('Case-sensitive matching'),
});

// ============================================================================
// Helpers
// ============================================================================

function googleErrorHint(message: string): string | undefined {
  if (message.includes('No active google account')) {
    return 'User needs to connect their Google account in the web dashboard';
  }
  if (message.includes('documents') || message.includes('insufficient')) {
    return 'User needs to re-authorize Google with Docs permissions';
  }
  if (message.includes('403') || message.toLowerCase().includes('forbidden')) {
    return 'You may not have access to this document. Confirm the document is shared with the connected Google account.';
  }
  if (message.includes('404') || message.toLowerCase().includes('not found')) {
    return 'Document not found — verify the documentId';
  }
  return undefined;
}

function operationBlockedResult(operation: DocsOperation, reason: string): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: false,
            error: reason,
            operation,
            allowedOperations: Array.from(ALLOWED_DOCS_OPERATIONS),
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { success: false, error: message, hint: googleErrorHint(message) },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

// ============================================================================
// Handlers
// ============================================================================

export async function handleCreateDocument(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isDocsOperationAllowed('create_document');
  if (!operationCheck.allowed)
    return operationBlockedResult('create_document', operationCheck.reason!);

  const params = createDocumentSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const doc = await getGoogleDocsService().createDocument(user.id, {
      title: params.title,
      initialContent: params.initialContent,
    });

    logger.info('Created Google Doc', {
      userId: user.id,
      documentId: doc.documentId,
      title: doc.title,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, document: doc },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create document', { userId: user.id, error: message });
    return errorResult(message);
  }
}

export async function handleGetDocument(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getDocumentSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const doc = await getGoogleDocsService().getDocument(user.id, {
      documentId: params.documentId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, document: doc },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get document', {
      userId: user.id,
      documentId: params.documentId,
      error: message,
    });
    return errorResult(message);
  }
}

export async function handleAppendText(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isDocsOperationAllowed('append_text');
  if (!operationCheck.allowed) return operationBlockedResult('append_text', operationCheck.reason!);

  const params = appendTextSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const doc = await getGoogleDocsService().appendText(user.id, {
      documentId: params.documentId,
      text: params.text,
      separateWithNewline: params.separateWithNewline,
    });

    logger.info('Appended text to Google Doc', {
      userId: user.id,
      documentId: params.documentId,
      length: params.text.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, document: doc },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to append text', {
      userId: user.id,
      documentId: params.documentId,
      error: message,
    });
    return errorResult(message);
  }
}

export async function handleReplaceText(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isDocsOperationAllowed('replace_text');
  if (!operationCheck.allowed)
    return operationBlockedResult('replace_text', operationCheck.reason!);

  const params = replaceTextSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const result = await getGoogleDocsService().replaceText(user.id, {
      documentId: params.documentId,
      find: params.find,
      replaceWith: params.replaceWith,
      matchCase: params.matchCase,
    });

    logger.info('Replaced text in Google Doc', {
      userId: user.id,
      documentId: params.documentId,
      occurrencesChanged: result.occurrencesChanged,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, result },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to replace text', {
      userId: user.id,
      documentId: params.documentId,
      error: message,
    });
    return errorResult(message);
  }
}
