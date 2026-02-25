import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioTranscriptionService } from './audio-transcription';

describe('AudioTranscriptionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when disabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const svc = new AudioTranscriptionService({
      enabled: false,
      apiKey: 'test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      timeoutMs: 5000,
      maxBytes: 1024,
      maxChars: 1000,
    });

    const result = await svc.transcribe({
      filePath: '/tmp/does-not-matter.ogg',
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('transcribes audio file via OpenAI endpoint', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pcp-audio-test-'));
    const filePath = path.join(tmpDir, 'note.ogg');
    await writeFile(filePath, Buffer.from('test-audio-bytes'));

    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return {
            ok: true,
            json: async () => ({ text: 'hello from transcript' }),
          } as unknown as Response;
        })
      );

      const svc = new AudioTranscriptionService({
        enabled: true,
        apiKey: 'test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini-transcribe',
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
        maxChars: 1000,
      });

      const result = await svc.transcribe({
        filePath,
        contentType: 'audio/ogg',
      });

      expect(result).toBe('hello from transcript');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
