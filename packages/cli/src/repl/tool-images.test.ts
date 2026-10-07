import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32, deflateSync } from 'zlib';
import type { InkToolCallResult } from '../lib/ink-client.js';
import {
  captureToolImages,
  estimateImageTokens,
  imagesToDeliver,
  readImageInfo,
  sniffImageType,
  takeCapturedImages,
  withImageCapture,
  type ContextImage,
} from './tool-images.js';

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0; // filter: none
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG header: SOI, a large APP1 to skip over, then SOF0 with the dimensions. */
function jpegHeader(width: number, height: number, app1Bytes = 20_000): Buffer {
  const app1 = Buffer.alloc(4 + app1Bytes);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(app1Bytes + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(16)]);
}

function riff(chunk: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(payload.length + 12, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(chunk, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload, Buffer.alloc(16)]);
}

describe('reading an image header', () => {
  it('knows each supported type by its bytes, not its name', () => {
    expect(sniffImageType(makePng(2, 2))).toBe('image/png');
    expect(sniffImageType(jpegHeader(2, 2))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a\x02\x00\x02\x00', 'latin1'))).toBe('image/gif');
    expect(sniffImageType(riff('VP8X', Buffer.alloc(10)))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(sniffImageType(Buffer.from('just text, named .png'))).toBeNull();
  });

  it('reads PNG, GIF and JPEG dimensions, skipping JPEG segments before the frame', () => {
    expect(readImageInfo(makePng(1536, 1024))).toEqual({
      mimeType: 'image/png',
      width: 1536,
      height: 1024,
    });
    expect(readImageInfo(Buffer.from('GIF87a\x40\x01\xf0\x00', 'latin1'))).toEqual({
      mimeType: 'image/gif',
      width: 320,
      height: 240,
    });
    expect(readImageInfo(jpegHeader(1536, 1024))).toEqual({
      mimeType: 'image/jpeg',
      width: 1536,
      height: 1024,
    });
  });

  it('reads all three WebP layouts', () => {
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1439, 4, 3); // canvas width - 1
    vp8x.writeUIntLE(8999, 7, 3); // canvas height - 1
    expect(readImageInfo(riff('VP8X', vp8x))).toMatchObject({ width: 1440, height: 9000 });

    const vp8 = Buffer.alloc(10);
    vp8.set([0x9d, 0x01, 0x2a], 3);
    vp8.writeUInt16LE(800, 6);
    vp8.writeUInt16LE(600, 8);
    expect(readImageInfo(riff('VP8 ', vp8))).toMatchObject({ width: 800, height: 600 });

    // 14-bit width-1 and height-1, packed little-endian after the 0x2f signature.
    const w = 1023;
    const h = 767;
    const bits = w | (h << 14);
    const vp8l = Buffer.from([
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
    ]);
    expect(readImageInfo(riff('VP8L', vp8l))).toMatchObject({ width: 1024, height: 768 });
  });

  it('refuses a truncated header rather than inventing dimensions', () => {
    expect(readImageInfo(makePng(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageInfo(jpegHeader(10, 10).subarray(0, 100))).toBeNull();
  });

  it("estimates tokens by Anthropic's published rule", () => {
    expect(estimateImageTokens(1536, 1024)).toBe(2098);
    expect(estimateImageTokens(1, 1)).toBe(1);
  });
});

describe('captureToolImages', () => {
  let dir: string;
  const cacheDir = () => Promise.resolve(dir);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-images-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const piReadResult = (png: Buffer): InkToolCallResult =>
    ({
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
      text: 'Read image file [image/png]',
      success: true,
    }) as InkToolCallResult;

  it('takes the bytes out of the result and leaves a descriptor the relay can carry', async () => {
    const png = makePng(640, 480);
    const result = await captureToolImages(piReadResult(png), {
      cacheDir,
      delivery: () => ({ deliverable: true }),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(png.toString('base64').slice(0, 64));
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain(dir);

    const content = (result as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'text', text: 'Read image file [image/png]' });
    expect(content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      width: 640,
      height: 480,
      approxTokens: 410,
    });
    expect(content[1]!.image).toMatch(/^img:[0-9a-f]{16}$/);

    const [image] = takeCapturedImages(result);
    expect(image).toMatchObject({ ref: content[1]!.image, width: 640, height: 480 });
    expect(readFileSync(image!.path).equals(png)).toBe(true);
  });

  it('names the file by its content, so viewing the same image twice writes it once', async () => {
    const png = makePng(8, 8);
    const opts = { cacheDir, delivery: () => ({ deliverable: true }) as const };
    const first = takeCapturedImages(await captureToolImages(piReadResult(png), opts));
    const second = takeCapturedImages(await captureToolImages(piReadResult(png), opts));
    expect(first[0]!.ref).toBe(second[0]!.ref);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('tells the model plainly when its backend cannot receive the image, and keeps nothing', async () => {
    const png = makePng(16, 16);
    const result = await captureToolImages(piReadResult(png), {
      cacheDir,
      delivery: () => ({ deliverable: false, reason: 'gemini cannot receive images' }),
    });
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    expect(content[1]).toEqual({
      type: 'text',
      text: '[image not shown: gemini cannot receive images]',
    });
    expect(JSON.stringify(result)).not.toContain(png.toString('base64').slice(0, 32));
    expect(takeCapturedImages(result)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('refuses bytes that are not the image they claim to be', async () => {
    const result = await captureToolImages(
      {
        content: [
          {
            type: 'image',
            data: Buffer.from('not a png').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      } as InkToolCallResult,
      { cacheDir, delivery: () => ({ deliverable: true }) }
    );
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(String(content[0]!.text)).toMatch(/^\[image not shown: the data is not/);
    expect(takeCapturedImages(result)).toEqual([]);
  });

  it('refuses an image larger than a re-seeded request may carry, pointing at view_image', async () => {
    const result = await captureToolImages(piReadResult(makePng(2400, 10)), {
      cacheDir,
      delivery: () => ({ deliverable: true }),
    });
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    expect(String(content[1]!.text)).toContain('2400x10 is over the 2000px inline limit');
    expect(String(content[1]!.text)).toContain('view_image');
    expect(takeCapturedImages(result)).toEqual([]);
  });

  it('returns a result with no image as the same object', async () => {
    const plain = { content: [{ type: 'text', text: 'hello' }] } as InkToolCallResult;
    const result = await captureToolImages(plain, {
      cacheDir: () => Promise.reject(new Error('must not be asked')),
      delivery: () => ({ deliverable: true }),
    });
    expect(result).toBe(plain);
  });

  it('wraps a whole dispatcher, whatever tool the image came from', async () => {
    const png = makePng(4, 4);
    const dispatch = withImageCapture(async () => piReadResult(png), {
      cacheDir,
      delivery: () => ({ deliverable: true }),
    });
    const result = await dispatch('get_drive_file', {}, {});
    expect(JSON.stringify(result)).not.toContain(png.toString('base64').slice(0, 32));
    expect(takeCapturedImages(result)).toHaveLength(1);
  });
});

describe('imagesToDeliver', () => {
  const image = (ref: string): ContextImage => ({
    ref,
    path: `/tmp/${ref}.png`,
    mimeType: 'image/png',
    width: 10,
    height: 10,
    approxTokens: 1,
  });
  const a = image('img:a');
  const b = image('img:b');

  it('a resume carries only what that session has not been given', () => {
    const delivered = { sessionId: 's1', refs: new Set(['img:a']) };
    expect(imagesToDeliver([a, b], delivered, 's1')).toEqual([b]);
  });

  it('a seed carries everything the ledger still holds', () => {
    const delivered = { sessionId: 's1', refs: new Set(['img:a', 'img:b']) };
    expect(imagesToDeliver([a, b], delivered, 's2')).toEqual([a, b]);
  });

  it('a stateless spawn always carries every image', () => {
    const delivered = { sessionId: undefined, refs: new Set(['img:a']) };
    expect(imagesToDeliver([a, b], delivered, undefined)).toEqual([a, b]);
  });

  it('the same picture held by two entries goes once', () => {
    expect(imagesToDeliver([a, a, b], { sessionId: undefined, refs: new Set() }, 's1')).toEqual([
      a,
      b,
    ]);
  });
});
