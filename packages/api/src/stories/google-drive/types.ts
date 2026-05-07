/**
 * Google Drive Types
 *
 * Type definitions for Drive API interactions.
 */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes — only present for binary files (not Google-native formats). */
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  /** True for Google-native formats (Doc, Sheet, Slide, Folder). */
  isGoogleNative: boolean;
  /** True only for the "folder" mimeType. */
  isFolder: boolean;
  owners?: Array<{ emailAddress: string; displayName?: string }>;
  trashed?: boolean;
}

export interface ListFilesOptions {
  /**
   * Drive query in Google's syntax. See:
   * https://developers.google.com/drive/api/guides/search-files
   * Examples:
   *  - "name contains 'Tax'"
   *  - "mimeType='application/vnd.google-apps.spreadsheet'"
   *  - "modifiedTime > '2026-01-01T00:00:00'"
   *  - "'<folderId>' in parents"
   *  - "trashed = false"
   */
  query?: string;
  pageSize?: number;
  pageToken?: string;
  /** Sort field, e.g. "modifiedTime desc" */
  orderBy?: string;
}

export interface ListFilesResult {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface GetFileOptions {
  fileId: string;
}

export interface CreateFolderOptions {
  name: string;
  parentFolderId?: string;
}

export interface MoveFileOptions {
  fileId: string;
  /** Destination folder ID; the file is removed from any current parents. */
  newParentFolderId: string;
}

/**
 * Drive operations subject to allowlist/blocklist enforcement.
 * Trashing/deleting are intentionally absent.
 */
export type DriveOperation =
  | 'list_files'
  | 'get_file'
  | 'create_folder'
  | 'move_file'
  | 'trash_file'
  | 'delete_file';

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
