/**
 * Google Sheets Service
 *
 * Handles Google Sheets API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, sheets_v4 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import type {
  AppendRowsOptions,
  AppendRowsResult,
  CreateSpreadsheetOptions,
  GetValuesOptions,
  GetValuesResult,
  SpreadsheetSummary,
  UpdateValuesOptions,
  UpdateValuesResult,
} from './types';

export class GoogleSheetsService {
  private oauthService = getOAuthService();

  private async getClient(userId: string): Promise<sheets_v4.Sheets> {
    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.sheets({ version: 'v4', auth });
  }

  async createSpreadsheet(
    userId: string,
    options: CreateSpreadsheetOptions
  ): Promise<SpreadsheetSummary> {
    const sheets = await this.getClient(userId);

    logger.info('Creating spreadsheet', { userId, title: options.title });

    const requestBody: sheets_v4.Schema$Spreadsheet = {
      properties: { title: options.title },
    };

    if (options.initialSheetTitle) {
      requestBody.sheets = [{ properties: { title: options.initialSheetTitle } }];
    }

    const response = await sheets.spreadsheets.create({ requestBody });
    const data = response.data;

    return this.mapSpreadsheet(data);
  }

  async appendRows(userId: string, options: AppendRowsOptions): Promise<AppendRowsResult> {
    const sheets = await this.getClient(userId);

    const valueInputOption = options.valueInputOption ?? 'USER_ENTERED';

    logger.info('Appending rows to spreadsheet', {
      userId,
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      rowCount: options.values.length,
      valueInputOption,
    });

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      valueInputOption,
      // INSERT_ROWS shifts existing data down rather than overwriting; this is what
      // people usually expect from "append" semantics.
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: options.values,
      },
    });

    const updates = response.data.updates;

    return {
      spreadsheetId: options.spreadsheetId,
      updatedRange: updates?.updatedRange || options.range,
      updatedRows: updates?.updatedRows || 0,
      updatedCells: updates?.updatedCells || 0,
    };
  }

  async getValues(userId: string, options: GetValuesOptions): Promise<GetValuesResult> {
    const sheets = await this.getClient(userId);

    const valueRenderOption = options.valueRenderOption ?? 'FORMATTED_VALUE';

    logger.info('Reading spreadsheet values', {
      userId,
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      valueRenderOption,
    });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      valueRenderOption,
    });

    return {
      spreadsheetId: options.spreadsheetId,
      range: response.data.range || options.range,
      values: (response.data.values as Array<Array<string | number | boolean | null>>) || [],
    };
  }

  async updateValues(userId: string, options: UpdateValuesOptions): Promise<UpdateValuesResult> {
    const sheets = await this.getClient(userId);

    const valueInputOption = options.valueInputOption ?? 'USER_ENTERED';

    logger.info('Updating spreadsheet values', {
      userId,
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      rowCount: options.values.length,
      valueInputOption,
    });

    const response = await sheets.spreadsheets.values.update({
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      valueInputOption,
      requestBody: { values: options.values },
    });

    return {
      spreadsheetId: options.spreadsheetId,
      updatedRange: response.data.updatedRange || options.range,
      updatedRows: response.data.updatedRows || 0,
      updatedCells: response.data.updatedCells || 0,
    };
  }

  async getSpreadsheet(userId: string, spreadsheetId: string): Promise<SpreadsheetSummary> {
    const sheets = await this.getClient(userId);

    logger.info('Fetching spreadsheet metadata', { userId, spreadsheetId });

    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      // Skip cell data — only metadata.
      includeGridData: false,
    });

    return this.mapSpreadsheet(response.data);
  }

  private mapSpreadsheet(data: sheets_v4.Schema$Spreadsheet): SpreadsheetSummary {
    return {
      spreadsheetId: data.spreadsheetId || '',
      title: data.properties?.title || '',
      url: data.spreadsheetUrl || '',
      sheets: (data.sheets || []).map((s) => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title || '',
        index: s.properties?.index ?? 0,
        gridProperties: s.properties?.gridProperties
          ? {
              rowCount: s.properties.gridProperties.rowCount ?? undefined,
              columnCount: s.properties.gridProperties.columnCount ?? undefined,
            }
          : undefined,
      })),
    };
  }
}

let sheetsService: GoogleSheetsService | null = null;

export function getGoogleSheetsService(): GoogleSheetsService {
  if (!sheetsService) {
    sheetsService = new GoogleSheetsService();
  }
  return sheetsService;
}
