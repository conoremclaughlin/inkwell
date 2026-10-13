/**
 * Bounded PDF extraction, isolated from every provider session. The module
 * path shim works in both builds; dependency lookup never uses a session's
 * checkout or the host's cwd.
 */
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { dirname } from 'path';
import { pdfExtractorModulePath } from './pdf-extractor-path.cjs';

export const MAX_DOCUMENT_TEXT_CHARS = 100_000;
export const PDF_EXTRACT_TIMEOUT_MS = 20_000;
export interface ExtractedPdf {
  text: string;
  pages: number;
  total: number;
}
export type PdfExtractor = (
  bytes: Buffer,
  maxPages: number,
  timeoutMs: number
) => Promise<ExtractedPdf | null> | ExtractedPdf | null;

const PDF_EXTRACT_SCRIPT = `
const { PDFParse } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false });
  try {
    const result = await parser.getText({ first: Number(process.argv[2]) });
    // result.text carries the page markers pdf-parse appends ('-- 1 of 1 --'),
    // which help the model cite a page but which a blank PDF has as well. So
    // it counts as text only when one of the pages has some (Lumen, #775).
    const hasText = result.pages.some((page) => page.text.trim() !== '');
    const text = hasText ? result.text : '';
    process.stdout.write(JSON.stringify({ text: text.slice(0, Number(process.argv[3])), total: result.total }));
  } finally {
    await parser.destroy();
  }
});`;

/** No shell, credentials, session config, or synchronous parser work. */
export async function extractPdfText(
  bytes: Buffer,
  maxPages: number,
  timeoutMs: number = PDF_EXTRACT_TIMEOUT_MS
): Promise<ExtractedPdf | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  let entry: string;
  try {
    entry = createRequire(pdfExtractorModulePath).resolve('pdf-parse');
  } catch {
    return null;
  }
  return new Promise<ExtractedPdf | null>((resolve) => {
    const child = execFile(
      process.execPath,
      ['-e', PDF_EXTRACT_SCRIPT, entry, String(maxPages), String(MAX_DOCUMENT_TEXT_CHARS + 1)],
      {
        env: {},
        cwd: dirname(pdfExtractorModulePath),
        timeout: Math.ceil(timeoutMs),
        killSignal: 'SIGKILL',
        // Up to six bytes per JSON-escaped character, plus the envelope.
        maxBuffer: 6 * (MAX_DOCUMENT_TEXT_CHARS + 1) + 64 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { text?: unknown; total?: unknown };
          if (typeof parsed.text !== 'string' || typeof parsed.total !== 'number') {
            resolve(null);
            return;
          }
          resolve({
            text: parsed.text,
            pages: Math.min(maxPages, parsed.total),
            total: parsed.total,
          });
        } catch {
          resolve(null);
        }
      }
    );
    // An early parser exit can close stdin before all bytes are written.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(bytes);
  }).catch(() => null);
}
