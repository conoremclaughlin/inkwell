/** CLI compatibility: process cleanup is a CLI policy, not a hosted-session default. */
import { rmSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createToolImageCapture } from '@inklabs/shared/node-host';
export {
  INLINE_IMAGE_MIME,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_SIDE,
  sniffImageType,
  readImageInfo,
  estimateImageTokens,
  imagesToDeliver,
  type ImageInfo,
  type ImageDelivery,
  type CaptureOptions,
  type ContextImage,
} from '@inklabs/shared/node-host';
const legacyCapture = createToolImageCapture();
export const { captureToolImages, takeCapturedImages, withImageCapture } = legacyCapture;

export function processImageCacheDir(prefix = 'ink-tool-images-'): () => Promise<string> {
  let dir: Promise<string> | undefined;
  return () => {
    dir ??= mkdtemp(join(tmpdir(), prefix)).then((made) => {
      process.once('exit', () => {
        try {
          rmSync(made, { recursive: true, force: true });
        } catch {
          // Best effort: the OS clears its temp directory in time.
        }
      });
      return made;
    });
    return dir;
  };
}
