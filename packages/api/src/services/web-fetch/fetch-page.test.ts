/**
 * fetchPage against a local server. The guard is given the test policy that
 * lets 127.0.0.1 through; its refusals are covered in guarded-get.test.ts.
 */

import { once } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDialFence, type DialFence } from '../../test/dial-fence';
import { refusalFor } from './address-policy';
import { ERROR_BODY_MAX_CHARS, fetchPage } from './fetch-page';

let fence: DialFence;
let server: http.Server | null = null;
let respond: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

const network = {
  refusalFor: (address: string) => (address === '127.0.0.1' ? null : refusalFor(address)),
};

async function serve(handler: typeof respond): Promise<string> {
  respond = handler;
  server = http.createServer((req, res) => respond(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(() => {
  fence = installDialFence();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

afterAll(() => fence.restore());

const page = (url: string, maxChars = 20_000, extractMode: 'markdown' | 'text' = 'markdown') =>
  fetchPage({ url, extractMode, maxChars }, { network });

describe('fetchPage', () => {
  it('reads an HTML page to markdown by Readability, with its title', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Docs</title></head><body><h1>Hello</h1><p>World</p></body></html>'
      );
    });
    const result = await page(`${base}/docs`);
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      contentType: 'text/html',
      extractor: 'readability',
      title: 'Docs',
      // Readability renders an <h1> inside the content it keeps as an <h2>.
      text: '## Hello\n\nWorld',
      truncated: false,
      bodyTruncated: false,
      redirects: 0,
      finalUrl: `${base}/docs`,
    });
  });

  it('reads an error page with the scan alone, never Readability', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Gone</title></head><body><h1>Not here</h1></body></html>');
    });
    const result = await page(`${base}/gone`);
    expect(result).toMatchObject({ ok: false, status: 404, extractor: 'html', title: 'Gone' });
    expect(result.text).toBe('# Not here');
  });

  it('cuts the text at maxChars and says so, never splitting a surrogate pair', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${'a'.repeat(99)}\u{1F600}${'b'.repeat(500)}`);
    });
    const result = await page(base, 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a'.repeat(99));
  });

  it('refuses a binary body', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await expect(page(base)).rejects.toThrow(
      'The response is image/png, which web_fetch does not read'
    );
  });

  it('refuses an undeclared body that looks binary', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    });
    await expect(page(base)).rejects.toThrow('an undeclared binary body');
  });

  it('keeps an error page short', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('x'.repeat(10_000));
    });
    const result = await page(base);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.text).toHaveLength(ERROR_BODY_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('pretty-prints JSON', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const result = await page(base);
    expect(result.text).toBe('{\n  "ok": true\n}');
    expect(result.extractor).toBe('json');
  });
});
