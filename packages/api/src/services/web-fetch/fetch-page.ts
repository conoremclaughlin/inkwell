/**
 * One web page, fetched under the guard and read as text.
 *
 * The flow is OpenClaw's runWebFetch (MIT License, Copyright (c) 2025 Peter
 * Steinberger; src/agents/tools/web-fetch.ts at f88e1f4c1c): fetch, read the
 * body by its content type, cut it to the character budget, and keep an error
 * page's body short. Its cache and its provider fallbacks (Firecrawl and the
 * like) are not ported: every call fetches, and only from the network.
 */

import {
  decodeBody,
  extractContent,
  htmlToReadable,
  isTextMediaType,
  mediaTypeOf,
  type ExtractMode,
  type ExtractedContent,
} from './extract';
import { guardedGet, WebFetchError, type GuardLimits, type GuardNetwork } from './guarded-get';
import { readMainContent } from './readability';

/** An error page's body is context, not content: this much is plenty. */
export const ERROR_BODY_MAX_CHARS = 4_000;

export interface FetchPageRequest {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  /** A 2xx status. */
  ok: boolean;
  /** The media type alone, "text/html". */
  contentType: string;
  extractor: ExtractedContent['extractor'];
  title?: string;
  text: string;
  /** The text was cut at the character budget. */
  truncated: boolean;
  /** The body was cut at the byte cap before it was read. */
  bodyTruncated: boolean;
  redirects: number;
  tookMs: number;
}

/**
 * A successful HTML page's main content, by Readability (readability.ts),
 * converted by the scan; or null, and the scan reads the whole page as it did
 * before Readability. Error pages are read by the scan alone: their body is
 * cut to ERROR_BODY_MAX_CHARS anyway.
 */
async function readableHtml(
  html: string,
  url: string,
  mode: ExtractMode
): Promise<ExtractedContent | null> {
  const outcome = await readMainContent(html, url);
  if (outcome.kind !== 'read') return null;
  const converted = htmlToReadable(outcome.content, mode);
  if (!converted.text) return null;
  return {
    text: converted.text,
    title: outcome.title ?? converted.title,
    extractor: 'readability',
  };
}

/** A NUL in the first kilobyte: an undeclared body that isn't text. */
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 1024).includes(0);
}

/** At most `limit` UTF-16 units, never ending on half a surrogate pair. */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

export async function fetchPage(
  request: FetchPageRequest,
  options: { limits?: Partial<GuardLimits>; network?: Partial<GuardNetwork> } = {}
): Promise<FetchedPage> {
  const started = Date.now();
  const response = await guardedGet(request.url, options);
  const rawContentType = String(response.headers['content-type'] ?? '');
  const contentType = mediaTypeOf(rawContentType);
  const ok = response.status >= 200 && response.status < 300;
  const readable =
    isTextMediaType(contentType) && !(contentType === '' && looksBinary(response.body));
  if (ok && !readable) {
    const failure = new WebFetchError(
      `The response is ${contentType || 'an undeclared binary body'}, which web_fetch does not read.`,
      'unreadable-body'
    );
    failure.hopUrl = response.finalUrl;
    throw failure;
  }

  let extracted: ExtractedContent = { text: '', extractor: 'text' };
  if (readable) {
    const body = decodeBody(response.body, rawContentType);
    const html = contentType === 'text/html' || contentType === 'application/xhtml+xml';
    extracted =
      (ok && html ? await readableHtml(body, response.finalUrl, request.extractMode) : null) ??
      extractContent(body, rawContentType, request.extractMode);
  }
  const limit = ok ? request.maxChars : Math.min(request.maxChars, ERROR_BODY_MAX_CHARS);
  const text = cutText(extracted.text, limit);

  return {
    url: request.url,
    finalUrl: response.finalUrl,
    status: response.status,
    ok,
    contentType,
    extractor: extracted.extractor,
    title: extracted.title,
    text,
    truncated: text.length < extracted.text.length,
    bodyTruncated: response.bodyTruncated,
    redirects: response.redirects,
    tookMs: Date.now() - started,
  };
}
