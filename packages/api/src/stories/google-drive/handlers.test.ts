/**
 * Google Drive Handlers Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALLOWED_DRIVE_OPERATIONS,
  BLOCKED_DRIVE_OPERATIONS,
  isDriveOperationAllowed,
  listDriveFilesSchema,
  createDriveFolderSchema,
  moveDriveFileSchema,
  handleListDriveFiles,
  handleGetDriveFile,
  handleCreateDriveFolder,
  handleMoveDriveFile,
} from './handlers';

vi.mock('./service', () => ({
  getGoogleDriveService: vi.fn(),
}));

vi.mock('../../services/user-resolver', () => ({
  resolveUserOrThrow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getGoogleDriveService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';

const testUserId = '123e4567-e89b-12d3-a456-426614174000';
const mockUser = { id: testUserId, email: 'test@example.com' };
const mockDataComposer = {} as any;

describe('Drive allowlist', () => {
  it('allows list/get/create_folder/move; blocks trash/delete', () => {
    expect(isDriveOperationAllowed('list_files').allowed).toBe(true);
    expect(isDriveOperationAllowed('get_file').allowed).toBe(true);
    expect(isDriveOperationAllowed('create_folder').allowed).toBe(true);
    expect(isDriveOperationAllowed('move_file').allowed).toBe(true);

    expect(isDriveOperationAllowed('trash_file').allowed).toBe(false);
    expect(isDriveOperationAllowed('delete_file').allowed).toBe(false);

    expect(ALLOWED_DRIVE_OPERATIONS.has('move_file')).toBe(true);
    expect(BLOCKED_DRIVE_OPERATIONS.has('delete_file')).toBe(true);
  });
});

describe('Drive schemas', () => {
  it('listDriveFilesSchema defaults pageSize to 25', () => {
    const r = listDriveFilesSchema.safeParse({ userId: testUserId });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pageSize).toBe(25);
  });

  it('createDriveFolderSchema rejects empty name', () => {
    const r = createDriveFolderSchema.safeParse({ userId: testUserId, name: '' });
    expect(r.success).toBe(false);
  });

  it('moveDriveFileSchema requires both fileId + newParentFolderId', () => {
    const r1 = moveDriveFileSchema.safeParse({ userId: testUserId, fileId: 'f1' });
    const r2 = moveDriveFileSchema.safeParse({
      userId: testUserId,
      fileId: 'f1',
      newParentFolderId: 'folder-1',
    });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(true);
  });
});

describe('handleListDriveFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns files + nextPageToken from the service', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      listFiles: vi.fn().mockResolvedValue({
        files: [
          {
            id: 'f1',
            name: 'Tax Receipts',
            mimeType: 'application/vnd.google-apps.folder',
            isGoogleNative: true,
            isFolder: true,
          },
          {
            id: 'f2',
            name: 'expenses.csv',
            mimeType: 'text/csv',
            size: 1024,
            isGoogleNative: false,
            isFolder: false,
          },
        ],
        nextPageToken: 'next-page',
      }),
    } as any);

    const result = await handleListDriveFiles(
      { userId: testUserId, query: "name contains 'Tax'" },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(2);
    expect(body.nextPageToken).toBe('next-page');
    expect(body.files[0].isFolder).toBe(true);
  });

  it('hints when re-authorization is required', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      listFiles: vi
        .fn()
        .mockRejectedValue(new Error('insufficient authentication scopes for drive')),
    } as any);

    const result = await handleListDriveFiles({ userId: testUserId }, mockDataComposer);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('re-authorize Google');
  });
});

describe('handleGetDriveFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the file metadata', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      getFile: vi.fn().mockResolvedValue({
        id: 'f1',
        name: 'Tax Notes',
        mimeType: 'application/vnd.google-apps.document',
        isGoogleNative: true,
        isFolder: false,
      }),
    } as any);

    const result = await handleGetDriveFile({ userId: testUserId, fileId: 'f1' }, mockDataComposer);

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.file.name).toBe('Tax Notes');
  });

  it('hints when not found', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      getFile: vi.fn().mockRejectedValue(new Error('File not found: f-missing')),
    } as any);

    const result = await handleGetDriveFile(
      { userId: testUserId, fileId: 'f-missing' },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('File not found');
  });
});

describe('handleCreateDriveFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the new folder', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      createFolder: vi.fn().mockResolvedValue({
        id: 'folder-1',
        name: 'Tax 2026',
        mimeType: 'application/vnd.google-apps.folder',
        isGoogleNative: true,
        isFolder: true,
      }),
    } as any);

    const result = await handleCreateDriveFolder(
      { userId: testUserId, name: 'Tax 2026' },
      mockDataComposer
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.folder.isFolder).toBe(true);
  });
});

describe('handleMoveDriveFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the moved file', async () => {
    const move = vi.fn().mockResolvedValue({
      id: 'f1',
      name: 'expenses.csv',
      mimeType: 'text/csv',
      parents: ['folder-1'],
      isGoogleNative: false,
      isFolder: false,
    });
    vi.mocked(getGoogleDriveService).mockReturnValue({ moveFile: move } as any);

    const result = await handleMoveDriveFile(
      { userId: testUserId, fileId: 'f1', newParentFolderId: 'folder-1' },
      mockDataComposer
    );

    expect(move).toHaveBeenCalledWith(testUserId, {
      fileId: 'f1',
      newParentFolderId: 'folder-1',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.file.parents).toEqual(['folder-1']);
  });
});
