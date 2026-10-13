/**
 * Images Returned by Tools
 *
 * A tool result reaches the model as TEXT: the agent loop JSON-stringifies it
 * into the next continuation (see renderToolResult in @inklabs/shared/runtime).
 * That is right for everything except an image. Pi's `read` answers an image
 * file with a base64 content block, and stringified, a 512 KB, 1536x1024 JPEG
 * came to 682,498 characters. The relay cuts at its 200 KB budget, so what the
 * model received was 200K characters of a truncated JPEG and never a picture.
 *
 * So an image block never travels as text. `captureToolImages` takes the
 * bytes out of the result, writes them to a content-addressed file, and leaves
 * a small descriptor in their place: what it is, how big, and roughly what it
 * costs. The host then delivers the file as a real image block on the next
 * backend spawn (claude: stream-json content; codex: `--image=`), and records
 * it on the ledger entry, so `list_context` counts it and `evict_context`
 * removes it.
 *
 * The descriptor never carries the cache path. The model has no use for it,
 * and a path it cannot `read` (the cache sits outside the working directory)
 * invites a call that will only be refused. The host reads the captured
 * images through `takeCapturedImages`, keyed by the result object.
 */

import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { InkToolCallResult } from '../runtime/tool-result.js';
import type { ContextImage } from '../runtime/context-image.js';
export type { ContextImage } from '../runtime/context-image.js';
import type { LocalToolDispatcher } from '../runtime/tool-dispatch.js';

/** The types a provider accepts as an inline image block (the Anthropic API set). */
export {
  INLINE_IMAGE_MIME,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_SIDE,
} from '../runtime/context-media.js';
import { MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGE_SIDE } from '../runtime/context-media.js';

export interface ImageInfo {
  mimeType: string;
  width: number;
  height: number;
}

/**
 * The image type named by a file's leading bytes, or null.
 *
 * Magic bytes rather than the extension: a `.png` that is really a JPEG
 * should be sent as a JPEG, and a text file renamed `.jpg` is not an image at
 * all. Needs at most the first 16 bytes.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** JPEG start-of-frame markers — the segments that carry the dimensions. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1]!;
    // Fill bytes: a run of 0xFF before the marker proper.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b1 = buf[22]!;
    const b2 = buf[23]!;
    const b3 = buf[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | buf[21]!),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return null;
}

/**
 * Type and pixel dimensions from an image's own header, or null when the
 * bytes are not a PNG, JPEG, GIF or WebP we can measure.
 *
 * Dimensions are what the token estimate needs, and Pi's `read` reports them
 * only when it resized. Reading them from the bytes that will actually be
 * delivered means the estimate describes what the model receives.
 */
export function readImageInfo(buf: Buffer): ImageInfo | null {
  const mimeType = sniffImageType(buf);
  if (!mimeType) return null;
  let dims: { width: number; height: number } | null = null;
  if (mimeType === 'image/png') {
    if (buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR') {
      dims = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } else if (mimeType === 'image/gif') {
    if (buf.length >= 10) dims = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  } else if (mimeType === 'image/jpeg') {
    dims = jpegDimensions(buf);
  } else {
    dims = webpDimensions(buf);
  }
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;
  return { mimeType, ...dims };
}

/** Anthropic's published estimate for an image block: width × height ÷ 750. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Whether the backend this result is going to can receive an image, and if
 * not, why — the reason is what the model is told in the image's place.
 */
export type ImageDelivery = { deliverable: true } | { deliverable: false; reason: string };

export interface CaptureOptions {
  /** Where captured images are written; asked only when there is one to write. */
  cacheDir: () => Promise<string>;
  /** Asked per result: a session can switch backend between calls. */
  delivery: () => ImageDelivery;
  /** Retention failure falls back to live delivery, never a lifetime image limit. */
  retainImage?: (bytes: Buffer) => Promise<ContextImage | undefined>;
}

interface ImageBlock {
  type: 'image';
  data: string;
  mimeType?: string;
}

function isImageBlock(block: unknown): block is ImageBlock {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'image' &&
    typeof (block as { data?: unknown }).data === 'string'
  );
}

function notShown(reason: string): { type: 'text'; text: string } {
  return { type: 'text', text: `[image not shown: ${reason}]` };
}

