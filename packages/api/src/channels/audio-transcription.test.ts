import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { AudioTranscriptionService } from './audio-transcription';
import { ParakeetTranscriptionProvider, CliTranscriptionProvider } from './audio';

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
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-audio-test-'));
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

  it('falls back to CLI provider when OpenAI transcription fails', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-audio-cli-test-'));
    const filePath = path.join(tmpDir, 'note.ogg');
    await writeFile(filePath, Buffer.from('transcript from cli provider'));

    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return {
            ok: false,
            json: async () => ({}),
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
        providers: ['openai', 'cli'],
        cliCommand: 'cat {input}',
      });

      const result = await svc.transcribe({
        filePath,
        contentType: 'audio/ogg',
      });

      expect(result).toBe('transcript from cli provider');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls through parakeet (binary unavailable) to the CLI provider', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-audio-parakeet-test-'));
    const filePath = path.join(tmpDir, 'note.ogg');
    await writeFile(filePath, Buffer.from('cli transcript after parakeet skip'));

    try {
      // Inject providers directly so the parakeet binary probe is
      // deterministic on machines that DO have parakeet-mlx installed
      const svc = new AudioTranscriptionService(
        {
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini-transcribe',
          timeoutMs: 5000,
          maxBytes: 1024 * 1024,
          maxChars: 1000,
        },
        [
          new ParakeetTranscriptionProvider({
            binaryCandidates: ['/nonexistent/parakeet-mlx'],
          }),
          new CliTranscriptionProvider('cat {input}', 5000),
        ]
      );

      const result = await svc.transcribe({ filePath, contentType: 'audio/ogg' });
      expect(result).toBe('cli transcript after parakeet skip');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
