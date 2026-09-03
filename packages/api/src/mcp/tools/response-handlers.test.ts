/**
 * send_response schema tests — media entry coercion.
 *
 * Agents naturally write media: ["/path/file.m4a"]. That shape used to fail
 * MCP arg validation (-32602) before the handler ran, and on Aug 13 the
 * rejection was swallowed by the CLI tool-loop cap — the outbound Telegram
 * message silently vanished. Bare string entries are now coerced to
 * {type, path|url} objects with the type inferred from the extension.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sendResponseSchema,
  outboundMediaEntrySchema,
  inferMediaTypeFromPath,
  handleSendResponse,
  hasExplicitResponse,
  clearExplicitResponse,
  consumeExplicitResponse,
  setResponseCallback,
} from './response-handlers';

describe('inferMediaTypeFromPath', () => {
  it('classifies common extensions', () => {
    expect(inferMediaTypeFromPath('/a/b/photo.PNG')).toBe('image');
    expect(inferMediaTypeFromPath('/a/b/clip.mov')).toBe('video');
    expect(inferMediaTypeFromPath('/a/b/note.m4a')).toBe('audio');
    expect(inferMediaTypeFromPath('/a/b/voice.oga')).toBe('audio');
    expect(inferMediaTypeFromPath('/a/b/report.pdf')).toBe('document');
  });

  it('falls back to document for unknown or missing extensions', () => {
    expect(inferMediaTypeFromPath('/a/b/README')).toBe('document');
    expect(inferMediaTypeFromPath('/a/b/archive.zip')).toBe('document');
  });

  it('ignores URL query strings and fragments', () => {
    expect(inferMediaTypeFromPath('https://x.test/f.mp3?token=abc#t=10')).toBe('audio');
  });
});

describe('outboundMediaEntrySchema', () => {
  it('passes canonical objects through unchanged', () => {
    const entry = { type: 'audio', path: '/tmp/a.m4a', caption: 'hi' };
    expect(outboundMediaEntrySchema.parse(entry)).toEqual(entry);
  });

  it('coerces a bare local path to {type, path}', () => {
    expect(
      outboundMediaEntrySchema.parse('/Users/x/.ink/files/studio-lease-assessment.m4a')
    ).toEqual({
      type: 'audio',
      path: '/Users/x/.ink/files/studio-lease-assessment.m4a',
    });
  });

  it('coerces a bare URL to {type, url}', () => {
    expect(outboundMediaEntrySchema.parse('https://example.com/pic.jpg')).toEqual({
      type: 'image',
      url: 'https://example.com/pic.jpg',
    });
  });
});

describe('sendResponseSchema media coercion', () => {
  const base = {
    channel: 'telegram' as const,
    conversationId: '726555973',
    content: 'And here is the audio version',
  };

  it('accepts the exact call shape that was rejected on Aug 13', () => {
    const parsed = sendResponseSchema.parse({
      ...base,
      media: ['/Users/x/.ink/files/studio-lease-assessment.m4a'],
    });
    expect(parsed.media).toEqual([
      { type: 'audio', path: '/Users/x/.ink/files/studio-lease-assessment.m4a' },
    ]);
  });

  it('accepts mixed object and string entries', () => {
    const parsed = sendResponseSchema.parse({
      ...base,
      media: [{ type: 'document', path: '/tmp/r.pdf', filename: 'r.pdf' }, '/tmp/shot.png'],
    });
    expect(parsed.media).toEqual([
      { type: 'document', path: '/tmp/r.pdf', filename: 'r.pdf' },
      { type: 'image', path: '/tmp/shot.png' },
    ]);
  });

  it('still rejects entries that are neither object nor string', () => {
    const result = sendResponseSchema.safeParse({ ...base, media: [42] });
    expect(result.success).toBe(false);
  });
});

/**
 * A failed send must not leave the conversation marked as answered.
 *
 * `markExplicitResponse` used to run BEFORE the callback/HTTP attempt, so a
 * send that threw, returned non-ok, or hit the no-routing early return still
 * set the marker. `server.ts` then read it, concluded an explicit response had
 * been delivered, and suppressed both the auto-forward fallback and the warning
 * that says nothing reached the user — turning a failed send into a silent one
 * (Lumen, PR #580).
 *
 * Tested through the real handler rather than the private helper, because the
 * defect was in WHERE the call sat relative to the send, which a direct test of
 * the helper cannot see.
 */
