import { describe, expect, it } from 'vitest';
import {
  extForContentType,
  MAX_TEXT_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  sniffUploadType,
} from './sniff.js';

const bytes = (...parts: Array<number[] | string | Buffer>): Buffer =>
  Buffer.concat(
    parts.map((p) =>
      typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.isBuffer(p) ? p : Buffer.from(p)
    )
  );

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF');
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'IHDR');
const PDF = bytes('%PDF-1.7\n%', [0xe2, 0xe3, 0xcf, 0xd3], '\n1 0 obj');

describe('sniffUploadType', () => {
  it('accepts JPEG, PNG and PDF by their leading bytes', () => {
    expect(sniffUploadType(JPEG)).toEqual({
      ok: true,
      kind: 'image',
      contentType: 'image/jpeg',
      ext: 'jpg',
    });
    expect(sniffUploadType(PNG)).toEqual({
      ok: true,
      kind: 'image',
      contentType: 'image/png',
      ext: 'png',
    });
    expect(sniffUploadType(PDF)).toEqual({
      ok: true,
      kind: 'document',
      contentType: 'application/pdf',
      ext: 'pdf',
    });
  });

  it('accepts UTF-8 text, with or without a byte-order mark', () => {
    const text = {
      ok: true,
      kind: 'document',
      contentType: 'text/plain; charset=utf-8',
      ext: 'txt',
    };
    expect(sniffUploadType(bytes('Grocery list:\n- eggs\n- rice\n'))).toEqual(text);
    expect(sniffUploadType(bytes('Café, naïve, 日本語, 🙂'))).toEqual(text);
    expect(sniffUploadType(bytes([0xef, 0xbb, 0xbf], 'notes'))).toEqual(text);
  });

  it('decides from the bytes, so a signature anywhere but offset 0 does not count', () => {
    expect(sniffUploadType(bytes(' %PDF-1.7'))).toMatchObject({
      ok: true,
      contentType: 'text/plain; charset=utf-8',
    });
    expect(sniffUploadType(bytes([0x00], JPEG))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses truncated signatures that are not valid text', () => {
    expect(sniffUploadType(bytes([0xff, 0xd8]))).toEqual({ ok: false, reason: 'unsupported' });
    expect(sniffUploadType(PNG.subarray(0, 7))).toEqual({ ok: false, reason: 'unsupported' });
    // FF D8 is only the start of a JPEG marker; without the third FF it is not one.
    expect(sniffUploadType(bytes([0xff, 0xd8, 0x00, 0x10], 'JFIF'))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('refuses HEIC, WebP and GIF', () => {
    const heic = bytes([0x00, 0x00, 0x00, 0x18], 'ftypheic', [0x00, 0x00, 0x00, 0x00], 'mif1heic');
    const webp = bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ');
    const gif = bytes('GIF89a', [0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
    for (const file of [heic, webp, gif]) {
      expect(sniffUploadType(file)).toEqual({ ok: false, reason: 'unsupported' });
    }
  });

  it('refuses SVG, HTML and XML even though they are valid UTF-8', () => {
    for (const markup of [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<?xml version="1.0"?><svg/>',
      '<!DOCTYPE html><p>hi</p>',
      '\n\t  <HTML><body>hi</body></HTML>',
      '\ufeff<html>',
    ]) {
      expect(sniffUploadType(bytes(markup)), markup).toEqual({ ok: false, reason: 'unsupported' });
    }
    // Markup further in is just text.
    expect(sniffUploadType(bytes('Use <html> tags like this')).ok).toBe(true);
  });

  it('refuses text with a NUL byte or an invalid UTF-8 sequence', () => {
    expect(sniffUploadType(bytes('abc', [0x00], 'def'))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(sniffUploadType(bytes('ok ', [0xc3, 0x28]))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    // An overlong encoding of "/" is invalid UTF-8, not a slash.
    expect(sniffUploadType(bytes([0xc0, 0xaf]))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('maps each stored type back to its extension, and nothing else to anything', () => {
    for (const file of [JPEG, PNG, PDF, bytes('notes')]) {
      const sniffed = sniffUploadType(file);
      if (!sniffed.ok) throw new Error(`sniff refused ${sniffed.reason}`);
      expect(extForContentType(sniffed.contentType)).toBe(sniffed.ext);
    }
    for (const other of ['image/heic', 'text/plain', 'toString', '__proto__', 'constructor', '']) {
      expect(extForContentType(other)).toBeNull();
    }
  });

  it('refuses an empty file', () => {
    expect(sniffUploadType(Buffer.alloc(0))).toEqual({ ok: false, reason: 'empty' });
  });

  it('holds text to 1 MiB and everything to 10 MiB', () => {
    expect(sniffUploadType(Buffer.alloc(MAX_TEXT_UPLOAD_BYTES, 0x61)).ok).toBe(true);
    expect(sniffUploadType(Buffer.alloc(MAX_TEXT_UPLOAD_BYTES + 1, 0x61))).toEqual({
      ok: false,
      reason: 'too-large',
    });
    const bigJpeg = Buffer.alloc(MAX_UPLOAD_BYTES);
    JPEG.copy(bigJpeg);
    expect(sniffUploadType(bigJpeg).ok).toBe(true);
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    JPEG.copy(tooBig);
    expect(sniffUploadType(tooBig)).toEqual({ ok: false, reason: 'too-large' });
  });
});
