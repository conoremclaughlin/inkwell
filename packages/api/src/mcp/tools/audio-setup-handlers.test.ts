import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleSetupAudioTranscription,
  setupAudioTranscriptionSchema,
} from './audio-setup-handlers.js';

describe('setup_audio_transcription', () => {
  it('rejects unknown actions at the schema boundary', () => {
    expect(() => setupAudioTranscriptionSchema.parse({ action: 'destroy' })).toThrow();
    expect(() => setupAudioTranscriptionSchema.parse({})).toThrow();
  });

  it('status reports platform support, availability, and guidance', async () => {
    const result = (await handleSetupAudioTranscription({ action: 'status' })) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(true);
    expect(typeof result.platformSupported).toBe('boolean');
    expect(typeof result.parakeetInstalled).toBe('boolean');
    expect(typeof result.pipAvailable).toBe('boolean');
    expect(typeof result.note).toBe('string');
    expect(Array.isArray(result.binaryCandidates)).toBe(true);
    // The guidance must steer the SB correctly in every configuration
    if (result.parakeetInstalled) {
      expect(result.note).toContain('installed');
    } else if (result.platformSupported) {
      expect(result.note).toContain('consent');
    } else {
      expect(result.note).toContain('OPENAI_API_KEY');
    }
  });

  it('install refuses on unsupported platforms', async () => {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      // Can't simulate a foreign platform without heavier mocking — the
      // refusal branch is exercised on CI's linux runners.
      return;
    }
    const result = (await handleSetupAudioTranscription({ action: 'install' })) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Apple Silicon');
  });
});
