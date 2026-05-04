import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const { mockAttachmentGet, mockMkdir, mockWriteFile, MockOAuth2 } = vi.hoisted(() => {
  class _MockOAuth2 {
    setCredentials = vi.fn();
  }
  return {
    mockAttachmentGet: vi.fn(),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    MockOAuth2: _MockOAuth2,
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: vi.fn().mockReturnValue({
      users: {
        messages: {
          attachments: { get: mockAttachmentGet },
        },
      },
    }),
  },
}));

vi.mock('../../services/oauth', () => ({
  getOAuthService: vi.fn().mockReturnValue({
    getValidAccessToken: vi.fn().mockResolvedValue('mock-token'),
  }),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  };
});

import { GmailService } from './service';

const expectedDir = join(homedir(), '.ink', 'files', 'gmail');

describe('GmailService.downloadAttachment', () => {
  let service: GmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GmailService();
  });

  it('should download and save attachment with correct path', async () => {
    const testData = Buffer.from('hello world').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 11 } });

    const result = await service.downloadAttachment('user-1', 'msg-1', 'att-1', 'report.pdf');

    expect(result.path).toMatch(/\.ink\/files\/gmail\/\d+_report\.pdf$/);
    expect(result.filename).toBe('report.pdf');
    expect(result.size).toBe(11);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('report.pdf'),
      expect.any(Buffer)
    );
  });

  it('should sanitize special characters in filename', async () => {
    const testData = Buffer.from('data').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    const result = await service.downloadAttachment(
      'user-1',
      'msg-1',
      'att-1',
      'my file (copy).pdf'
    );

    expect(result.filename).toBe('my_file__copy_.pdf');
    expect(result.path).toContain('my_file__copy_.pdf');
  });

  it('should throw when attachment data is empty', async () => {
    mockAttachmentGet.mockResolvedValue({ data: { data: null } });

    await expect(
      service.downloadAttachment('user-1', 'msg-1', 'att-1', 'empty.pdf')
    ).rejects.toThrow('Attachment data is empty');
  });

  it('should create the gmail directory', async () => {
    const testData = Buffer.from('test').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    await service.downloadAttachment('user-1', 'msg-1', 'att-1', 'test.txt');

    expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it('should call Gmail API with correct params', async () => {
    const testData = Buffer.from('test').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    await service.downloadAttachment('user-1', 'msg-abc', 'att-xyz', 'file.txt');

    expect(mockAttachmentGet).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg-abc',
      id: 'att-xyz',
    });
  });
});
