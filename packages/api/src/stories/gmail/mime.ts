/**
 * RFC 5322 / 2045-2047 helpers for composing and parsing Gmail messages.
 *
 * Pure functions, no I/O — the interesting correctness lives here and is
 * unit-testable without a Gmail client.
 *
 * Three jobs:
 *
 * 1. PARSING inbound address headers. The previous parser was a single
 *    optional-group regex whose display-name group backtracked into the
 *    addr-spec on bare addresses: "a@b.com" parsed as name "a@b.co" +
 *    email "m". That corruption then fed replyAll's Cc list, so Gmail
 *    rejected the send with "Invalid Cc header" (Myra, 2026-08-20).
 *
 * 2. ENCODING outbound headers. Header values are never interpolated raw:
 *    CR/LF is stripped so a hostile Subject cannot inject headers, and
 *    non-ASCII is RFC 2047 encoded-word wrapped. This matters most on
 *    reply, where the Subject is `Re: ` + a subject an untrusted sender
 *    chose.
 *
 * 3. ASSEMBLING multipart/mixed bodies so outbound mail can carry
 *    attachments.
 */

import { randomBytes } from 'crypto';
import { extname } from 'path';
import type { EmailAddress } from './types';

/** Max bytes per RFC 2047 encoded-word payload, kept under the 75-char line cap. */
const ENCODED_WORD_MAX_BYTES = 45;

/** Base64 line length for message bodies (RFC 2045 caps lines at 76). */
const BASE64_LINE_LENGTH = 76;

// ============================================================================
// Address parsing
// ============================================================================

/**
 * Split an address-list header into individual address strings.
 *
 * A plain `.split(',')` breaks on quoted display names that contain a
 * comma — `"Shrestha, Sneha" <s@x.com>` is one address, not two — so this
 * walks the string tracking quote state and angle-bracket depth and only
 * breaks on top-level commas.
 */
export function splitAddressList(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;
  let escaped = false;

  for (const char of header) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inQuotes) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === '<') {
      inAngles = true;
      current += char;
      continue;
    }
    if (!inQuotes && char === '>') {
      inAngles = false;
      current += char;
      continue;
    }
    if (char === ',' && !inQuotes && !inAngles) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip surrounding quotes from a display name and unescape its contents. */
function unquoteDisplayName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/**
 * Parse one address into its display name and addr-spec.
 *
 * The angle bracket is the discriminator: whatever sits inside the LAST
 * `<...>` pair is the address and everything before it is the display
 * name. With no brackets the entire string is the address and there is no
 * display name — the case the old regex got wrong.
 */
export function parseAddress(input: string): EmailAddress {
  const trimmed = input.trim();
  if (!trimmed) return { email: '' };

  const open = trimmed.lastIndexOf('<');
  const close = trimmed.lastIndexOf('>');

  if (open !== -1 && close > open) {
    const email = trimmed.slice(open + 1, close).trim();
    const name = unquoteDisplayName(trimmed.slice(0, open));
    return name ? { name, email } : { email };
  }

  return { email: trimmed };
}

/** Parse a full address-list header (To, Cc, …) into addresses. */
export function parseAddressList(header: string): EmailAddress[] {
  if (!header?.trim()) return [];
  return splitAddressList(header)
    .map(parseAddress)
    .filter((a) => a.email.length > 0);
}

/**
 * Is this a usable addr-spec for an outbound header?
 *
 * Deliberately permissive about the local part and strict about the
 * shape: an address must have exactly the separators that make it
 * routable and none of the characters that would let it break out of the
 * header it is written into. This is the gate that keeps a mis-parsed
 * fragment like `m` from ever reaching a Cc line again.
 */
export function isValidAddress(address: string): boolean {
  return /^[^\s@,<>"]+@[^\s@,<>".]+(\.[^\s@,<>".]+)+$/.test(address.trim());
}

// ============================================================================
// Header encoding
// ============================================================================

/**
 * Remove CR/LF from a header value.
 *
 * Header injection guard: without this, a value carrying "\r\nBcc: …"
 * would append a real header to the outgoing message. Folding whitespace
 * is collapsed to a single space rather than dropped so words do not run
 * together.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const NON_ASCII = /[^\x20-\x7E]/;

/**
 * RFC 2047 encode a header value when it needs it.
 *
 * Pure-ASCII values pass through unchanged. Anything else is emitted as one
 * or more `=?UTF-8?B?…?=` encoded-words, split on whole characters so a
 * multi-byte sequence is never cut across two words.
 */
export function encodeHeaderWord(value: string): string {
  if (!NON_ASCII.test(value)) return value;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + charBytes > ENCODED_WORD_MAX_BYTES) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk) {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }

  // Encoded-words on one line are separated by a space, which decoders drop.
  return words.join(' ');
}

