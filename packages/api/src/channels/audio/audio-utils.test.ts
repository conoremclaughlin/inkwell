import { mkdtemp, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createTempAudioPath, removeTempAudioDir } from './audio-utils';

describe('removeTempAudioDir', () => {
  it('removes a pcp-tts-* directory under os.tmpdir()', async () => {
    const filePath = await createTempAudioPath('mp3');
    await writeFile(filePath, 'test');

    const dir = path.dirname(filePath);
    expect((await stat(dir)).isDirectory()).toBe(true);

    await removeTempAudioDir(filePath);

    await expect(stat(dir)).rejects.toThrow();
  });

  it('does not remove a non-pcp-tts directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'other-prefix-'));
    const filePath = path.join(dir, 'audio.mp3');
    await writeFile(filePath, 'test');

    await removeTempAudioDir(filePath);

    expect((await stat(dir)).isDirectory()).toBe(true);

    const { rm } = await import('fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('no-ops on a relative path', async () => {
    await removeTempAudioDir('reply.mp3');
  });
});
