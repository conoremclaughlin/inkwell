import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32, deflateSync } from 'zlib';
import type { InkToolCallResult } from '../lib/ink-client.js';
import { readImageInfo } from './tool-images.js';
import { viewImage, viewImageRoots } from './view-image.js';

/** A real, decodable RGB PNG: valid CRCs, one deflated IDAT. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const textOf = (result: InkToolCallResult): string =>
  ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? '') as string;

describe('view_image', () => {
  let base: string;
  let cwd: string;
  let files: string;
  let outside: string;

  beforeEach(() => {
    // realpath: macOS tmpdir is a symlink, and containment is judged on real paths.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'view-image-test-')));
    cwd = join(base, 'work');
    files = join(base, 'ink-files');
    outside = join(base, 'elsewhere');
    for (const dir of [cwd, files, outside]) mkdirSync(dir);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const roots = () => [cwd, files];

  describe('what may be viewed', () => {
    it('refuses a path outside every root, naming the roots', async () => {
      writeFileSync(join(outside, 'secret.png'), makePng(4, 4));
      const readImage = vi.fn();
      const result = await viewImage(
        { path: join(outside, 'secret.png') },
        { cwd, roots: roots(), readImage }
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('outside the directories view_image may open');
      expect(textOf(result)).toContain(files);
      expect(readImage).not.toHaveBeenCalled();
    });

    it('refuses .. out of the working directory', async () => {
      writeFileSync(join(outside, 'secret.png'), makePng(4, 4));
      const readImage = vi.fn();
      const result = await viewImage(
        { path: '../elsewhere/secret.png' },
        { cwd, roots: roots(), readImage }
      );
      expect(textOf(result)).toContain('outside the directories');
      expect(readImage).not.toHaveBeenCalled();
    });

    it('refuses a symlink inside a root that points out of it', async () => {
      writeFileSync(join(outside, 'secret.png'), makePng(4, 4));
      symlinkSync(join(outside, 'secret.png'), join(cwd, 'innocent.png'));
      const readImage = vi.fn();
      const result = await viewImage({ path: 'innocent.png' }, { cwd, roots: roots(), readImage });
      expect(textOf(result)).toContain('outside the directories');
      expect(readImage).not.toHaveBeenCalled();
    });

    it('opens an image under the second root by absolute path', async () => {
      writeFileSync(join(files, 'board.png'), makePng(64, 48));
      const result = await viewImage({ path: join(files, 'board.png') }, { cwd, roots: roots() });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('(image/png, 64x48, ~5 tokens)');
    });

    it('expands ~/ and allows ~/.ink/files by default', async () => {
      // A name that cannot exist: reaching "does not exist" proves the path was
      // expanded and passed containment, without touching the real home.
      const result = await viewImage(
        { path: '~/.ink/files/view-image-test-does-not-exist-7f3a.png' },
        { cwd, readImage: vi.fn() }
      );
      expect(textOf(result)).toMatch(/does not exist\.$/);
      expect(viewImageRoots(cwd)[0]).toBe(cwd);
    });
  });

  describe('what it refuses to open', () => {
    it('a file over the size limit, before reading it', async () => {
      writeFileSync(join(cwd, 'huge.png'), makePng(64, 64));
      const readImage = vi.fn();
      const result = await viewImage(
        { path: 'huge.png' },
        { cwd, roots: roots(), maxFileBytes: 100, readImage }
      );
      expect(textOf(result)).toMatch(/over view_image's 0 MB limit/);
      expect(textOf(result)).toContain('sips -Z 2000');
      expect(readImage).not.toHaveBeenCalled();
    });

    it('a text file named like an image, judged by its contents', async () => {
      writeFileSync(join(cwd, 'notes.png'), 'these are notes, not pixels');
      const readImage = vi.fn();
      const result = await viewImage({ path: 'notes.png' }, { cwd, roots: roots(), readImage });
      expect(textOf(result)).toContain('is not a PNG, JPEG, GIF or WebP image');
      expect(readImage).not.toHaveBeenCalled();
    });

    it('a directory', async () => {
      mkdirSync(join(cwd, 'shots.png'));
      const result = await viewImage({ path: 'shots.png' }, { cwd, roots: roots() });
      expect(textOf(result)).toContain('is not a regular file');
    });

    it('a missing path argument', async () => {
      const result = await viewImage({}, { cwd, roots: roots() });
      expect(textOf(result)).toContain('needs `path`');
    });

    it("an image the reader could not prepare, passing on the reader's reason", async () => {
      writeFileSync(join(cwd, 'a.png'), makePng(4, 4));
      const result = await viewImage(
        { path: 'a.png' },
        {
          cwd,
          roots: roots(),
          readImage: async () =>
            ({
              content: [{ type: 'text', text: '[Image omitted: could not be resized.]' }],
            }) as InkToolCallResult,
        }
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('could not be prepared for viewing: [Image omitted');
    });
  });

  describe("through Pi's read (the real resizer)", () => {
    it('returns the image block untouched when it is already within limits', async () => {
      const png = makePng(640, 480);
      writeFileSync(join(cwd, 'shot.png'), png);
      const result = await viewImage({ path: 'shot.png' }, { cwd, roots: roots() });
      const block = (result as { content: Array<Record<string, unknown>> }).content[1]!;
      expect(block).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(Buffer.from(block.data as string, 'base64').equals(png)).toBe(true);
      expect(textOf(result)).toBe(
        'shot.png (image/png, 640x480, ~410 tokens). It stays in your context until you evict it; list_context shows it under source local-tool.'
      );
    });

    it('downscales a large image and says so, with the sizes on both sides', async () => {
      writeFileSync(join(cwd, 'fullpage.png'), makePng(2400, 100));
      const result = await viewImage({ path: 'fullpage.png' }, { cwd, roots: roots() });
      const block = (result as { content: Array<Record<string, unknown>> }).content[1]!;
      const delivered = readImageInfo(Buffer.from(block.data as string, 'base64'))!;
      expect(delivered.width).toBe(2000);
      expect(delivered.height).toBeLessThanOrEqual(84);
      expect(textOf(result)).toContain(
        `Downscaled from 2400x100 to ${delivered.width}x${delivered.height}`
      );
      expect(textOf(result)).toContain('crop the region you need');
    });
  });
});
