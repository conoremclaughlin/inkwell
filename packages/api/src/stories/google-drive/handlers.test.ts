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
  downloadDriveFileSchema,
  handleListDriveFiles,
  handleGetDriveFile,
  handleCreateDriveFolder,
  handleMoveDriveFile,
  handleDownloadDriveFile,
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

const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}));

import { getGoogleDriveService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';

const testUserId = '123e4567-e89b-12d3-a456-426614174000';
const mockUser = { id: testUserId, email: 'test@example.com' };
const mockDataComposer = {} as any;

describe('Drive allowlist', () => {
  it('allows list/get/download/create_folder/move; blocks trash/delete', () => {
    expect(isDriveOperationAllowed('list_files').allowed).toBe(true);
    expect(isDriveOperationAllowed('get_file').allowed).toBe(true);
    expect(isDriveOperationAllowed('download_file').allowed).toBe(true);
    expect(isDriveOperationAllowed('create_folder').allowed).toBe(true);
    expect(isDriveOperationAllowed('move_file').allowed).toBe(true);

    expect(isDriveOperationAllowed('trash_file').allowed).toBe(false);
    expect(isDriveOperationAllowed('delete_file').allowed).toBe(false);

    expect(ALLOWED_DRIVE_OPERATIONS.has('download_file')).toBe(true);
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

describe('downloadDriveFileSchema', () => {
  it('accepts fileId with optional overrides', () => {
    const r = downloadDriveFileSchema.safeParse({ userId: testUserId, fileId: 'f1' });
    expect(r.success).toBe(true);
  });

  it('rejects missing fileId', () => {
    const r = downloadDriveFileSchema.safeParse({ userId: testUserId });
    expect(r.success).toBe(false);
  });
});

describe('handleDownloadDriveFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('saves an exported Google Doc to disk and returns the path + metadata', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi.fn().mockResolvedValue({
        file: { id: 'd1', name: 'Chapter 679', mimeType: 'application/vnd.google-apps.document' },
        content: Buffer.from('Chapter 679 body'),
        effectiveMimeType: 'text/plain',
        extension: '.txt',
        exported: true,
      }),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'd1' },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.exported).toBe(true);
    expect(parsed.savedPath).toContain('.ink/files/drive/Chapter 679.txt');
    expect(parsed.mimeType).toBe('text/plain');
    // No inline content — the tool returns a path, not the file body.
    expect(parsed.content).toBeUndefined();
    expect(parsed.preview).toBeUndefined();
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(mkdirMock).toHaveBeenCalledOnce();
  });

  it('downloads a binary file as-is', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi.fn().mockResolvedValue({
        file: { id: 'b1', name: 'cover.png', mimeType: 'image/png' },
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        effectiveMimeType: 'image/png',
        extension: '.png',
        exported: false,
      }),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'b1' },
      mockDataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.exported).toBe(false);
    expect(parsed.savedPath.endsWith('cover.png')).toBe(true);
  });

  it('appends the export extension when the target filename lacks it', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi.fn().mockResolvedValue({
        file: { id: 'd3', name: 'Chapter 680', mimeType: 'application/vnd.google-apps.document' },
        content: Buffer.from('body'),
        effectiveMimeType: 'text/plain',
        extension: '.txt',
        exported: true,
      }),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'd3', targetFilename: 'chapter-680' },
      mockDataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.savedPath.endsWith('chapter-680.txt')).toBe(true);
  });

  it('rejects ".." targetFilename that would escape the download directory', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi.fn().mockResolvedValue({
        file: { id: 'b2', name: 'legit.bin', mimeType: 'application/octet-stream' },
        content: Buffer.from([0xde, 0xad]),
        effectiveMimeType: 'application/octet-stream',
        extension: '',
        exported: false,
      }),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'b2', targetFilename: '..' },
      mockDataComposer
    );

    // sanitizeFilename converts ".." → "file", so it saves safely
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.savedPath).toContain('drive/file');
    expect(parsed.savedPath).not.toContain('..');
    expect(writeFileMock).toHaveBeenCalledOnce();
  });

  it('rejects ".." Drive filename with no extension (path traversal)', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi.fn().mockResolvedValue({
        file: { id: 'b3', name: '..', mimeType: 'application/octet-stream' },
        content: Buffer.from([0xde, 0xad]),
        effectiveMimeType: 'application/octet-stream',
        extension: '',
        exported: false,
      }),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'b3' },
      mockDataComposer
    );

    // sanitizeFilename converts ".." → "file", so it saves safely
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.savedPath).toContain('drive/file');
    expect(parsed.savedPath).not.toContain('..');
    expect(writeFileMock).toHaveBeenCalledOnce();
  });

  it('surfaces a hint when export format is unknown', async () => {
    vi.mocked(getGoogleDriveService).mockReturnValue({
      downloadFile: vi
        .fn()
        .mockRejectedValue(new Error('No export format known for application/vnd.google-apps.map')),
    } as any);

    const result = await handleDownloadDriveFile(
      { userId: testUserId, fileId: 'd4' },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('No export format');
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
