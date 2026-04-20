/**
 * Google Sheets MCP Tool Handlers
 *
 * Exposes Google Sheets functionality via MCP tools. Mirrors the
 * google-calendar handler shape: shared identifier schema, allowlist,
 * consistent JSON response envelope.
 */

import { z } from 'zod';
import { getGoogleSheetsService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import type { SheetsOperation } from './types';

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

export const ALLOWED_SHEETS_OPERATIONS: Set<SheetsOperation> = new Set([
  'create_spreadsheet',
  'append_rows',
  'update_values',
]);

export const BLOCKED_SHEETS_OPERATIONS: Set<SheetsOperation> = new Set([
  'clear_values', // bulk-clearing existing data is destructive
  'delete_sheet', // dropping a tab is destructive
  'delete_spreadsheet', // dropping the file is destructive
]);

export function isSheetsOperationAllowed(operation: SheetsOperation): {
  allowed: boolean;
  reason?: string;
} {
  if (BLOCKED_SHEETS_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Sheets operation '${operation}' is not permitted. This operation could result in data loss.`,
    };
  }
  if (!ALLOWED_SHEETS_OPERATIONS.has(operation)) {
    return {
      allowed: false,
      reason: `Sheets operation '${operation}' is not permitted. Only safe operations are allowed.`,
    };
  }
  return { allowed: true };
}

// ============================================================================
// Schemas
// ============================================================================

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowSchema = z.array(cellValueSchema);

export const createSpreadsheetSchema = userIdentifierBaseSchema.extend({
  title: z.string().min(1).describe('Title of the new spreadsheet'),
  initialSheetTitle: z
    .string()
    .optional()
    .describe('Optional name for the first tab (defaults to "Sheet1")'),
});

export const appendSheetRowsSchema = userIdentifierBaseSchema.extend({
  spreadsheetId: z.string().min(1).describe('Spreadsheet ID (from the URL)'),
  range: z.string().min(1).describe('A1 notation range, e.g. "Sheet1!A1" or "Sheet1!A:Z"'),
  values: z.array(rowSchema).min(1).describe('2D array of rows. Each inner array is one row.'),
  valueInputOption: z
    .enum(['USER_ENTERED', 'RAW'])
    .optional()
    .default('USER_ENTERED')
    .describe(
      '"USER_ENTERED" parses values like the Sheets UI (formulas, dates). "RAW" inserts as-is.'
    ),
});

export const getSheetValuesSchema = userIdentifierBaseSchema.extend({
  spreadsheetId: z.string().min(1).describe('Spreadsheet ID (from the URL)'),
  range: z.string().min(1).describe('A1 notation range, e.g. "Sheet1!A1:C10" or "Sheet1"'),
  valueRenderOption: z
    .enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
    .optional()
    .default('FORMATTED_VALUE')
    .describe('How to render cell values'),
});

export const updateSheetValuesSchema = userIdentifierBaseSchema.extend({
  spreadsheetId: z.string().min(1).describe('Spreadsheet ID (from the URL)'),
  range: z.string().min(1).describe('A1 notation range to overwrite'),
  values: z.array(rowSchema).min(1).describe('2D array of rows. Each inner array is one row.'),
  valueInputOption: z
    .enum(['USER_ENTERED', 'RAW'])
    .optional()
    .default('USER_ENTERED')
    .describe('How to interpret incoming values'),
});

export const getSpreadsheetSchema = userIdentifierBaseSchema.extend({
  spreadsheetId: z.string().min(1).describe('Spreadsheet ID (from the URL)'),
});

// ============================================================================
// Helpers
// ============================================================================

function googleErrorHint(message: string): string | undefined {
  if (message.includes('No active google account')) {
    return 'User needs to connect their Google account in the web dashboard';
  }
  if (message.includes('spreadsheets') || message.includes('insufficient')) {
    return 'User needs to re-authorize Google with Sheets permissions';
  }
  if (message.includes('403') || message.toLowerCase().includes('forbidden')) {
    return 'You may not have access to this spreadsheet. Confirm the spreadsheet is shared with the connected Google account.';
  }
  return undefined;
}

function operationBlockedResult(operation: SheetsOperation, reason: string): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: false,
            error: reason,
            operation,
            allowedOperations: Array.from(ALLOWED_SHEETS_OPERATIONS),
          },
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

export async function handleCreateSpreadsheet(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isSheetsOperationAllowed('create_spreadsheet');
  if (!operationCheck.allowed) {
    return operationBlockedResult('create_spreadsheet', operationCheck.reason!);
  }

  const params = createSpreadsheetSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sheetsService = getGoogleSheetsService();

  try {
    const spreadsheet = await sheetsService.createSpreadsheet(user.id, {
      title: params.title,
      initialSheetTitle: params.initialSheetTitle,
    });

    logger.info('Created spreadsheet', {
      userId: user.id,
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.title,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              spreadsheet,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to create spreadsheet', { userId: user.id, error: message });

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
}

export async function handleAppendSheetRows(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isSheetsOperationAllowed('append_rows');
  if (!operationCheck.allowed) {
    return operationBlockedResult('append_rows', operationCheck.reason!);
  }

  const params = appendSheetRowsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sheetsService = getGoogleSheetsService();

  try {
    const result = await sheetsService.appendRows(user.id, {
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      values: params.values,
      valueInputOption: params.valueInputOption,
    });

    logger.info('Appended rows to spreadsheet', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      updatedRange: result.updatedRange,
      updatedRows: result.updatedRows,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              result,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to append rows', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      error: message,
    });

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
}

export async function handleGetSheetValues(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getSheetValuesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sheetsService = getGoogleSheetsService();

  try {
    const result = await sheetsService.getValues(user.id, {
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      valueRenderOption: params.valueRenderOption,
    });

    logger.info('Read spreadsheet values', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      rowCount: result.values.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              result,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to read spreadsheet values', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      error: message,
    });

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
}

export async function handleUpdateSheetValues(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const operationCheck = isSheetsOperationAllowed('update_values');
  if (!operationCheck.allowed) {
    return operationBlockedResult('update_values', operationCheck.reason!);
  }

  const params = updateSheetValuesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sheetsService = getGoogleSheetsService();

  try {
    const result = await sheetsService.updateValues(user.id, {
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      values: params.values,
      valueInputOption: params.valueInputOption,
    });

    logger.info('Updated spreadsheet values', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      updatedRange: result.updatedRange,
      updatedCells: result.updatedCells,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              result,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to update spreadsheet values', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      error: message,
    });

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
}

export async function handleGetSpreadsheet(
  args: unknown,
  dataComposer: DataComposer
): Promise<ToolResult> {
  const params = getSpreadsheetSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sheetsService = getGoogleSheetsService();

  try {
    const spreadsheet = await sheetsService.getSpreadsheet(user.id, params.spreadsheetId);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: { id: user.id, resolvedBy },
              spreadsheet,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to get spreadsheet', {
      userId: user.id,
      spreadsheetId: params.spreadsheetId,
      error: message,
    });

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
}