async function cacheImage(bytes: Buffer, info: ImageInfo, cacheDir: string): Promise<ContextImage> {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const path = join(cacheDir, `${hash}.${EXTENSION_BY_MIME[info.mimeType] ?? 'img'}`);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  try {
    // Exclusive create: the name is the content, so an existing file already
    // holds these exact bytes and there is nothing to rewrite.
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return {
    ref: `img:${hash}`,
    path,
    mimeType: info.mimeType,
    width: info.width,
    height: info.height,
    approxTokens: estimateImageTokens(info.width, info.height),
  };
}

/**
 * The result with every image block's bytes taken out.
 *
 * A deliverable image becomes a descriptor naming its ref, type, size and
 * token estimate; the bytes go to the cache and are handed to the host through
 * `takeCapturedImages`. Anything else becomes a line saying the image was not
 * shown and why — an undeliverable backend, a type or size the provider would
 * refuse, or bytes that are not the image they claim to be. Either way no
 * base64 is left in what the model reads.
 *
 * A result with no image blocks is returned as the same object.
 */
async function captureToolImages(
  capturedByResult: WeakMap<object, ContextImage[]>,
  result: InkToolCallResult,
  opts: CaptureOptions
): Promise<InkToolCallResult> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some(isImageBlock)) return result;

  const delivery = opts.delivery();
  const captured: ContextImage[] = [];
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!isImageBlock(block)) {
      blocks.push(block);
      continue;
    }
    if (!delivery.deliverable) {
      blocks.push(notShown(delivery.reason));
      continue;
    }
    const bytes = Buffer.from(block.data, 'base64');
    const info = readImageInfo(bytes);
    if (!info) {
      blocks.push(notShown(`the data is not a PNG, JPEG, GIF or WebP image that can be measured`));
      continue;
    }
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
      blocks.push(
        notShown(
          `${(bytes.length / (1024 * 1024)).toFixed(1)} MB is over the ${(MAX_INLINE_IMAGE_BYTES / (1024 * 1024)).toFixed(2)} MB inline limit; save it to a file and use view_image, which downscales`
        )
      );
      continue;
    }
    if (info.width > MAX_INLINE_IMAGE_SIDE || info.height > MAX_INLINE_IMAGE_SIDE) {
      blocks.push(
        notShown(
          `${info.width}x${info.height} is over the ${MAX_INLINE_IMAGE_SIDE}px inline limit; save it to a file and use view_image, which downscales`
        )
      );
      continue;
    }
    const image =
      (await opts.retainImage?.(bytes)) ?? (await cacheImage(bytes, info, await opts.cacheDir()));
    captured.push(image);
    blocks.push({
      type: 'image',
      image: image.ref,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      approxTokens: image.approxTokens,
      shown: 'attached to the message carrying this result, as an image',
    });
  }

  const rewritten = { ...result, content: blocks } as InkToolCallResult;
  if (captured.length > 0) capturedByResult.set(rewritten, captured);
  return rewritten;
}

/**
 * A dispatcher whose every result has passed through `captureToolImages`.
 *
 * Wrapped around the whole dispatcher rather than one tool, because an image
 * can come back from any of them — `read`, `view_image`, or an Inkwell tool —
 * and the relay stringifies all of them the same way.
 */
function withImageCapture(
  capturedByResult: WeakMap<object, ContextImage[]>,
  dispatch: LocalToolDispatcher,
  opts: CaptureOptions
): LocalToolDispatcher {
  return async (tool, args, ctx) =>
    captureToolImages(capturedByResult, await dispatch(tool, args, ctx), opts);
}

/**
 * The images a spawn must carry: every one the ledger holds that the target
 * provider session has not been given yet, in ledger order.
 *
 * `delivered` is keyed by provider session. A resume sends only what is new;
 * a seed (a fresh or re-seeded session) finds nothing recorded for its id and
 * sends everything, because the ledger it is seeded from still lists those
 * images. A stateless spawn passes no session and always gets them all.
 */
export function imagesToDeliver(
  ledgerImages: readonly ContextImage[],
  delivered: { sessionId: string | undefined; refs: ReadonlySet<string> },
  targetSessionId: string | undefined
): ContextImage[] {
  const seen = new Set<string>();
  const alreadyThere =
    targetSessionId !== undefined && delivered.sessionId === targetSessionId
      ? delivered.refs
      : new Set<string>();
  const out: ContextImage[] = [];
  for (const image of ledgerImages) {
    if (seen.has(image.ref) || alreadyThere.has(image.ref)) continue;
    seen.add(image.ref);
    out.push(image);
  }
  return out;
}

/** One capture ledger per session host; another host cannot read its descriptors. */
export function createToolImageCapture() {
  const capturedByResult = new WeakMap<object, ContextImage[]>();
  return {
    captureToolImages: (result: InkToolCallResult, opts: CaptureOptions) =>
      captureToolImages(capturedByResult, result, opts),
    takeCapturedImages(result: unknown): ContextImage[] {
      if (!result || typeof result !== 'object') return [];
      return capturedByResult.get(result) ?? [];
    },
    withImageCapture: (dispatch: LocalToolDispatcher, opts: CaptureOptions) =>
      withImageCapture(capturedByResult, dispatch, opts),
  };
}
