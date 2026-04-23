/**
 * Google Sheets Handlers Tests
 *
 * Unit tests covering schema validation, allowlist enforcement, and
 * the success/error response shape. The Google API itself is mocked —
 * end-to-end coverage against real Sheets is out of scope here (no
 * good way to do this without spending live tokens).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALLOWED_SHEETS_OPERATIONS,
  BLOCKED_SHEETS_OPERATIONS,
  isSheetsOperationAllowed,
  appendSheetRowsSchema,
  createSpreadsheetSchema,
  getSheetValuesSchema,
  updateSheetValuesSchema,
  handleAppendSheetRows,
  handleCreateSpreadsheet,
  handleGetSheetValues,
  handleUpdateSheetValues,
} from './handlers';

vi.mock('./service', () => ({
  getGoogleSheetsService: vi.fn(),
}));

vi.mock('../../services/user-resolver', () => ({
  resolveUserOrThrow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getGoogleSheetsService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';

const testUserId = '123e4567-e89b-12d3-a456-426614174000';
const mockUser = { id: testUserId, email: 'test@example.com' };
const mockDataComposer = {} as any;

describe('Sheets allowlist', () => {
  it('permits create_spreadsheet, append_rows, update_values', () => {
    expect(isSheetsOperationAllowed('create_spreadsheet').allowed).toBe(true);
    expect(isSheetsOperationAllowed('append_rows').allowed).toBe(true);
    expect(isSheetsOperationAllowed('update_values').allowed).toBe(true);
  });

  it('blocks destructive operations with a reason', () => {
    const clear = isSheetsOperationAllowed('clear_values');
    const dropSheet = isSheetsOperationAllowed('delete_sheet');
    const dropFile = isSheetsOperationAllowed('delete_spreadsheet');

    expect(clear.allowed).toBe(false);
    expect(clear.reason).toContain('data loss');
    expect(dropSheet.allowed).toBe(false);
    expect(dropFile.allowed).toBe(false);
  });

  it('does not include destructive ops in ALLOWED_SHEETS_OPERATIONS', () => {
    expect(ALLOWED_SHEETS_OPERATIONS.has('clear_values')).toBe(false);
    expect(ALLOWED_SHEETS_OPERATIONS.has('delete_sheet')).toBe(false);
    expect(ALLOWED_SHEETS_OPERATIONS.has('delete_spreadsheet')).toBe(false);
    expect(BLOCKED_SHEETS_OPERATIONS.has('clear_values')).toBe(true);
  });
});

describe('createSpreadsheetSchema', () => {
  it('accepts a valid title', () => {
    const result = createSpreadsheetSchema.safeParse({
      userId: testUserId,
      title: 'Tax 2026',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty title', () => {
    const result = createSpreadsheetSchema.safeParse({ userId: testUserId, title: '' });
    expect(result.success).toBe(false);
  });
});

describe('appendSheetRowsSchema', () => {
  it('accepts mixed cell types', () => {
    const result = appendSheetRowsSchema.safeParse({
      userId: testUserId,
      spreadsheetId: 'sheet-id-1',
      range: 'Sheet1!A1',
      values: [
        ['2026-01-15', 'Office Supplies', 42.5, true],
        ['2026-01-20', 'Software', 19.99, false, null],
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valueInputOption).toBe('USER_ENTERED');
    }
  });

  it('requires at least one row', () => {
    const result = appendSheetRowsSchema.safeParse({
      userId: testUserId,
      spreadsheetId: 'sheet-id-1',
      range: 'Sheet1!A1',
      values: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('getSheetValuesSchema', () => {
  it('defaults valueRenderOption to FORMATTED_VALUE', () => {
    const result = getSheetValuesSchema.safeParse({
      userId: testUserId,
      spreadsheetId: 'sheet-id-1',
      range: 'A1:B5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valueRenderOption).toBe('FORMATTED_VALUE');
    }
  });
});

describe('updateSheetValuesSchema', () => {
  it('accepts a 2D values array', () => {
    const result = updateSheetValuesSchema.safeParse({
      userId: testUserId,
      spreadsheetId: 'sheet-id-1',
      range: 'A1:B2',
      values: [
        ['x', 'y'],
        [1, 2],
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('handleCreateSpreadsheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns spreadsheet metadata on success', async () => {
    const created = {
      spreadsheetId: 'new-id',
      title: 'Tax 2026',
      url: 'https://docs.google.com/spreadsheets/d/new-id',
      sheets: [{ sheetId: 0, title: 'Sheet1', index: 0 }],
    };
    vi.mocked(getGoogleSheetsService).mockReturnValue({
      createSpreadsheet: vi.fn().mockResolvedValue(created),
    } as any);

    const result = await handleCreateSpreadsheet(
      { userId: testUserId, title: 'Tax 2026' },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.spreadsheet).toEqual(created);
  });

  it('hints when Google account not connected', async () => {
    vi.mocked(getGoogleSheetsService).mockReturnValue({
      createSpreadsheet: vi.fn().mockRejectedValue(new Error('No active google account for user')),
    } as any);

    const result = await handleCreateSpreadsheet(
      { userId: testUserId, title: 'Tax 2026' },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('connect their Google account');
  });
});

describe('handleAppendSheetRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('passes through values + valueInputOption to the service', async () => {
    const append = vi.fn().mockResolvedValue({
      spreadsheetId: 'sheet-id-1',
      updatedRange: 'Sheet1!A2:D2',
      updatedRows: 1,
      updatedCells: 4,
    });
    vi.mocked(getGoogleSheetsService).mockReturnValue({ appendRows: append } as any);

    const result = await handleAppendSheetRows(
      {
        userId: testUserId,
        spreadsheetId: 'sheet-id-1',
        range: 'Sheet1!A1',
        values: [['2026-01-15', 'Lunch', 12.5, 'Meals']],
      },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    expect(append).toHaveBeenCalledWith(testUserId, {
      spreadsheetId: 'sheet-id-1',
      range: 'Sheet1!A1',
      values: [['2026-01-15', 'Lunch', 12.5, 'Meals']],
      valueInputOption: 'USER_ENTERED',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.result.updatedRows).toBe(1);
  });

  it('hints when re-authorization is required', async () => {
    vi.mocked(getGoogleSheetsService).mockReturnValue({
      appendRows: vi
        .fn()
        .mockRejectedValue(new Error('insufficient authentication scopes for spreadsheets')),
    } as any);

    const result = await handleAppendSheetRows(
      {
        userId: testUserId,
        spreadsheetId: 'sheet-id-1',
        range: 'Sheet1!A1',
        values: [['x']],
      },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('re-authorize Google');
  });
});

describe('handleGetSheetValues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the rows from the service', async () => {
    vi.mocked(getGoogleSheetsService).mockReturnValue({
      getValues: vi.fn().mockResolvedValue({
        spreadsheetId: 'sheet-id-1',
        range: 'Sheet1!A1:B2',
        values: [
          ['header1', 'header2'],
          ['v1', 'v2'],
        ],
      }),
    } as any);

    const result = await handleGetSheetValues(
      { userId: testUserId, spreadsheetId: 'sheet-id-1', range: 'Sheet1!A1:B2' },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.result.values).toHaveLength(2);
  });
});

describe('handleUpdateSheetValues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('reports updated cell counts', async () => {
    vi.mocked(getGoogleSheetsService).mockReturnValue({
      updateValues: vi.fn().mockResolvedValue({
        spreadsheetId: 'sheet-id-1',
        updatedRange: 'Sheet1!A1:B2',
        updatedRows: 2,
        updatedCells: 4,
      }),
    } as any);

    const result = await handleUpdateSheetValues(
      {
        userId: testUserId,
        spreadsheetId: 'sheet-id-1',
        range: 'Sheet1!A1:B2',
        values: [
          ['x', 'y'],
          [1, 2],
        ],
      },
      mockDataComposer
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.result.updatedCells).toBe(4);
  });
});
