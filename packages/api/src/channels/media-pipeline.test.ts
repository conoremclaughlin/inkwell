import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { InboundMessage } from './types';
import { InboundMediaPipeline } from './media-pipeline';

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    body: '[Audio attached]',
    rawBody: '[Audio attached]',
    platform: 'telegram',
    chatType: 'group',
    sender: { id: 'u1', username: 'user', name: 'User' },
    conversationId: 'c1',
    media: [],
    ...overrides,
  };
}

describe('InboundMediaPipeline', () => {
  it('injects audio transcript for placeholder-only body', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pcp-media-pipeline-'));
    const audioPath = path.join(tmpDir, 'voice.ogg');
    await writeFile(audioPath, Buffer.from('audio-bytes'));

    try {
      const pipeline = new InboundMediaPipeline({
        transcribe: async () => 'hey lumen can you help',
      });

      const message = createMessage({
        media: [
          { type: 'audio', path: audioPath, contentType: 'audio/ogg', filename: 'voice.ogg' },
        ],
      });

      await pipeline.preprocess(message);

      expect(message.body).toContain('[Audio transcript]');
      expect(message.body).toContain('hey lumen can you help');
      expect(message.body).toContain('[Security]');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('adds structured media summary for image/video placeholders', async () => {
    const pipeline = new InboundMediaPipeline({
      transcribe: async () => undefined,
    });

    const message = createMessage({
      body: '[Image attached]',
      rawBody: '[Image attached]',
      media: [
        {
          type: 'image',
          path: '/tmp/test-photo.jpg',
          contentType: 'image/jpeg',
          filename: 'photo.jpg',
        },
        {
          type: 'video',
          path: '/tmp/test-clip.mp4',
          contentType: 'video/mp4',
          filename: 'clip.mp4',
        },
      ],
    });

    await pipeline.preprocess(message);

    expect(message.body).toContain('[Media attachments]');
    expect(message.body).toContain('IMAGE: photo.jpg');
    expect(message.body).toContain('VIDEO: clip.mp4');
    expect(message.body).toContain('[Security]');
  });

  it('preserves normal user text and appends security note', async () => {
    const pipeline = new InboundMediaPipeline({
      transcribe: async () => undefined,
    });

    const message = createMessage({
      body: 'Can you summarize this image?',
      rawBody: 'Can you summarize this image?',
      media: [
        { type: 'image', path: '/tmp/image.png', contentType: 'image/png', filename: 'image.png' },
      ],
    });

    await pipeline.preprocess(message);

    expect(message.body).toContain('Can you summarize this image?');
    expect(message.body).toContain('[Security]');
  });
});
