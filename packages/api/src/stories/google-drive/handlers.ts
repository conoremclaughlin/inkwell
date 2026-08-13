/**
 * Google Drive MCP Tool Handlers
 */

import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getGoogleDriveService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import type { DriveOperation } from './types';

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

export const ALLOWED_DRIVE_OPERATIONS: Set<DriveOperation> = new Set([
  'list_files',
  'get_file',
  'download_file',
  'create_folder',
  'move_file',
]);

export const BLOCKED_DRIVE_OPERATIONS: Set<DriveOperation> = new Set([
  'trash_file', // moves to trash — recoverable but still surprising
  'delete_file', // permanent delete
]);

export function isDriveOperationAllowed(operation: DriveOperation): {
  allowed: boolean;
  reason?: string;
} {
  if (BLOCKED_DRIVE_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Drive operation '${operation}' is not permitted. This operation could result in data loss.`,
    };
  }
  if (!ALLOWED_DRIVE_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Drive operation '${operation}' is not permitted. Only safe operations are allowed.`,
    };
  }
  return { allowed: true };
}

// ============================================================================
// Schemas
// ============================================================================

export const listDriveFilesSchema = userIdentifierBaseSchema.extend({
  query: z
    .string()
    .optional()
    .describe(
      'Drive query in Google syntax. Examples: "name contains \'Tax\'", "mimeType=\'application/vnd.google-apps.spreadsheet\'", "trashed = false"'
    ),
  pageSize: z.number().int().min(1).max(100).optional().default(25),
  pageToken: z.string().optional().describe('Token for fetching the next page'),
  orderBy: z.string().optional().describe('Sort field, e.g. "modifiedTime desc" or "name"'),
});

export const getDriveFileSchema = userIdentifierBaseSchema.extend({
  fileId: z.string().min(1).describe('Drive file ID'),
});

export const createDriveFolderSchema = userIdentifierBaseSchema.extend({
  name: z.string().min(1).describe('Folder name'),
  parentFolderId: z
    .string()
    .optional()
    .describe('Parent folder ID. Omit to create at the root of My Drive.'),
});

export const moveDriveFileSchema = userIdentifierBaseSchema.extend({
  fileId: z.string().min(1).describe('Drive file ID to move'),
  newParentFolderId: z.string().min(1).describe('Destination folder ID'),
});

export const downloadDriveFileSchema = userIdentifierBaseSchema.extend({
  fileId: z.string().min(1).describe('Drive file ID to download'),
  exportMimeType: z
    .string()
    .optional()
    .describe(
      'Override the export format for Google-native files (Docs/Sheets/Slides), which have no raw form. Defaults to plain text (Docs→text/plain, Sheets→text/csv). Supported: text/plain, text/html, text/markdown, application/pdf, application/epub+zip, application/rtf, .docx/.xlsx/.pptx. Ignored for binary files, which always download as-is.'
    ),
  targetFilename: z
    .string()
    .optional()
    .describe(
      'Filename to save as (extension appended automatically if missing). Defaults to the Drive file name.'
    ),
});

// ============================================================================
// Helpers
// ============================================================================

function googleErrorHint(message: string): string | undefined {
  if (message.includes('No active google account')) {
    return 'User needs to connect their Google account in the web dashboard';
  }
  if (message.includes('drive') || message.includes('insufficient')) {
    return 'User needs to re-authorize Google with Drive permissions';
  }
  if (message.includes('403') || message.toLowerCase().includes('forbidden')) {
    return 'You may not have access to this file. Confirm it is shared with the connected Google account.';
  }
  if (message.includes('404') || message.toLowerCase().includes('not found')) {
    return 'File not found — verify the fileId';
  }
  return undefined;
}

function operationBlockedResult(operation: DriveOperation, reason: string): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: false,
            error: reason,
            operation,
            allowedOperations: Array.from(ALLOWED_DRIVE_OPERATIONS),
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

