import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { TextToSpeechService } from './text-to-speech';

describe('TextToSpeechService', () => {
  it('returns undefined when disabled', async () => {
    const service = new TextToSpeechService({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'opus',
      timeoutMs: 5000,
      maxChars: 1000,
      providers: ['openai'],
    });

    const result = await service.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns synthesized audio from provider chain', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pcp-tts-test-'));
    const filePath = path.join(tmpDir, 'reply.ogg');
    await writeFile(filePath, Buffer.from('audio-bytes'));

    try {
      const cleanup = async () => {
        await rm(tmpDir, { recursive: true, force: true });
      };

      const service = new TextToSpeechService(
        {
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
          format: 'opus',
          timeoutMs: 5000,
          maxChars: 1000,
          providers: ['custom'],
        },
        [
          {
            name: 'custom',
            synthesize: async () => ({
              filePath,
              contentType: 'audio/ogg',
              filename: 'reply.ogg',
              cleanup,
            }),
          },
        ]
      );

      const result = await service.synthesize({ text: 'hello from tts' });
      expect(result).toBeDefined();
      expect(result?.filePath).toBe(filePath);
      expect(result?.contentType).toBe('audio/ogg');
      expect(result?.filename).toBe('reply.ogg');
      await result?.cleanup();
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true });
      throw error;
    }
  });
});
