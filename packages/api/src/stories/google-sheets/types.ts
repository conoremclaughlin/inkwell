/**
 * Google Sheets Types
 *
 * Type definitions for Sheets API interactions.
 */

export interface SpreadsheetSummary {
  spreadsheetId: string;
  title: string;
  url: string;
  sheets: SheetSummary[];
}

export interface SheetSummary {
  sheetId: number;
  title: string;
  index: number;
  gridProperties?: {
    rowCount?: number;
    columnCount?: number;
  };
}

export interface CreateSpreadsheetOptions {
  title: string;
  /**
   * Optional name for the first sheet/tab. Defaults to "Sheet1" (Google's default).
   */
  initialSheetTitle?: string;
}

export interface AppendRowsOptions {
  spreadsheetId: string;
  /**
   * Range in A1 notation, e.g. "Sheet1!A1" or "Sheet1!A:Z".
   * Append finds the first empty row in this range's table.
   */
  range: string;
  /**
   * 2D array of row values. Cell types are interpreted from JSON
   * (numbers as numbers, strings as strings, etc.) when valueInputOption='USER_ENTERED'.
   */
  values: Array<Array<string | number | boolean | null>>;
  /**
   * 'USER_ENTERED' (default) parses values like the Google Sheets UI would
   * (formulas, dates, currencies). 'RAW' inserts as-is.
   */
  valueInputOption?: 'USER_ENTERED' | 'RAW';
}

export interface AppendRowsResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedCells: number;
}

export interface GetValuesOptions {
  spreadsheetId: string;
  /** A1 notation: "Sheet1!A1:C10" or "A:A" or "Sheet1" */
  range: string;
  /**
   * 'FORMATTED_VALUE' (default) returns strings as displayed in UI.
   * 'UNFORMATTED_VALUE' returns native types (numbers, dates as serial numbers).
   * 'FORMULA' returns the formula string.
   */
  valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
}

export interface GetValuesResult {
  spreadsheetId: string;
  range: string;
  values: Array<Array<string | number | boolean | null>>;
}

export interface UpdateValuesOptions {
  spreadsheetId: string;
  range: string;
  values: Array<Array<string | number | boolean | null>>;
  valueInputOption?: 'USER_ENTERED' | 'RAW';
}

export interface UpdateValuesResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedCells: number;
}

/**
 * Sheets operations subject to allowlist/blocklist enforcement.
 * Destructive operations (clearing, deleting sheets) are intentionally absent.
 */
export type SheetsOperation =
  | 'create_spreadsheet'
  | 'append_rows'
  | 'update_values'
  | 'clear_values'
  | 'delete_sheet'
  | 'delete_spreadsheet';
