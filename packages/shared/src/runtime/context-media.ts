/** Path-free media metadata: pure runtime data, never a file-read capability. */
import type { ContextImage } from './context-image.js';
/**
 * Largest image a tool may put in front of the model, in raw bytes: 3.75 MB,
 * which is the 5 MB base64 ceiling a single image block has at the Anthropic
 * API. Pi's `read` already resizes below this (4.5 MB of base64), so only an
 * image from some other tool can reach it.
 */
export const MAX_INLINE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/**
 * Longest side a tool image may have. 2000 px is the API's per-image limit once
 * a request carries more than 20 images, and a re-seeded session carries every
 * image still on the ledger at once. Pi's `read` resizes to this.
 */
export const MAX_INLINE_IMAGE_SIDE = 2000;
export const INLINE_IMAGE_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
/** Only this path-free shape may be persisted in a log. */
export interface RetainedImageDescriptor {
  version: 1;
  sha256: string;
  byteLength: number;
  mimeType: string;
  width: number;
  height: number;
}

const FIELDS: readonly string[] = [
  'version',
  'sha256',
  'byteLength',
  'mimeType',
  'width',
  'height',
];

export function parseRetainedImageDescriptor(value: unknown): RetainedImageDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const bounded = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= max;
  if (
    Object.keys(v).length !== FIELDS.length ||
    Object.keys(v).some((key) => !FIELDS.includes(key)) ||
    v.version !== 1 ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    !bounded(v.byteLength, MAX_INLINE_IMAGE_BYTES) ||
    typeof v.mimeType !== 'string' ||
    !INLINE_IMAGE_MIME.has(v.mimeType) ||
    !bounded(v.width, MAX_INLINE_IMAGE_SIDE) ||
    !bounded(v.height, MAX_INLINE_IMAGE_SIDE)
  )
    return undefined;
  return {
    version: 1,
    sha256: v.sha256,
    byteLength: v.byteLength,
    mimeType: v.mimeType,
    width: v.width,
    height: v.height,
  };
}

/** Null explicitly means live-only (or legacy), not permission to reread the source. */
export interface RecordedContextImage {
  ref: string;
  retained: RetainedImageDescriptor | null;
}
const validRef = (ref: unknown): ref is string =>
  typeof ref === 'string' && /^img:(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(ref);

export function recordContextImages(images: readonly ContextImage[]): RecordedContextImage[] {
  const records = images
    .slice(0, images.length > 64 ? 63 : 64)
    .map((image) => ({ ref: image.ref, retained: image.retained ?? null }));
  if (images.length > 64) records.push({ ref: 'img:unavailable', retained: null });
  return records;
}

/** Malformed records stay visible as unavailable, but cannot authorize a path. */
export function readRecordedContextImages(value: unknown): RecordedContextImage[] {
  if (value === undefined) return [];
  const invalid = (): RecordedContextImage => ({ ref: 'img:unavailable', retained: null });
  if (!Array.isArray(value) || value.length > 64) return [invalid()];
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).length !== 2 || !validRef(v.ref) || !('retained' in v)) return invalid();
    const retained = parseRetainedImageDescriptor(v.retained);
    return {
      ref: v.ref,
      retained: retained && v.ref === `img:${retained.sha256}` ? retained : null,
    };
  });
}
