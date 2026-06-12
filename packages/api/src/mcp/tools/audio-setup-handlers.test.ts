import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleSetupAudioTranscription,
  setupAudioTranscriptionSchema,
  transcribeSavedAudio,
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

  it('install fails (not false-success) when model warmup fails', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      // The warmup path only runs on Apple Silicon; the refusal branch
      // above covers other platforms.
      return;
    }
    // A binary that resolves (--help passes, so the pip step is skipped)
    // but exits nonzero on transcription — the broken-model-download
    // failure mode the warmup exists to surface.
    const dir = await mkdtemp(join(tmpdir(), 'ink-warmup-test-'));
    const fakeBin = join(dir, 'fake-parakeet');
    await writeFile(
      fakeBin,
      '#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\necho "model download failed" >&2\nexit 3\n'
    );
    await chmod(fakeBin, 0o755);
    process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN = fakeBin;
    try {
      const result = (await handleSetupAudioTranscription({ action: 'install' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('warmup failed');
      expect(String(result.error)).toContain('model download failed');
    } finally {
      delete process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('transcribeSavedAudio', () => {
  it('requires a filePath', async () => {
    const result = await transcribeSavedAudio(undefined);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('filePath is required');
  });

  it('rejects paths outside the allowed root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ink-audio-root-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'ink-audio-outside-'));
    const outsideFile = join(outsideDir, 'voice.ogg');
    await writeFile(outsideFile, Buffer.from('audio'));
    try {
      const result = await transcribeSavedAudio(outsideFile, { allowedRoot: rootDir });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('must live under');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects .. traversal that escapes the root', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ink-audio-trav-'));
    const rootDir = join(baseDir, 'files');
    await mkdir(rootDir);
    const secret = join(baseDir, 'secret.ogg');
    await writeFile(secret, Buffer.from('audio'));
    try {
      const result = await transcribeSavedAudio(join(rootDir, '..', 'secret.ogg'), {
        allowedRoot: rootDir,
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('must live under');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('reports a clear error for missing files', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ink-audio-root-'));
    try {
      const result = await transcribeSavedAudio(join(rootDir, 'nope.ogg'), {
        allowedRoot: rootDir,
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('File not found');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns the transcript with an untrusted-content note on success', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ink-audio-root-'));
    const audioPath = join(rootDir, 'voice.ogg');
    await writeFile(audioPath, Buffer.from('audio'));
    try {
      const result = await transcribeSavedAudio(audioPath, {
        allowedRoot: rootDir,
        service: { transcribe: async () => 'hallo wren, kannst du mich hören?' },
      });
      expect(result.success).toBe(true);
      expect(result.transcript).toBe('hallo wren, kannst du mich hören?');
      expect(String(result.note)).toContain('untrusted');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('explains when no provider produces a transcript', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ink-audio-root-'));
    const audioPath = join(rootDir, 'voice.ogg');
    await writeFile(audioPath, Buffer.from('audio'));
    try {
      const result = await transcribeSavedAudio(audioPath, {
        allowedRoot: rootDir,
        service: { transcribe: async () => undefined },
      });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('status');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
