/**
 * read_pdf — extract text from PDF files saved under ~/.ink/files.
 *
 * Primary use case: email attachments downloaded via download_email_attachment
 * land in ~/.ink/files/gmail/ as raw files. Agents that lack native PDF
 * reading (non-Claude-Code runtimes) can use this tool to extract text.
 *
 * Paths are confined to ~/.ink/files (resolved through symlinks) — this tool
 * exists to read channel media, not to probe arbitrary disk paths.
 */

import { z } from 'zod';
import { readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { logger } from '../../utils/logger';

export const readPdfSchema = z.object({
  filePath: z
    .string()
    .describe(
      'Absolute path to the PDF file under ~/.ink/files (e.g., from download_email_attachment output).'
    ),
  maxPages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum number of pages to extract (default: all). Use for large documents to limit output size.'
    ),
});

function allowedRoot(): string {
  return join(homedir(), '.ink', 'files');
}

interface ReadPdfDeps {
  allowedRoot?: string;
}

export async function handleReadPdf(args: unknown, deps: ReadPdfDeps = {}) {
  const { filePath, maxPages } = readPdfSchema.parse(args);

  const root = deps.allowedRoot ?? allowedRoot();
  const rootReal = await realpath(root).catch(() => resolve(root));
  let fileReal: string;
  try {
    fileReal = await realpath(resolve(filePath));
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }
  if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
    return {
      success: false,
      error: `File must live under ${root} (the channel media download directory).`,
    };
  }
  const details = await stat(fileReal).catch(() => undefined);
  if (!details?.isFile()) {
    return { success: false, error: `Not a regular file: ${filePath}` };
  }

  if (!fileReal.toLowerCase().endsWith('.pdf')) {
    return { success: false, error: `File does not appear to be a PDF: ${filePath}` };
  }

  try {
    const { PDFParse } = await import('pdf-parse');
    const buffer = await readFile(fileReal);
    const uint8 = new Uint8Array(buffer);

    const parser = new PDFParse(uint8);
    try {
      const textResult = await parser.getText(maxPages ? { first: maxPages } : {});
      const info = await parser.getInfo();

      logger.info('PDF parsed', {
        filePath: fileReal,
        pages: textResult.total,
        textLength: textResult.text.length,
      });

      return {
        success: true,
        text: textResult.text,
        pages: textResult.pages,
        metadata: {
          totalPages: textResult.total,
          info: info.info,
        },
        note: 'PDF text is extracted content — formatting may be approximate. Tables and complex layouts may not preserve structure perfectly.',
      };
    } finally {
      parser.destroy();
    }
  } catch (err) {
    logger.error('PDF parse failed', { filePath: fileReal, error: err });
    return {
      success: false,
      error: `Failed to parse PDF: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
