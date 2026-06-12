/**
 * Live e2e for the MLX TTS provider — spawns the REAL mlx-audio CLI with
 * the real Qwen3-TTS model and re-encodes with the real ffmpeg. Proves
 * the chain the server uses for Telegram voice replies:
 *
 *   text → mlx_audio.tts.generate (Qwen3-TTS) → wav → ffmpeg → ogg/opus
 *
 * Requirements: Apple Silicon, `pip install mlx-audio`, ffmpeg, and the
 * model weights (downloaded automatically on first run, ~700MB).
 *
 * Gated behind INK_LIVE_TESTS=1 — run via `yarn test:live`.
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'fs/promises';

import { MlxAudioTextToSpeechProvider } from './mlx-tts.js';

const LIVE = process.env.INK_LIVE_TESTS === '1';

describe.skipIf(!LIVE)('MlxAudioTextToSpeechProvider (live)', () => {
  it(
    'synthesizes real speech and encodes a Telegram-ready ogg/opus voice note',
    { timeout: 600_000 },
    async () => {
      const provider = new MlxAudioTextToSpeechProvider({ format: 'opus' });

      const python = await provider.resolvePython();
      if (!python) {
        // Machine without mlx-audio — live env requirement not met.
        expect.fail('mlx-audio is not installed (pip install mlx-audio)');
      }

      const result = await provider.synthesize({
        text: 'This is a live test of on-device speech synthesis for Inkwell voice replies.',
      });

      expect(result).toBeDefined();
      expect(result!.contentType).toBe('audio/ogg');
      expect(result!.filename).toBe('reply.ogg');

      const details = await stat(result!.filePath);
      // A real ~5s opus voice note lands well above this floor; an empty
      // or header-only file would not.
      expect(details.size).toBeGreaterThan(5_000);

      // OGG container magic — proves ffmpeg actually re-encoded.
      const header = await readFile(result!.filePath);
      expect(header.subarray(0, 4).toString('ascii')).toBe('OggS');

      await result!.cleanup();
    }
  );

  it('synthesizes German through the same default model', { timeout: 600_000 }, async () => {
    const provider = new MlxAudioTextToSpeechProvider({ format: 'wav' });
    const result = await provider.synthesize({
      text: 'Hallo! Dies ist ein Live-Test der deutschen Sprachausgabe.',
    });
    expect(result).toBeDefined();
    const details = await stat(result!.filePath);
    expect(details.size).toBeGreaterThan(50_000);
    await result!.cleanup();
  });
});
