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
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pcp-media-analysis-test-'));
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