describe('handleSendResponse — the explicit-response marker', () => {
  const conversationId = 'conv-marker-test';
  const composer = {} as unknown as Parameters<typeof handleSendResponse>[1];

  const send = (content: string) =>
    handleSendResponse(
      { channel: 'telegram', conversationId, content } as Parameters<typeof handleSendResponse>[0],
      composer
    );

  beforeEach(() => {
    clearExplicitResponse('telegram', conversationId);
  });

  afterEach(() => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    clearExplicitResponse('telegram', conversationId);
  });

  it('marks the conversation when the send succeeds', async () => {
    setResponseCallback(async () => undefined);
    await send('delivered');
    expect(hasExplicitResponse('telegram', conversationId)).toBe(true);
  });

  it('does NOT mark when the send throws', async () => {
    setResponseCallback(async () => {
      throw new Error('gateway down');
    });
    const res = await send('never arrives');

    expect(JSON.parse(res.content[0]!.text).success).toBe(false);
    // The whole point: the server must still see this turn as undelivered, so
    // the fallback can fire or the warning can be raised.
    expect(hasExplicitResponse('telegram', conversationId)).toBe(false);
  });

  it('does NOT mark when the channel has no routing', async () => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    const res = await handleSendResponse(
      {
        channel: 'discord',
        conversationId,
        content: 'no route',
      } as Parameters<typeof handleSendResponse>[0],
      composer
    );

    expect(JSON.parse(res.content[0]!.text).success).toBe(false);
    expect(hasExplicitResponse('discord', conversationId)).toBe(false);
  });
});

/**
 * The marker must not survive into a nested turn, and must not be set when
 * nothing was delivered (Lumen, PR #580 r2).
 */
describe('handleSendResponse — delivery evidence', () => {
  const conversationId = 'conv-evidence-test';
  const composer = {} as unknown as Parameters<typeof handleSendResponse>[1];

  beforeEach(() => clearExplicitResponse('telegram', conversationId));
  afterEach(() => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    clearExplicitResponse('telegram', conversationId);
  });

  it('does NOT mark a blank body with no media', async () => {
    setResponseCallback(async () => undefined);
    const res = await handleSendResponse(
      { channel: 'telegram', conversationId, content: '   ' } as Parameters<
        typeof handleSendResponse
      >[0],
      composer
    );

    expect(JSON.parse(res.content[0]!.text).success).toBe(false);
    expect(hasExplicitResponse('telegram', conversationId)).toBe(false);
  });

  it('does NOT mark a media-only send where every attachment failed', async () => {
    setResponseCallback(async () => ({ mediaSent: 0, mediaFailed: 2 }));
    const res = await handleSendResponse(
      {
        channel: 'telegram',
        conversationId,
        content: '',
        media: [
          { type: 'image', path: '/a.png' },
          { type: 'image', path: '/b.png' },
        ],
      } as unknown as Parameters<typeof handleSendResponse>[0],
      composer
    );

    expect(JSON.parse(res.content[0]!.text).success).toBe(false);
    expect(hasExplicitResponse('telegram', conversationId)).toBe(false);
  });

  it('marks a media-only send the gateway counted as delivered', async () => {
    setResponseCallback(async () => ({ mediaSent: 1 }));
    const res = await handleSendResponse(
      {
        channel: 'telegram',
        conversationId,
        content: '',
        media: [{ type: 'image', path: '/a.png' }],
      } as unknown as Parameters<typeof handleSendResponse>[0],
      composer
    );

    expect(JSON.parse(res.content[0]!.text).success).toBe(true);
    expect(hasExplicitResponse('telegram', conversationId)).toBe(true);
  });
});

/**
 * The marker is consumed by the read, so a nested turn cannot inherit it.
 *
 * `releaseConversation` drains a pending next turn synchronously. With a
 * separate check-then-clear, that nested turn ran while the previous turn's
 * marker was still standing and read it as its own delivery — suppressing its
 * fallback and its warning (Lumen, PR #580 r2). Reordering two lines would fix
 * today's instance and leave the hazard; consuming on read removes it.
 */
describe('consumeExplicitResponse', () => {
  const conversationId = 'conv-consume-test';
  afterEach(() => clearExplicitResponse('telegram', conversationId));

  it('reports the marker once and clears it in the same call', async () => {
    setResponseCallback(async () => undefined);
    await handleSendResponse(
      { channel: 'telegram', conversationId, content: 'delivered' } as Parameters<
        typeof handleSendResponse
      >[0],
      {} as unknown as Parameters<typeof handleSendResponse>[1]
    );
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);

    expect(consumeExplicitResponse('telegram', conversationId)).toBe(true);
    // The nested turn that release() drains sees a clean slate, so its own
    // fallback and warning are free to fire.
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(false);
    expect(hasExplicitResponse('telegram', conversationId)).toBe(false);
  });

  it('is false for a conversation that never answered', () => {
    expect(consumeExplicitResponse('telegram', 'never-used')).toBe(false);
  });
});