/** Build a header line with its value sanitized and encoded. */
export function headerLine(name: string, value: string): string {
  return `${name}: ${encodeHeaderWord(sanitizeHeaderValue(value))}`;
}

// ============================================================================
// Body / attachment assembly
// ============================================================================

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

/** Best-effort content type from a filename extension. */
export function guessMimeType(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] || 'application/octet-stream';
}

/** Wrap base64 to RFC 2045's line limit. */
function wrapBase64(buffer: Buffer): string {
  const encoded = buffer.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(i, i + BASE64_LINE_LENGTH));
  }
  return lines.join('\r\n');
}

/**
 * RFC 5987 `attr-char`. Everything outside this set must be percent-encoded
 * in an RFC 2231 extended parameter value.
 *
 * `encodeURIComponent` is NOT a substitute: it passes `!'()*` through
 * unescaped, and `'` and `(` `)` are not attr-chars. A filename like
 * `résumé (final).pdf` encoded that way produces a parameter a standards
 * parser rejects — Python's email module reports a defect and hands back
 * only `résumé`.
 */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/** Percent-encode UTF-8 bytes per RFC 2231 §4 / RFC 5987 §3.2. */
function encodeExtendedValue(value: string): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/**
 * Emit a quoted-string parameter value.
 *
 * Backslash and double-quote are escaped rather than deleted. Deleting them
 * silently renames the file: `a\b.pdf` stripped of its backslash arrives as
 * `ab.pdf`, which looks like a successful attachment of a different name.
 */
function quoteParam(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * Encode a filename as a MIME parameter, round-tripping every name we accept.
 *
 * Pure-ASCII names are a quoted-string. Non-ASCII names use ONLY RFC 2231's
 * extended form.
 *
 * RFC 6266 §4.3 suggests also emitting an ASCII fallback, and we deliberately
 * do not: when both are present, which one wins is parser-dependent. Python's
 * standards-based parser returns the fallback, so `résumé (final).pdf` would
 * arrive as `r_sum_ (final).pdf` — a plausible-looking wrong name. A legacy
 * parser that ignores RFC 2231 instead shows no name, which is visibly
 * degraded rather than quietly incorrect. Same reasoning as failing a send
 * outright rather than delivering it silently missing its attachments.
 */
function encodeFilenameParam(param: 'filename' | 'name', filename: string): string {
  const safe = sanitizeHeaderValue(filename) || 'attachment';
  if (!NON_ASCII.test(safe)) return `${param}=${quoteParam(safe)}`;
  return `${param}*=UTF-8''${encodeExtendedValue(safe)}`;
}

/** A boundary that cannot collide with base64 part content. */
function makeBoundary(): string {
  return `----=_Ink_${randomBytes(16).toString('hex')}`;
}

export interface BuildMessageOptions {
  headers: string[];
  body: string;
  isHtml?: boolean;
  attachments?: OutboundAttachment[];
}

/**
 * Assemble a complete RFC 5322 message, base64url-encoded for the Gmail
 * `raw` field.
 *
 * With no attachments this stays a simple single-part message. Bodies are
 * always base64 transfer-encoded: it keeps UTF-8 bodies well-formed, caps
 * line length below RFC 5322's 998-char limit, and makes it impossible for
 * body text to forge a multipart boundary.
 */
export function buildRawMessage(options: BuildMessageOptions): string {
  const { headers, body, isHtml = false, attachments = [] } = options;
  const contentType = `text/${isHtml ? 'html' : 'plain'}; charset=utf-8`;
  const bodyPart = wrapBase64(Buffer.from(body, 'utf8'));

  let message: string;

  if (attachments.length === 0) {
    message = [
      ...headers,
      'MIME-Version: 1.0',
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      '',
      bodyPart,
    ].join('\r\n');
  } else {
    const boundary = makeBoundary();
    const parts: string[] = [
      ...headers,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      '',
      bodyPart,
    ];

    for (const attachment of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; ${encodeFilenameParam('name', attachment.filename)}`,
        `Content-Disposition: attachment; ${encodeFilenameParam('filename', attachment.filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(attachment.content)
      );
    }

    parts.push(`--${boundary}--`);
    message = parts.join('\r\n');
  }

  return Buffer.from(message, 'utf8').toString('base64url');
}
