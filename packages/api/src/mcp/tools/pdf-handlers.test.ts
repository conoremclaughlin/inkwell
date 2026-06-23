import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleReadPdf } from './pdf-handlers';

describe('handleReadPdf', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pdf-test-'));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects paths outside the allowed root', async () => {
    const result = await handleReadPdf({ filePath: '/etc/passwd' }, { allowedRoot: tmpRoot });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must live under/);
  });

  it('rejects non-existent files', async () => {
    const result = await handleReadPdf(
      { filePath: join(tmpRoot, 'nope.pdf') },
      { allowedRoot: tmpRoot }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects non-PDF files', async () => {
    const txtFile = join(tmpRoot, 'doc.txt');
    await writeFile(txtFile, 'hello');
    const result = await handleReadPdf({ filePath: txtFile }, { allowedRoot: tmpRoot });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not appear to be a PDF/);
  });

  it('rejects directories', async () => {
    const dir = join(tmpRoot, 'subdir.pdf');
    await mkdir(dir, { recursive: true });
    const result = await handleReadPdf({ filePath: dir }, { allowedRoot: tmpRoot });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not a regular file/);
  });

  it('rejects symlinks that escape the root', async () => {
    const linkPath = join(tmpRoot, 'escape.pdf');
    await symlink('/etc/passwd', linkPath).catch(() => {});
    const result = await handleReadPdf({ filePath: linkPath }, { allowedRoot: tmpRoot });
    expect(result.success).toBe(false);
  });

  it('parses a minimal valid PDF', async () => {
    const minimalPdf = Buffer.from(
      'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRgo=',
      'base64'
    );
    const pdfFile = join(tmpRoot, 'minimal.pdf');
    await writeFile(pdfFile, minimalPdf);
    const result = await handleReadPdf({ filePath: pdfFile }, { allowedRoot: tmpRoot });
    expect(result.success).toBe(true);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.totalPages).toBeGreaterThanOrEqual(1);
    expect(result.text).toBeDefined();
  });
});
