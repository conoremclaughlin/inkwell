/**
 * What an uploaded file is, decided from its bytes alone (upload design r2 §3).
 *
 * The client's file name, extension and Content-Type are never inputs: a
 * person's phone can label anything as anything, and whatever this returns
 * is what the read route serves and what a runner is told it has. Four kinds
 * are accepted; everything else, HEIC, WebP, GIF, SVG and HTML included, is
 * refused.
 */

/** Per-file cap for every upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Text is held to a smaller cap: it is read whole into an inkling's turn. */
export const MAX_TEXT_UPLOAD_BYTES = 1024 * 1024;

export type UploadKind = 'image' | 'document';

export interface SniffedType {
  kind: UploadKind;
  contentType: 'image/jpeg' | 'image/png' | 'application/pdf' | 'text/plain; charset=utf-8';
  /** Server-chosen extension for the stored file; runners pick a reader by it. */
  ext: 'jpg' | 'png' | 'pdf' | 'txt';
}

const EXT_BY_CONTENT_TYPE: Record<SniffedType['contentType'], SniffedType['ext']> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'text/plain; charset=utf-8': 'txt',
};

/**
 * The stored file's extension for a row's content_type, or null for any
 * other value, so a row can only ever name one of the four kinds of file.
 */
export function extForContentType(contentType: string): SniffedType['ext'] | null {
  return Object.hasOwn(EXT_BY_CONTENT_TYPE, contentType)
    ? EXT_BY_CONTENT_TYPE[contentType as SniffedType['contentType']]
    : null;
}

export type SniffRefusal = 'empty' | 'too-large' | 'unsupported';

export type SniffResult = ({ ok: true } & SniffedType) | { ok: false; reason: SniffRefusal };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Markup that is valid UTF-8 is still refused rather than stored as text: the
 * design promised HTML and SVG a 415, and nothing a person sends an inkling
 * needs to start this way. Matched case-insensitively at the first
 * non-whitespace character, after an optional byte-order mark.
 */
const MARKUP_PREFIXES = ['<!doctype', '<html', '<svg', '<?xml'];

export function sniffUploadType(bytes: Buffer): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, reason: 'too-large' };

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ok: true, kind: 'image', contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: true, kind: 'image', contentType: 'image/png', ext: 'png' };
  }
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { ok: true, kind: 'document', contentType: 'application/pdf', ext: 'pdf' };
  }
  return sniffText(bytes);
}

function sniffText(bytes: Buffer): SniffResult {
  if (bytes.includes(0)) return { ok: false, reason: 'unsupported' };
  let text: string;
  try {
    // fatal: a single invalid sequence refuses the file rather than being
    // replaced with U+FFFD, so binary formats this does not know stay out.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
  if (bytes.length > MAX_TEXT_UPLOAD_BYTES) return { ok: false, reason: 'too-large' };
  // trimStart also removes a byte-order mark: U+FEFF is ECMAScript whitespace.
  const head = text.trimStart().slice(0, 16).toLowerCase();
  if (MARKUP_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true, kind: 'document', contentType: 'text/plain; charset=utf-8', ext: 'txt' };
}
