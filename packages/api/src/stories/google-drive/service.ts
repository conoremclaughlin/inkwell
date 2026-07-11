/**
 * Google Drive Service
 *
 * Handles Google Drive API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, drive_v3 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import {
  FOLDER_MIME_TYPE,
  type CreateFolderOptions,
  type DownloadedFile,
  type DownloadFileOptions,
  type DriveFile,
  type GetFileOptions,
  type ListFilesOptions,
  type ListFilesResult,
  type MoveFileOptions,
} from './types';

const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,owners,trashed';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

/** Max bytes for binary downloads (files.get alt=media). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Default export formats for Google-native files (files.export caps at ~10MB). */
const GOOGLE_EXPORT_DEFAULTS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', extension: '.csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', extension: '.txt' },
};

const EXPORT_MIME_EXTENSIONS: Record<string, string> = {
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/pdf': '.pdf',
  'application/rtf': '.rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/epub+zip': '.epub',
  'text/markdown': '.md',
};

export class GoogleDriveService {
  private oauthService = getOAuthService();

  private async getClient(userId: string): Promise<drive_v3.Drive> {
    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.drive({ version: 'v3', auth });
  }

  async listFiles(userId: string, options: ListFilesOptions = {}): Promise<ListFilesResult> {
    const drive = await this.getClient(userId);

    const pageSize = options.pageSize ?? 25;

    logger.info('Listing Drive files', {
      userId,
      query: options.query,
      pageSize,
      orderBy: options.orderBy,
    });

    const response = await drive.files.list({
      q: options.query,
      pageSize,
      pageToken: options.pageToken,
      orderBy: options.orderBy,
      fields: LIST_FIELDS,
      // We restrict to "user" corpus by default — covers personal files plus
      // anything shared with them. Domain-wide search would require explicit opt-in.
      corpora: 'user',
    });

    return {
      files: (response.data.files || []).map((f) => this.mapFile(f)),
      nextPageToken: response.data.nextPageToken || undefined,
    };
  }

  async getFile(userId: string, options: GetFileOptions): Promise<DriveFile> {
    const drive = await this.getClient(userId);

    logger.info('Fetching Drive file', { userId, fileId: options.fileId });

    const response = await drive.files.get({
      fileId: options.fileId,
      fields: FILE_FIELDS,
    });

    return this.mapFile(response.data);
  }

  async createFolder(userId: string, options: CreateFolderOptions): Promise<DriveFile> {
    const drive = await this.getClient(userId);

    logger.info('Creating Drive folder', {
      userId,
      name: options.name,
      parentFolderId: options.parentFolderId,
    });

    const requestBody: drive_v3.Schema$File = {
      name: options.name,
      mimeType: FOLDER_MIME_TYPE,
    };
    if (options.parentFolderId) {
      requestBody.parents = [options.parentFolderId];
    }

    const response = await drive.files.create({
      requestBody,
      fields: FILE_FIELDS,
    });

    return this.mapFile(response.data);
  }

  async moveFile(userId: string, options: MoveFileOptions): Promise<DriveFile> {
    const drive = await this.getClient(userId);

    logger.info('Moving Drive file', {
      userId,
      fileId: options.fileId,
      newParentFolderId: options.newParentFolderId,
    });

    // First, look up current parents so we can remove them in the same update.
    const current = await drive.files.get({
      fileId: options.fileId,
      fields: 'parents',
    });
    const previousParents = (current.data.parents || []).join(',');

    const response = await drive.files.update({
      fileId: options.fileId,
      addParents: options.newParentFolderId,
      removeParents: previousParents || undefined,
      fields: FILE_FIELDS,
    });

    return this.mapFile(response.data);
  }

  /**
   * Download a file's content. Google-native files (Docs/Sheets/Slides) go
   * through files.export with a chosen MIME type (Docs support text/plain,
   * text/html, application/pdf, application/epub+zip, .docx, and more);
   * everything else downloads verbatim via files.get alt=media.
   */
  async downloadFile(userId: string, options: DownloadFileOptions): Promise<DownloadedFile> {
    const drive = await this.getClient(userId);
    const file = await this.getFile(userId, { fileId: options.fileId });

    if (file.isFolder) {
      throw new Error(`"${file.name}" is a folder — download individual files instead`);
    }

    if (file.isGoogleNative) {
      const defaults = GOOGLE_EXPORT_DEFAULTS[file.mimeType];
      const exportMimeType = options.exportMimeType || defaults?.mimeType;
      if (!exportMimeType) {
        throw new Error(
          `No export format known for ${file.mimeType} — pass exportMimeType explicitly`
        );
      }

      logger.info('Exporting Google-native Drive file', {
        userId,
        fileId: options.fileId,
        sourceMimeType: file.mimeType,
        exportMimeType,
      });

      const response = await drive.files.export(
        { fileId: options.fileId, mimeType: exportMimeType },
        { responseType: 'arraybuffer' }
      );

      return {
        file,
        content: Buffer.from(response.data as ArrayBuffer),
        effectiveMimeType: exportMimeType,
        extension: EXPORT_MIME_EXTENSIONS[exportMimeType] || defaults?.extension || '.bin',
        exported: true,
      };
    }

    if (file.size !== undefined && file.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `File is ${Math.round(file.size / 1024 / 1024)}MB — exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB download limit`
      );
    }

    logger.info('Downloading binary Drive file', {
      userId,
      fileId: options.fileId,
      mimeType: file.mimeType,
      size: file.size,
    });

    const response = await drive.files.get(
      { fileId: options.fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const dotIndex = file.name.lastIndexOf('.');
    return {
      file,
      content: Buffer.from(response.data as ArrayBuffer),
      effectiveMimeType: file.mimeType,
      extension: dotIndex > 0 ? file.name.slice(dotIndex) : '',
      exported: false,
    };
  }

  private mapFile(file: drive_v3.Schema$File): DriveFile {
    const mimeType = file.mimeType || '';
    return {
      id: file.id || '',
      name: file.name || '',
      mimeType,
      size: file.size ? Number(file.size) : undefined,
      createdTime: file.createdTime || undefined,
      modifiedTime: file.modifiedTime || undefined,
      webViewLink: file.webViewLink || undefined,
      parents: file.parents || undefined,
      isGoogleNative: mimeType.startsWith('application/vnd.google-apps.'),
      isFolder: mimeType === FOLDER_MIME_TYPE,
      owners: file.owners?.map((o) => ({
        emailAddress: o.emailAddress || '',
        displayName: o.displayName || undefined,
      })),
      trashed: file.trashed ?? undefined,
    };
  }
}

let driveService: GoogleDriveService | null = null;

export function getGoogleDriveService(): GoogleDriveService {
  if (!driveService) {
    driveService = new GoogleDriveService();
  }
  return driveService;
}
