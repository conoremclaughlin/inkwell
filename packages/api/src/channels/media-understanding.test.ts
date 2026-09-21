import { existsSync } from 'fs';
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

import { MediaUnderstandingService } from './media-understanding';

describe('MediaUnderstandingService', () => {
  it('returns undefined when disabled', async () => {
    const service = new MediaUnderstandingService({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      timeoutMs: 5000,
      maxBytes: 1024,
      maxChars: 200,
      providers: ['openai'],
    });

    const result = await service.analyze({
      type: 'image',
      filePath: '/tmp/no-file.jpg',
    });

    expect(result).toBeUndefined();
  });

  it('uses provider chain and truncates analysis output', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-media-analysis-test-'));
    const filePath = path.join(tmpDir, 'image.png');
    await writeFile(filePath, Buffer.from('fake image bytes'));

    try {
      const service = new MediaUnderstandingService(
        {
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4.1-mini',
          timeoutMs: 5000,
          maxBytes: 1024 * 1024,
          maxChars: 12,
          providers: ['custom-a', 'custom-b'],
        },
        [
          {
            name: 'custom-a',
            analyze: async () => undefined,
          },
          {
            name: 'custom-b',
            analyze: async () => 'This is a very long analysis output',
          },
        ]
      );

      const result = await service.analyze({
        type: 'image',
        filePath,
        contentType: 'image/png',
      });

      expect(result).toBe('This is a ve…');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// Call-site coverage for the CLI provider. The substitution helper has its own
// suite; these prove this class reaches it and forwards `env` to the child.
describe('MediaUnderstandingService — CLI provider wiring', () => {
  function cliService(imageCommand: string) {
    return new MediaUnderstandingService({
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
      maxChars: 500,
      providers: ['cli'],
      imageCliCommand: imageCommand,
    });
  }

  it('delivers the input path and mime type to the command', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-media-cli-'));
    const filePath = path.join(tmpDir, 'an image.png');
    await writeFile(filePath, Buffer.from('fake image bytes'));

    const result = await cliService('printf "%s|%s" {input} {mime}').analyze({
      type: 'image',
      filePath,
      contentType: 'image/png',
    });

    expect(result).toBe(`${filePath}|image/png`);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('treats a hostile content type as text, not as a command', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ink-media-cli-'));
    const filePath = path.join(tmpDir, 'image.png');
    const marker = path.join(tmpDir, 'executed');
    await writeFile(filePath, Buffer.from('fake image bytes'));

    const result = await cliService('printf %s {mime}').analyze({
      type: 'image',
      filePath,
      contentType: `$(printf pwned > ${marker})`,
    });

    expect(existsSync(marker)).toBe(false);
    expect(result).toBe(`$(printf pwned > ${marker})`);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
