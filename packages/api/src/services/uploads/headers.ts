/**
 * The headers an upload is served with (upload design r2 §5).
 *
 * The sniffer refuses files that begin like HTML, SVG or XML, but a text file
 * can still carry markup further in, and a PDF can carry script. So nothing
 * here relies on the content being harmless: the type is the recorded one
 * and never sniffed, the response is sandboxed with nothing allowed, and only
 * images are shown inline; PDFs and text are downloads on any browser
 * surface. Nothing is cached, because access is rechecked on every read.
 */

import { extForContentType } from './sniff.js';
import { isCanonicalId } from './layout.js';

export type UploadResponseHeaders = Record<string, string>;

/**
 * Headers for serving an upload of the recorded content type, or null for
 * any type the sniffer never records or an id that is not canonical. The
 * download name is built from the server's id and the recorded type; nothing
 * the client sent appears in it.
 */
export function uploadResponseHeaders(
  uploadId: string,
  contentType: string
): UploadResponseHeaders | null {
  const ext = extForContentType(contentType);
  if (!ext || !isCanonicalId(uploadId)) return null;
  const inline = ext === 'jpg' || ext === 'png';
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${uploadId}.${ext}"`,
  };
}
