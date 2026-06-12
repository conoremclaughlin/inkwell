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

  it('builds the mlx provider with no API key or cliCommand required', () => {
    // Unlike 'cli' (needs cliCommand to be constructed), 'mlx' is always
    // constructible — it self-disables at call time when mlx-audio isn't
    // installed. This is what makes on-device TTS zero-config.
    const cliOnly = new TextToSpeechService({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'opus',
      timeoutMs: 5000,
      maxChars: 1000,
      providers: ['cli'], // no cliCommand → no providers → disabled
    });
    expect(cliOnly.isEnabled()).toBe(false);

    const mlxOnly = new TextToSpeechService({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'opus',
      timeoutMs: 5000,
      maxChars: 1000,
      providers: ['mlx'],
    });
    expect(mlxOnly.isEnabled()).toBe(true);
  });

  it('builds elevenlabs provider from config', () => {
    const service = new TextToSpeechService({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'opus',
      timeoutMs: 5000,
      maxChars: 1000,
      providers: ['elevenlabs', 'openai'],
      elevenlabsApiKey: 'el-test-key',
    });

    expect(service.isEnabled()).toBe(true);
  });

  it('skips elevenlabs when no API key and falls through', async () => {
    const service = new TextToSpeechService({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'opus',
      timeoutMs: 5000,
      maxChars: 1000,
      providers: ['elevenlabs'],
    });

    const result = await service.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns synthesized audio from provider chain', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-tts-test-'));
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
