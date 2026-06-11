import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectMime,
  resolveAttachments,
  buildAttachmentBlock,
  collectAttachmentDirs,
} from './attachments.js';

describe('detectMime', () => {
  it('maps common extensions', () => {
    expect(detectMime('/a/photo.jpg')).toBe('image/jpeg');
    expect(detectMime('/a/photo.JPEG')).toBe('image/jpeg');
    expect(detectMime('/a/shot.png')).toBe('image/png');
    expect(detectMime('/a/anim.webp')).toBe('image/webp');
    expect(detectMime('/a/doc.pdf')).toBe('application/pdf');
    expect(detectMime('/a/voice.ogg')).toBe('audio/ogg');
  });

  it('returns undefined for unknown extensions', () => {
    expect(detectMime('/a/file.xyz')).toBeUndefined();
    expect(detectMime('/a/noext')).toBeUndefined();
  });
});

describe('resolveAttachments', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ink-attach-test-'));
    await writeFile(join(dir, 'photo.png'), Buffer.alloc(2048, 1));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves existing files with mime and size', async () => {
    const [resolved] = await resolveAttachments([join(dir, 'photo.png')]);
    expect(resolved.mime).toBe('image/png');
    expect(resolved.sizeLabel).toBe('2KB');
    expect(resolved.missing).toBeUndefined();
  });

  it('flags missing files instead of dropping them', async () => {
    const [resolved] = await resolveAttachments([join(dir, 'nope.jpg')]);
    expect(resolved.missing).toBe(true);
    expect(resolved.mime).toBe('image/jpeg');
  });
});

describe('buildAttachmentBlock', () => {
  it('returns empty string for no attachments', () => {
    expect(buildAttachmentBlock([])).toBe('');
  });

  it('lists paths with metadata and a viewing instruction', () => {
    const block = buildAttachmentBlock([
      { path: '/home/u/.ink/files/telegram/p.jpg', mime: 'image/jpeg', sizeLabel: '142KB' },
      { path: '/tmp/report.pdf', mime: 'application/pdf', sizeLabel: '1024KB' },
    ]);
    expect(block).toContain('[Attached files]');
    expect(block).toContain('- /home/u/.ink/files/telegram/p.jpg (image/jpeg, 142KB)');
    expect(block).toContain('- /tmp/report.pdf (application/pdf, 1024KB)');
    expect(block).toContain('file-reading tool');
  });

  it('marks missing files explicitly', () => {
    const block = buildAttachmentBlock([{ path: '/gone.png', mime: 'image/png', missing: true }]);
    expect(block).toContain('MISSING');
  });
});

describe('collectAttachmentDirs', () => {
  it('dedupes parent directories and skips missing files', () => {
    const dirs = collectAttachmentDirs([
      { path: '/home/u/.ink/files/telegram/a.jpg' },
      { path: '/home/u/.ink/files/telegram/b.jpg' },
      { path: '/tmp/c.pdf' },
      { path: '/gone/d.png', missing: true },
    ]);
    expect(dirs).toEqual(['/home/u/.ink/files/telegram', '/tmp']);
  });
});
