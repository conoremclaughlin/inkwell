/**
 * view_image — put an image file in front of the model, as an image.
 *
 * Until 2026-09-30 an SB in this runtime could relay a screenshot without ever
 * seeing it: an image a person attached to a turn arrived as an image, but
 * there was no way to open one the SB was pointed at.
 *
 * This tool decides WHAT may be viewed and prepares it; `captureToolImages`
 * (tool-images.ts) decides how it reaches the model, as it does for an image
 * from any other tool. The two stay separate so `read` on an image in the
 * working directory takes the same delivery path and cannot drift from it.
 *
 * What may be viewed: an image file under the working directory or under
 * `~/.ink/files`, where Inkwell keeps downloaded attachments and the SBs'
 * screenshots. Containment is judged on the real path, so neither `..` nor a
 * symlink leads out of those roots. `read` stays scoped to the working
 * directory; this tool reaches one directory further, and only for images.
 */

import { open, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { assertContainedPath } from '@inklabs/shared';
import type { InkToolCallResult } from '../lib/ink-client.js';
import { initPiTools } from './pi-tools.js';
import {
  estimateImageTokens,
  readImageInfo,
  sniffImageType,
  type ImageInfo,
} from './tool-images.js';

export const VIEW_IMAGE_TOOL = 'view_image';

/**
 * Largest file this tool will open: 20 MB. Enough for any screenshot or photo
 * worth looking at; beyond it the decode itself is the cost, before any
 * downscale can help.
 */
export const MAX_VIEW_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

/** The directories an image may be viewed from, most specific reason first. */
export function viewImageRoots(cwd: string): string[] {
  return [cwd, join(homedir(), '.ink', 'files')];
}

/** Reads and, when needed, downscales an image — Pi's `read`, in production. */
export type ImageReader = (
  absolutePath: string,
  signal?: AbortSignal
) => Promise<InkToolCallResult>;

export interface ViewImageOptions {
  cwd: string;
  /** Defaults to viewImageRoots(cwd). */
  roots?: string[];
  maxFileBytes?: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to Pi's `read`. */
  readImage?: ImageReader;
}

function refuse(text: string): InkToolCallResult {
  return { content: [{ type: 'text', text }], isError: true, success: false } as InkToolCallResult;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function isContainedIn(absolutePath: string, root: string): boolean {
  try {
    assertContainedPath(absolutePath, root, VIEW_IMAGE_TOOL);
    return true;
  } catch {
    return false;
  }
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const defaultReadImage =
  (cwd: string): ImageReader =>
  async (absolutePath, signal) => {
    const read = (await initPiTools(cwd)).get('read');
    if (!read) throw new Error('Pi read tool is unavailable');
    const result = await read.execute(
      `pi-view-image-${Date.now()}`,
      { path: absolutePath },
      signal
    );
    return { content: result.content, success: true } as InkToolCallResult;
  };

function describeSize(info: ImageInfo): string {
  return `${info.width}x${info.height}`;
}

/** The image block Pi's read returned, and the dimensions it actually has. */
function deliveredImage(
  result: InkToolCallResult
): { block: Record<string, unknown>; info: ImageInfo } | null {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'image' || typeof block.data !== 'string') continue;
    const info = readImageInfo(Buffer.from(block.data, 'base64'));
    if (info) return { block, info };
  }
  return null;
}

function readerText(result: InkToolCallResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

export async function viewImage(
  args: Record<string, unknown>,
  opts: ViewImageOptions
): Promise<InkToolCallResult> {
  const raw = args.path ?? args.file_path ?? args.filePath;
  if (typeof raw !== 'string' || !raw.trim()) {
    return refuse('view_image needs `path`: the image file to look at.');
  }

  const roots = opts.roots ?? viewImageRoots(opts.cwd);
  const requested = resolve(opts.cwd, expandHome(raw.trim()));
  if (!roots.some((root) => isContainedIn(requested, root))) {
    return refuse(
      `${raw} is outside the directories view_image may open: ${roots.join(', ')}. ` +
        'Copy the image into one of them first if it should be viewable.'
    );
  }

  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    return refuse(`${raw} does not exist.`);
  }

  const st = await stat(real);
  if (!st.isFile()) return refuse(`${raw} is not a regular file.`);
  const maxBytes = opts.maxFileBytes ?? MAX_VIEW_IMAGE_FILE_BYTES;
  if (st.size > maxBytes) {
    return refuse(
      `${raw} is ${(st.size / (1024 * 1024)).toFixed(1)} MB, over view_image's ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit. ` +
        'Make a smaller copy first (for example `sips -Z 2000 <in> --out <out>` in bash) and view that.'
    );
  }

  const head = await readHead(real, 64 * 1024);
  const mimeType = sniffImageType(head);
  if (!mimeType) {
    return refuse(
      `${raw} is not a PNG, JPEG, GIF or WebP image (judged by its contents, not its name). Use read for text files.`
    );
  }
  // The header is usually in the first 64 KB; a JPEG with a large EXIF or ICC
  // block can put its dimensions later, and then only the delivered size is
  // reported.
  const original = readImageInfo(head);

  const readImage = opts.readImage ?? defaultReadImage(opts.cwd);
  const read = await readImage(real, opts.signal);
  const delivered = deliveredImage(read);
  if (!delivered) {
    const why = readerText(read).trim();
    return refuse(
      `${raw} could not be prepared for viewing${why ? `: ${why}` : '.'} Make a smaller copy and view that.`
    );
  }

  const { info } = delivered;
  const tokens = estimateImageTokens(info.width, info.height);
  const downscaled =
    original && (original.width !== info.width || original.height !== info.height)
      ? ` Downscaled from ${describeSize(original)} to ${describeSize(info)} to fit the inline image limit (2000px, 4.5 MB); small text may be unreadable at this size. For detail, crop the region you need into a new file and view that.`
      : '';
  const text =
    `${raw} (${info.mimeType}, ${describeSize(info)}, ~${tokens.toLocaleString()} tokens).` +
    downscaled +
    ' It stays in your context until you evict it; list_context shows it under source local-tool.';

  return {
    content: [{ type: 'text', text }, delivered.block],
    success: true,
  } as InkToolCallResult;
}
