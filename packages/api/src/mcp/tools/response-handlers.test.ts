/**
 * send_response schema tests — media entry coercion.
 *
 * Agents naturally write media: ["/path/file.m4a"]. That shape used to fail
 * MCP arg validation (-32602) before the handler ran, and on Aug 13 the
 * rejection was swallowed by the CLI tool-loop cap — the outbound Telegram
 * message silently vanished. Bare string entries are now coerced to
 * {type, path|url} objects with the type inferred from the extension.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendResponseSchema,
  outboundMediaEntrySchema,
  inferMediaTypeFromPath,
  handleSendResponse,
} from './response-handlers';
import { getRequestContext } from '../../utils/request-context';

vi.mock('../../utils/request-context', () => ({
  getRequestContext: vi.fn(() => undefined),
  getPinnedAgentId: vi.fn(() => undefined),
}));

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
 * The Myra HTTP fallback is taken when send_response runs in a process with no
 * local response callback registered. `handleSendResponse` resolves the acting
 * SB and sets it on the `response` object — but this branch never sends that
 * object. It serialized a fresh body, and attribution was dropped on the floor
 * while the local-callback path preserved it correctly.
 */
describe('send_response — Myra HTTP fallback attribution', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mocked(getRequestContext).mockReturnValue({ agentId: 'wren' } as never);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // No response callback is registered in this test process, so the handler
  // takes the HTTP branch. A minimal stub is enough: the voice lookup is
  // wrapped in try/catch and degrades to no default voice.
  const dataComposer = { getClient: () => undefined } as never;

  it('serializes the acting SB into the fallback request body', async () => {
    await handleSendResponse(
      sendResponseSchema.parse({
        channel: 'telegram',
        conversationId: '726555973',
        content: 'Wren speaking, over HTTP',
      }),
      dataComposer
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.agentId).toBe('wren');
    expect(body.content).toBe('Wren speaking, over HTTP');
  });

  it('omits the author when none can be resolved rather than inventing one', async () => {
    vi.mocked(getRequestContext).mockReturnValue(undefined as never);

    await handleSendResponse(
      sendResponseSchema.parse({
        channel: 'telegram',
        conversationId: '726555973',
        content: 'No author resolvable',
      }),
      dataComposer
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.agentId).toBeUndefined();
  });
});
