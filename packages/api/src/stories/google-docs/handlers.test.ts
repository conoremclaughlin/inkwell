/**
 * Google Docs Handlers Tests
 *
 * Mocked-API unit tests for the Docs handlers — schema validation,
 * allowlist enforcement, response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALLOWED_DOCS_OPERATIONS,
  BLOCKED_DOCS_OPERATIONS,
  isDocsOperationAllowed,
  createDocumentSchema,
  appendTextSchema,
  replaceTextSchema,
  handleCreateDocument,
  handleAppendText,
  handleReplaceText,
  handleGetDocument,
} from './handlers';

vi.mock('./service', () => ({
  getGoogleDocsService: vi.fn(),
}));

vi.mock('../../services/user-resolver', () => ({
  resolveUserOrThrow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getGoogleDocsService } from './service';
import { resolveUserOrThrow } from '../../services/user-resolver';

const testUserId = '123e4567-e89b-12d3-a456-426614174000';
const mockUser = { id: testUserId, email: 'test@example.com' };
const mockDataComposer = {} as any;

describe('Docs allowlist', () => {
  it('allows create/append/replace; blocks delete operations', () => {
    expect(isDocsOperationAllowed('create_document').allowed).toBe(true);
    expect(isDocsOperationAllowed('append_text').allowed).toBe(true);
    expect(isDocsOperationAllowed('replace_text').allowed).toBe(true);

    expect(isDocsOperationAllowed('delete_content_range').allowed).toBe(false);
    expect(isDocsOperationAllowed('delete_document').allowed).toBe(false);

    expect(ALLOWED_DOCS_OPERATIONS.has('create_document')).toBe(true);
    expect(BLOCKED_DOCS_OPERATIONS.has('delete_document')).toBe(true);
  });
});

describe('Docs schemas', () => {
  it('createDocumentSchema rejects empty title', () => {
    const r = createDocumentSchema.safeParse({ userId: testUserId, title: '' });
    expect(r.success).toBe(false);
  });

  it('appendTextSchema defaults separateWithNewline to true', () => {
    const r = appendTextSchema.safeParse({
      userId: testUserId,
      documentId: 'doc-1',
      text: 'hello',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.separateWithNewline).toBe(true);
  });

  it('replaceTextSchema accepts empty replacement', () => {
    const r = replaceTextSchema.safeParse({
      userId: testUserId,
      documentId: 'doc-1',
      find: 'TODO',
      replaceWith: '',
    });
    expect(r.success).toBe(true);
  });
});

describe('handleCreateDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the new document on success', async () => {
    const created = {
      documentId: 'doc-1',
      title: 'Tax Notes',
      url: 'https://docs.google.com/document/d/doc-1/edit',
      revisionId: 'rev1',
    };
    vi.mocked(getGoogleDocsService).mockReturnValue({
      createDocument: vi.fn().mockResolvedValue(created),
    } as any);

    const result = await handleCreateDocument(
      { userId: testUserId, title: 'Tax Notes' },
      mockDataComposer
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.document).toEqual(created);
  });
});

describe('handleAppendText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('passes text + separateWithNewline to the service', async () => {
    const append = vi.fn().mockResolvedValue({
      documentId: 'doc-1',
      title: 'Tax Notes',
      url: 'https://docs.google.com/document/d/doc-1/edit',
    });
    vi.mocked(getGoogleDocsService).mockReturnValue({ appendText: append } as any);

    await handleAppendText(
      { userId: testUserId, documentId: 'doc-1', text: 'New section' },
      mockDataComposer
    );

    expect(append).toHaveBeenCalledWith(testUserId, {
      documentId: 'doc-1',
      text: 'New section',
      separateWithNewline: true,
    });
  });

  it('hints when re-authorization is required', async () => {
    vi.mocked(getGoogleDocsService).mockReturnValue({
      appendText: vi
        .fn()
        .mockRejectedValue(new Error('insufficient authentication scopes for documents')),
    } as any);

    const result = await handleAppendText(
      { userId: testUserId, documentId: 'doc-1', text: 'x' },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('re-authorize Google');
  });
});

describe('handleReplaceText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns occurrencesChanged from the service', async () => {
    vi.mocked(getGoogleDocsService).mockReturnValue({
      replaceText: vi.fn().mockResolvedValue({ documentId: 'doc-1', occurrencesChanged: 3 }),
    } as any);

    const result = await handleReplaceText(
      { userId: testUserId, documentId: 'doc-1', find: 'TODO', replaceWith: 'DONE' },
      mockDataComposer
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.result.occurrencesChanged).toBe(3);
  });
});

describe('handleGetDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserOrThrow).mockResolvedValue({ user: mockUser, resolvedBy: 'userId' });
  });

  it('returns the document content', async () => {
    vi.mocked(getGoogleDocsService).mockReturnValue({
      getDocument: vi.fn().mockResolvedValue({
        documentId: 'doc-1',
        title: 'Tax Notes',
        url: 'https://docs.google.com/document/d/doc-1/edit',
        text: 'First line\nSecond line\n',
      }),
    } as any);

    const result = await handleGetDocument(
      { userId: testUserId, documentId: 'doc-1' },
      mockDataComposer
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.document.text).toContain('First line');
  });

  it('hints when document not found', async () => {
    vi.mocked(getGoogleDocsService).mockReturnValue({
      getDocument: vi.fn().mockRejectedValue(new Error('Requested entity was not found')),
    } as any);

    const result = await handleGetDocument(
      { userId: testUserId, documentId: 'doc-missing' },
      mockDataComposer
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.hint).toContain('Document not found');
  });
});
