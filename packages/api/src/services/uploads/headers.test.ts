import { describe, expect, it } from 'vitest';
import { uploadResponseHeaders } from './headers.js';

const UP = '0a0a0a0a-0000-4000-8000-00000000000a';

describe('uploadResponseHeaders', () => {
  it('serves images inline and documents as downloads, always unsniffed, sandboxed and uncached', () => {
    for (const [type, disposition] of [
      ['image/jpeg', `inline; filename="${UP}.jpg"`],
      ['image/png', `inline; filename="${UP}.png"`],
      ['application/pdf', `attachment; filename="${UP}.pdf"`],
      ['text/plain; charset=utf-8', `attachment; filename="${UP}.txt"`],
    ]) {
      expect(uploadResponseHeaders(UP, type)).toEqual({
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, no-store',
        'Content-Disposition': disposition,
      });
    }
  });

  it('serves nothing for a type the sniffer never records', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'text/plain',
      'application/octet-stream',
      '',
    ]) {
      expect(uploadResponseHeaders(UP, type)).toBeNull();
    }
  });

  it('never puts anything but a canonical id in the download name', () => {
    expect(uploadResponseHeaders('a"; filename="evil.html', 'application/pdf')).toBeNull();
    expect(uploadResponseHeaders(UP.toUpperCase(), 'application/pdf')).toBeNull();
  });
});
