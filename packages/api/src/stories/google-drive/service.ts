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
  type DriveFile,
  type GetFileOptions,
  type ListFilesOptions,
  type ListFilesResult,
  type MoveFileOptions,
} from './types';

const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,owners,trashed';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

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
