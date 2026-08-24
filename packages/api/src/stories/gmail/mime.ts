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

/**
 * Max bytes in an attachment filename.
 *
 * The bound comes from the header line, not the filesystem: 255 bytes
 * percent-encode to at most 765 characters, which still fits under 998
 * after the longest MIME type and parameter prefix (~102). Roughly 298
 * would fit; 255 is the round number below it.
 *
 * A real file CAN exceed this — APFS accepts basenames well past 255 bytes
 * once they are non-ASCII, so this is not merely a guard on the
 * caller-supplied `filename` override. Such a file fails the send loudly
 * and the caller can pass a shorter `filename`.
 *
 * RFC 2231 continuations (`filename*0*`, `filename*1*`…) would carry any
 * length. Rejecting is still the trade taken here: names that long are
 * vanishingly rare, the failure is loud and self-describing, and a
 * continuation path exercised by almost nothing would rot untested. If
 * real files start hitting this, build the continuations.
 */
export const MAX_FILENAME_BYTES = 255;

/** RFC 5322 §2.1.1 hard limit, in octets, excluding the trailing CRLF. */
const MAX_LINE_LENGTH = 998;

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
 *
 * RFC 5322 groups (`Team: a@x.com, b@y.com;`) are flattened to their member
 * mailboxes. The group label before the colon is discarded and the closing
 * semicolon terminates the member currently being read — otherwise the
 * label glues itself to the first member and the semicolon to the last,
 * corrupting both. An empty group like `undisclosed-recipients:;` yields
 * nothing, which is exactly right.
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
    // Group label: everything read so far names the group, not a mailbox.
    if (char === ':' && !inQuotes && !inAngles) {
      current = '';
      continue;
    }
    if ((char === ',' || char === ';') && !inQuotes && !inAngles) {
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

/** RFC 5322 `atext` — every character legal in an unquoted local part. */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";

/** A DNS label: alphanumerics with internal hyphens. */
const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';

/** dot-atom local part @ a domain of two or more labels. */
const ADDR_SPEC = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*@${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);

/**
 * Is this a usable addr-spec for an outbound header?
 *
 * This is an ALLOWLIST, and that is the whole point. It was previously a
 * denylist of characters that could break out of a header, and a denylist
 * has to anticipate every hostile character: it missed a trailing `;`, so
 * `Team: a@x.com, b@y.com;` — legal RFC group syntax — split into one
 * rejected fragment and `b@y.com;`, which sailed through and produced a
 * malformed `To:`. That was the third round of the same failure shape.
 *
 * Enumerating what IS legal ends the pattern: anything unanticipated is
 * excluded by default rather than by having been thought of.
 */
export function isValidAddress(address: string): boolean {
  return ADDR_SPEC.test(address.trim());
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

  // Fold between encoded-words with CRLF + space (RFC 5322 §2.2.3 FWS,
  // RFC 2047 §5). A long non-ASCII subject inflates ~3.3x through base64,
  // so ~300 characters of Chinese on one line would breach the 998-char
  // hard limit; folding keeps every line short no matter the length.
  //
  // Inserting CRLF here is safe even though sanitizeHeaderValue exists to
  // remove it: this is our own structure, between words we generated. The
  // caller's bytes are base64 *inside* the words and cannot reach the fold.
  return words.join('\r\n ');
}

/** Build a header line with its value sanitized and encoded. */
export function headerLine(name: string, value: string): string {
  return `${name}: ${encodeHeaderWord(sanitizeHeaderValue(value))}`;
}

/**
 * Fail loudly if any header line breaches RFC 5322's 998-octet hard limit.
 *
 * Measured in UTF-8 BYTES, not `String.length`. RFC 5322 counts octets on
 * the wire; a JS string length counts UTF-16 code units, which understates
 * CJK text by 3x. `References: <長×400>` is 414 units but 1,214 bytes, so a
 * length-based check waves through a line over the limit by more than the
 * limit's own margin.
 *
 * Not hypothetical for `In-Reply-To` and `References`: unlike Subject,
 * those carry values lifted straight out of received mail and are only
 * CRLF-stripped, never encoded-word wrapped. Their bytes reach the wire
 * as-is.
 *
 * Applied only to header lines: bodies and attachments are base64-wrapped
 * at 76 characters by construction, and walking a multi-megabyte payload
 * to re-confirm that would be real work on a single-threaded server for no
 * information.
 */
function assertHeaderLinesFit(lines: string[]): void {
  for (const line of lines) {
    for (const physical of line.split('\r\n')) {
      const bytes = Buffer.byteLength(physical, 'utf8');
      if (bytes > MAX_LINE_LENGTH) {
        throw new Error(
          `Header line exceeds RFC 5322's ${MAX_LINE_LENGTH}-octet limit ` +
            `(${bytes} bytes): ${physical.slice(0, 80)}…`
        );
      }
    }
  }
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
  // Telegram voice notes are Opus-in-Ogg and land under both suffixes. `.oga`
  // is the second most common extension in the media root, so leaving it
  // unmapped sent every forwarded voice note out as generic bytes.
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aiff': 'audio/x-aiff',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

/** What an unrecognized extension resolves to. */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** Best-effort content type from a filename extension. */
export function guessMimeType(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] || DEFAULT_MIME_TYPE;
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
  if (Buffer.byteLength(safe, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error(
      `Attachment filename is too long (${Buffer.byteLength(safe, 'utf8')} bytes, max ${MAX_FILENAME_BYTES}).`
    );
  }
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

  assertHeaderLinesFit(headers);

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
      const partHeaders = [
        `Content-Type: ${attachment.mimeType}; ${encodeFilenameParam('name', attachment.filename)}`,
        `Content-Disposition: attachment; ${encodeFilenameParam('filename', attachment.filename)}`,
      ];
      assertHeaderLinesFit(partHeaders);
      parts.push(
        `--${boundary}`,
        ...partHeaders,
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
