import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

export function extensionForFormat(format: string): string {
  switch (format) {
    case 'mp3':
      return 'mp3';
    case 'wav':
      return 'wav';
    case 'pcm':
      return 'pcm';
    case 'flac':
      return 'flac';
    case 'opus':
      return 'ogg';
    default:
      return 'ogg';
  }
}

export function contentTypeForFormat(format: string): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/L16';
    case 'flac':
      return 'audio/flac';
    case 'opus':
      return 'audio/ogg';
    default:
      return 'audio/ogg';
  }
}

export async function createTempAudioPath(extension: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  return path.join(dir, `${randomUUID()}.${extension}`);
}

const TMP_PREFIX = 'ink-tts-';

export async function removeTempAudioDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpRoot = os.tmpdir();
  if (
    path.isAbsolute(dir) &&
    path.dirname(dir) === tmpRoot &&
    path.basename(dir).startsWith(TMP_PREFIX)
  ) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
