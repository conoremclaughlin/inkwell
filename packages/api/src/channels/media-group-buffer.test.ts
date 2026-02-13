/**
 * Media Group Buffer Tests
 *
 * Tests for platform-agnostic media group aggregation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MediaGroupBuffer } from './media-group-buffer';
import type { InboundMessage } from './types';

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Helper to create a minimal InboundMessage with media
function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    body: '[Image attached]',
    rawBody: '[Image attached]',
    timestamp: Date.now(),
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    platform: 'telegram',
    chatType: 'direct',
    sender: { id: '123', username: 'testuser', name: 'Test User' },
    conversationId: 'chat-456',
    media: [{ type: 'image', path: '/tmp/photo1.jpg' }],
    mentions: { users: [], botMentioned: false },
    ...overrides,
  };
}

describe('MediaGroupBuffer', () => {
  let buffer: MediaGroupBuffer;
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockResolvedValue(undefined);
    buffer = new MediaGroupBuffer(flushCallback, { flushDelayMs: 500 });
  });

  afterEach(() => {
    buffer.destroy();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Basic buffering
  // --------------------------------------------------------------------------

  it('flushes a single message after delay', async () => {
    const msg = makeMessage();
    buffer.add('group-1', msg);

    expect(flushCallback).not.toHaveBeenCalled();
    expect(buffer.pendingGroupCount).toBe(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(flushCallback).toHaveBeenCalledTimes(1);
    const flushed = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(flushed.media).toHaveLength(1);
    expect(buffer.pendingGroupCount).toBe(0);
  });

  it('combines two photos into one message', async () => {
    const msg1 = makeMessage({
      messageId: 'msg-1',
      timestamp: 1000,
      media: [{ type: 'image', path: '/tmp/photo1.jpg' }],
    });
    const msg2 = makeMessage({
      messageId: 'msg-2',
      timestamp: 1200,
      media: [{ type: 'image', path: '/tmp/photo2.jpg' }],
    });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    expect(flushCallback).toHaveBeenCalledTimes(1);
    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.media).toHaveLength(2);
    expect(combined.media![0].path).toBe('/tmp/photo1.jpg');
    expect(combined.media![1].path).toBe('/tmp/photo2.jpg');
  });

  it('combines three photos from an album', async () => {
    for (let i = 0; i < 3; i++) {
      buffer.add(
        'group-1',
        makeMessage({
          messageId: `msg-${i}`,
          timestamp: 1000 + i * 100,
          media: [{ type: 'image', path: `/tmp/photo${i}.jpg` }],
        })
      );
    }

    await vi.advanceTimersByTimeAsync(500);

    expect(flushCallback).toHaveBeenCalledTimes(1);
    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.media).toHaveLength(3);
  });

  // --------------------------------------------------------------------------
  // Caption handling
  // --------------------------------------------------------------------------

  it('uses caption from the message that has one', async () => {
    const msg1 = makeMessage({
      body: '[Image attached]',
      media: [{ type: 'image', path: '/tmp/photo1.jpg' }],
    });
    const msg2 = makeMessage({
      body: 'Here are our vacation photos!',
      media: [{ type: 'image', path: '/tmp/photo2.jpg' }],
    });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.body).toBe('Here are our vacation photos!');
  });

  it('generates description when no caption present', async () => {
    const msg1 = makeMessage({
      body: '[Image attached]',
      media: [{ type: 'image', path: '/tmp/photo1.jpg' }],
    });
    const msg2 = makeMessage({
      body: '[Image attached]',
      media: [{ type: 'image', path: '/tmp/photo2.jpg' }],
    });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.body).toBe('[2 images attached]');
  });

  it('generates correct description for single image with no caption', async () => {
    const msg = makeMessage({
      body: '[Image attached]',
      media: [{ type: 'image', path: '/tmp/photo1.jpg' }],
    });

    buffer.add('group-1', msg);

    await vi.advanceTimersByTimeAsync(500);

    // Single message passes through as-is (no combining needed)
    const flushed = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(flushed.body).toBe('[Image attached]');
  });

  // --------------------------------------------------------------------------
  // Mixed media types
  // --------------------------------------------------------------------------

  it('combines mixed media types (photo + document)', async () => {
    const photoMsg = makeMessage({
      body: '[Image attached]',
      media: [{ type: 'image', path: '/tmp/photo.jpg' }],
    });
    const docMsg = makeMessage({
      body: '[File attached]',
      media: [{ type: 'document', path: '/tmp/report.pdf', filename: 'report.pdf' }],
    });

    buffer.add('group-1', photoMsg);
    buffer.add('group-1', docMsg);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.media).toHaveLength(2);
    expect(combined.media![0].type).toBe('image');
    expect(combined.media![1].type).toBe('document');
    expect(combined.body).toContain('1 image');
    expect(combined.body).toContain('1 file');
  });

  it('generates correct plural forms', async () => {
    for (let i = 0; i < 3; i++) {
      buffer.add(
        'group-1',
        makeMessage({
          body: '[Video attached]',
          media: [{ type: 'video', path: `/tmp/video${i}.mp4` }],
        })
      );
    }

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.body).toBe('[3 videos attached]');
  });

  // --------------------------------------------------------------------------
  // Timestamp handling
  // --------------------------------------------------------------------------

  it('uses earliest timestamp', async () => {
    const msg1 = makeMessage({ timestamp: 2000 });
    const msg2 = makeMessage({ timestamp: 1000 });
    const msg3 = makeMessage({ timestamp: 1500 });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);
    buffer.add('group-1', msg3);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.timestamp).toBe(1000);
  });

  // --------------------------------------------------------------------------
  // Mentions merging
  // --------------------------------------------------------------------------

  it('merges mentions from multiple messages', async () => {
    const msg1 = makeMessage({
      mentions: { users: ['@alice'], botMentioned: false },
    });
    const msg2 = makeMessage({
      mentions: { users: ['@bob'], botMentioned: true },
    });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.mentions?.users).toContain('@alice');
    expect(combined.mentions?.users).toContain('@bob');
    expect(combined.mentions?.botMentioned).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Timer behavior
  // --------------------------------------------------------------------------

  it('resets timer when new message arrives', async () => {
    buffer.add('group-1', makeMessage({ timestamp: 1000 }));

    // Advance 400ms (not yet flushed)
    await vi.advanceTimersByTimeAsync(400);
    expect(flushCallback).not.toHaveBeenCalled();

    // Add second message — resets the 500ms timer
    buffer.add('group-1', makeMessage({ timestamp: 1400 }));

    // Advance another 400ms (800ms total, but only 400ms since last add)
    await vi.advanceTimersByTimeAsync(400);
    expect(flushCallback).not.toHaveBeenCalled();

    // Advance final 100ms to hit the 500ms mark from last add
    await vi.advanceTimersByTimeAsync(100);
    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect((flushCallback.mock.calls[0][0] as InboundMessage).media).toHaveLength(2);
  });

  it('handles multiple independent groups', async () => {
    buffer.add('group-A', makeMessage({ conversationId: 'chat-A' }));
    buffer.add('group-B', makeMessage({ conversationId: 'chat-B' }));

    expect(buffer.pendingGroupCount).toBe(2);

    await vi.advanceTimersByTimeAsync(500);

    expect(flushCallback).toHaveBeenCalledTimes(2);
    expect(buffer.pendingGroupCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Raw object collection
  // --------------------------------------------------------------------------

  it('collects raw objects from all messages', async () => {
    const msg1 = makeMessage({ raw: { telegram_msg_id: 1 } });
    const msg2 = makeMessage({ raw: { telegram_msg_id: 2 } });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(Array.isArray(combined.raw)).toBe(true);
    expect(combined.raw).toHaveLength(2);
  });

  // --------------------------------------------------------------------------
  // Destroy
  // --------------------------------------------------------------------------

  it('destroy() clears pending groups without flushing', async () => {
    buffer.add('group-1', makeMessage());
    buffer.add('group-2', makeMessage());

    expect(buffer.pendingGroupCount).toBe(2);

    buffer.destroy();

    expect(buffer.pendingGroupCount).toBe(0);

    // Advance time — callback should NOT be called
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushCallback).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Metadata preservation
  // --------------------------------------------------------------------------

  it('preserves sender, conversationId, platform, and chatType from first message', async () => {
    const msg1 = makeMessage({
      sender: { id: '100', username: 'alice', name: 'Alice' },
      conversationId: 'chat-789',
      platform: 'telegram',
      chatType: 'group',
    });
    const msg2 = makeMessage({
      sender: { id: '100', username: 'alice', name: 'Alice' },
      conversationId: 'chat-789',
      platform: 'telegram',
      chatType: 'group',
    });

    buffer.add('group-1', msg1);
    buffer.add('group-1', msg2);

    await vi.advanceTimersByTimeAsync(500);

    const combined = flushCallback.mock.calls[0][0] as InboundMessage;
    expect(combined.sender.id).toBe('100');
    expect(combined.sender.username).toBe('alice');
    expect(combined.conversationId).toBe('chat-789');
    expect(combined.platform).toBe('telegram');
    expect(combined.chatType).toBe('group');
  });
});
