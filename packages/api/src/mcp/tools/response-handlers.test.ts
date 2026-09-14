/**
 * send_response schema tests — media entry coercion.
 *
 * Agents naturally write media: ["/path/file.m4a"]. That shape used to fail
 * MCP arg validation (-32602) before the handler ran, and on Aug 13 the
 * rejection was swallowed by the CLI tool-loop cap — the outbound Telegram
 * message silently vanished. Bare string entries are now coerced to
 * {type, path|url} objects with the type inferred from the extension.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendResponseSchema,
  outboundMediaEntrySchema,
  inferMediaTypeFromPath,
  handleSendResponse,
  consumeExplicitResponse,
  setResponseCallback,
} from './response-handlers';
import { runWithRequestContext } from '../../utils/request-context';

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
    consumeExplicitResponse('telegram', conversationId);
  });

  afterEach(() => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    consumeExplicitResponse('telegram', conversationId);
  });

  it('marks the conversation when the send succeeds', async () => {
    setResponseCallback(async () => undefined);
    await send('delivered');
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(true);
  });

  it('does NOT mark when the send throws', async () => {
    setResponseCallback(async () => {
      throw new Error('gateway down');
    });
    const res = await send('never arrives');

    expect(JSON.parse(res.content[0]!.text).success).toBe(false);
    // The whole point: the server must still see this turn as undelivered, so
    // the fallback can fire or the warning can be raised.
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(false);
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
    expect(consumeExplicitResponse('discord', conversationId)).toBe(false);
  });
});

/**
 * The marker must not survive into a nested turn, and must not be set when
 * nothing was delivered (Lumen, PR #580 r2).
 */
describe('handleSendResponse — delivery evidence', () => {
  const conversationId = 'conv-evidence-test';
  const composer = {} as unknown as Parameters<typeof handleSendResponse>[1];

  beforeEach(() => consumeExplicitResponse('telegram', conversationId));
  afterEach(() => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    consumeExplicitResponse('telegram', conversationId);
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
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(false);
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
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(false);
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
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(true);
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
  afterEach(() => consumeExplicitResponse('telegram', conversationId));

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
    expect(consumeExplicitResponse('telegram', conversationId)).toBe(false);
  });

  it('is false for a conversation that never answered', () => {
    expect(consumeExplicitResponse('telegram', 'never-used')).toBe(false);
  });
});