export async function handleListDriveFiles(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = listDriveFilesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const result = await getGoogleDriveService().listFiles(user.id, {
      query: params.query,
      pageSize: params.pageSize,
      pageToken: params.pageToken,
      orderBy: params.orderBy,
    });

    logger.info('Listed Drive files', {
      userId: user.id,
      count: result.files.length,
      hasNextPage: !!result.nextPageToken,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              files: result.files,
              count: result.files.length,
              nextPageToken: result.nextPageToken,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to list Drive files', { userId: user.id, error: message });
    return errorResult(message);
  }
}

export async function handleGetDriveFile(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getDriveFileSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const file = await getGoogleDriveService().getFile(user.id, { fileId: params.fileId });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, user: { id: user.id, resolvedBy }, file }, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get Drive file', {
      userId: user.id,
      fileId: params.fileId,
      error: message,
    });
    return errorResult(message);
  }
}

export async function handleCreateDriveFolder(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isDriveOperationAllowed('create_folder');
  if (!operationCheck.allowed)
    return operationBlockedResult('create_folder', operationCheck.reason!);

  const params = createDriveFolderSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const folder = await getGoogleDriveService().createFolder(user.id, {
      name: params.name,
      parentFolderId: params.parentFolderId,
    });

    logger.info('Created Drive folder', {
      userId: user.id,
      folderId: folder.id,
      name: folder.name,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, folder },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create Drive folder', { userId: user.id, error: message });
    return errorResult(message);
  }
}

export async function handleMoveDriveFile(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isDriveOperationAllowed('move_file');
  if (!operationCheck.allowed) return operationBlockedResult('move_file', operationCheck.reason!);

  const params = moveDriveFileSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  try {
    const file = await getGoogleDriveService().moveFile(user.id, {
      fileId: params.fileId,
      newParentFolderId: params.newParentFolderId,
    });

    logger.info('Moved Drive file', {
      userId: user.id,
      fileId: params.fileId,
      newParentFolderId: params.newParentFolderId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, user: { id: user.id, resolvedBy }, file }, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to move Drive file', {
      userId: user.id,
      fileId: params.fileId,
      error: message,
    });
    return errorResult(message);
  }
}

function driveDownloadDir(): string {
  return join(homedir(), '.ink', 'files', 'drive');
}

function sanitizeFilename(name: string): string {
  const cleaned =
    name
      .replace(/[/\\:*?"<>|]/g, '_')
      .trim()
      .slice(0, 180) || 'file';

  // Reject dot-components that would cause path traversal
  if (cleaned === '.' || cleaned === '..') return 'file';

  return cleaned;
}

export async function handleDownloadDriveFile(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = downloadDriveFileSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const permission = isDriveOperationAllowed('download_file');
  if (!permission.allowed) {
    return operationBlockedResult('download_file', permission.reason!);
  }

  try {
    const result = await getGoogleDriveService().downloadFile(user.id, {
      fileId: params.fileId,
      exportMimeType: params.exportMimeType,
    });

    const baseName = sanitizeFilename(params.targetFilename || result.file.name);
    const filename = baseName.toLowerCase().endsWith(result.extension.toLowerCase())
      ? baseName
      : `${baseName}${result.extension}`;
    const dir = driveDownloadDir();
    await mkdir(dir, { recursive: true });
    const savedPath = join(dir, filename);

    // Defense-in-depth: ensure resolved path stays under the download directory
    const resolvedPath = resolve(savedPath);
    const resolvedDir = resolve(dir);
    if (!resolvedPath.startsWith(resolvedDir + '/') && resolvedPath !== resolvedDir) {
      return errorResult(
        `Filename "${filename}" resolves outside the download directory — rejecting for safety`
      );
    }

    await writeFile(savedPath, result.content);

    logger.info('Downloaded Drive file', {
      userId: user.id,
      fileId: params.fileId,
      savedPath,
      bytes: result.content.length,
      exported: result.exported,
      effectiveMimeType: result.effectiveMimeType,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              file: result.file,
              savedPath,
              bytes: result.content.length,
              mimeType: result.effectiveMimeType,
              exported: result.exported,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download Drive file', {
      userId: user.id,
      fileId: params.fileId,
      error: message,
    });
    return errorResult(message);
  }
}