describe('handleSendResponse — sender session attribution', () => {
  /**
   * Regression coverage for the 2026-09-10 duplicate-digest incident.
   *
   * Conor received the same Thursday digest twice, ten minutes apart, from two
   * concurrently-live myra sessions. Neither `message_out` activity row said
   * who sent it — every outbound row carried `session_id` null (69 of 69 that
   * week) — so the sender could only be identified by reading a sibling's
   * session `context` field and inferring from it.
   *
   * The gateway stamps whatever `AgentResponse.sessionId` it is handed, so the
   * property that matters is pinned here, at the boundary where the request
   * context is unambiguously this call's — and where the session it names is
   * loaded and authorized before it is stamped. The first version of this fix
   * stamped the unsigned header bare, which let a legacy agent token name any
   * session at all (Lumen, #596).
   */
  const conversationId = 'conv-session-attribution';
  const ownSession = '64e1eb49-6229-4e4c-a9fd-08f1b6bd6848';
  const foreignUserSession = '88b728cb-45aa-4830-90d3-20007aa521bc';
  const peerIdentitySession = 'd1d105ec-8f1a-4e62-9a1b-0c5a7a2f1e10';
  const contactSession = '0a731a19-2c4e-4b7d-8f3a-9e6d5c4b3a21';
  const sbId = 'sb-myra';
  const rows: Record<string, object> = {
    [ownSession]: { id: ownSession, userId: 'owner', sbSlug: 'myra', sbId },
    [foreignUserSession]: {
      id: foreignUserSession,
      userId: 'someone-else',
      sbSlug: 'wren',
      sbId: 'sb-wren',
    },
    [peerIdentitySession]: {
      id: peerIdentitySession,
      userId: 'owner',
      sbSlug: 'wren',
      sbId: 'sb-wren',
    },
    [contactSession]: {
      id: contactSession,
      userId: 'owner',
      sbSlug: 'myra',
      sbId,
      contactId: 'contact-b',
    },
  };
  const getSession = vi.fn(async (id: string) => rows[id] ?? null);
  const composer = {
    repositories: { memory: { getSession } },
  } as unknown as Parameters<typeof handleSendResponse>[1];

  /** An SB's own token: signed identity, no signed session claim. */
  const boundMyra = {
    userId: 'owner',
    sbSlug: 'myra',
    sbId,
    agentTokenBound: true,
    tokenSlug: 'myra',
    tokenSbId: sbId,
  };

  let captured: { sessionId?: string } | undefined;
  let delivered = 0;

  beforeEach(() => {
    captured = undefined;
    delivered = 0;
    getSession.mockClear();
    consumeExplicitResponse('telegram', conversationId);
    setResponseCallback((async (response: { sessionId?: string }) => {
      captured = response;
      delivered += 1;
      return undefined;
    }) as unknown as Parameters<typeof setResponseCallback>[0]);
  });

  afterEach(() => {
    setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
    consumeExplicitResponse('telegram', conversationId);
    vi.unstubAllGlobals();
  });

  const send = () =>
    handleSendResponse(
      {
        channel: 'telegram',
        conversationId,
        content: 'Thursday digest',
      } as Parameters<typeof handleSendResponse>[0],
      composer
    );

  const sendIn = (ctx: Parameters<typeof runWithRequestContext>[0]) =>
    runWithRequestContext(ctx, () => send());

  it('stamps the signed token session after loading and authorizing it', async () => {
    const res = await sendIn({ ...boundMyra, tokenSessionId: ownSession });
    expect(JSON.parse(res.content[0].text).success).toBe(true);
    // Without this the row is anonymous and a duplicate cannot be attributed.
    expect(captured?.sessionId).toBe(ownSession);
    expect(getSession).toHaveBeenCalledWith(ownSession);
  });

  it("stamps a header-asserted session for a user token when it is the same user's", async () => {
    await sendIn({ userId: 'owner', sbSlug: 'myra', sbId, sessionId: ownSession });
    expect(captured?.sessionId).toBe(ownSession);
  });

  it('prefers the signed token session over the caller-asserted header', async () => {
    // The header form is a caller-composed assertion; the token claim is
    // authenticated. Same precedence the memory handlers use — and the header
    // session is never even loaded.
    await sendIn({ ...boundMyra, sessionId: foreignUserSession, tokenSessionId: ownSession });
    expect(captured?.sessionId).toBe(ownSession);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(ownSession);
  });

  it("refuses another user's session named by the unsigned header, and still delivers", async () => {
    // Lumen's probe: an agent-bound caller whose header names a session owned
    // by someone else. The activity FK checks existence, not ownership; this
    // boundary has to.
    const res = await sendIn({ ...boundMyra, sessionId: foreignUserSession });
    expect(delivered).toBe(1);
    expect(JSON.parse(res.content[0].text).success).toBe(true);
    expect(captured?.sessionId).toBeUndefined();
  });

  it('refuses a same-user session of another identity for an agent-bound caller', async () => {
    await sendIn({ ...boundMyra, sessionId: peerIdentitySession });
    expect(delivered).toBe(1);
    expect(captured?.sessionId).toBeUndefined();
  });

  it('refuses a session in another contact scope for an agent-bound caller', async () => {
    await sendIn({ ...boundMyra, sessionId: contactSession });
    expect(delivered).toBe(1);
    expect(captured?.sessionId).toBeUndefined();
  });

  it('omits attribution when the named session does not exist, and still delivers', async () => {
    // A nonexistent id used to fail the activity insert AFTER the message had
    // gone out, leaving no outgoing row at all.
    await sendIn({ ...boundMyra, tokenSessionId: 'f0f0f0f0-0000-4000-8000-000000000000' });
    expect(delivered).toBe(1);
    expect(captured?.sessionId).toBeUndefined();
  });

  it('omits attribution when the session lookup throws, and still delivers', async () => {
    getSession.mockRejectedValueOnce(new Error('db down'));
    await sendIn({ ...boundMyra, tokenSessionId: ownSession });
    expect(delivered).toBe(1);
    expect(captured?.sessionId).toBeUndefined();
  });

  it('leaves the session undefined when there is no request context', async () => {
    // Heartbeat and other sessionless sends must still go out — they log null,
    // exactly as before. Absent attribution is acceptable; wrong is not.
    await send();
    expect(delivered).toBe(1);
    expect(captured?.sessionId).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });

  describe('HTTP fallback (no local callback)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      setResponseCallback(null as unknown as Parameters<typeof setResponseCallback>[0]);
      fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
    });

    const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);

    it('carries the validated sending session in the payload', async () => {
      // Lumen's probe: an external-process send_response with a signed session
      // claim. This branch exists for exactly that caller, and it used to
      // rebuild the payload from args and drop the session.
      await sendIn({ userId: 'owner', sbSlug: 'myra', tokenSessionId: ownSession });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body()).toEqual({
        channel: 'telegram',
        conversationId,
        content: 'Thursday digest',
        sessionId: ownSession,
      });
    });

    it("sends no session when the header names another user's session", async () => {
      await sendIn({ ...boundMyra, sessionId: foreignUserSession });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body()).not.toHaveProperty('sessionId');
    });
  });
});
