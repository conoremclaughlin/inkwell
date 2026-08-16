import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createSessionsRouter } from './sessions.js';
import { sessionEventBus } from '../services/sessions/session-event-bus.js';

// ── Extract the GET /:id/events handler from the router (no server needed) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getEventsHandler(router: any): (req: unknown, res: unknown) => Promise<void> {
  for (const layer of router.stack) {
    if (layer.route?.path === '/:id/events') {
      const get = layer.route.stack.find((s: { method: string }) => s.method === 'get');
      return get.handle;
    }
  }
  throw new Error('events handler not found');
}

// ── Mocks ──
function makeAuthProvider(result: { userId: string; sbId?: string } | null) {
  return { verifyAccessToken: vi.fn().mockReturnValue(result) };
}

function makeDataComposer(
  session: { user_id: string; sb_id?: string | null; contact_id?: string | null } | null,
  error: unknown = null,
  grant: { id: string; expires_at: string | null } | null = null
) {
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'session_observe_grants') {
      const maybeSingle = vi.fn().mockResolvedValue({ data: grant, error: null });
      const chain: Record<string, unknown> = { maybeSingle };
      chain.eq = vi.fn().mockReturnValue(chain);
      return { select: vi.fn().mockReturnValue(chain) };
    }
    const single = vi.fn().mockResolvedValue({
      data: session ? { sb_id: null, contact_id: null, ...session } : null,
      error,
    });
    const eq = vi.fn().mockReturnValue({ single });
    const select = vi.fn().mockReturnValue({ eq });
    return { select };
  });
  return { getClient: () => ({ from }) };
}

function makeReq(id: string, authHeader?: string, query: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.headers = authHeader ? { authorization: authHeader } : {};
  req.params = { id };
  req.query = query;
  req.socket = { setTimeout: vi.fn() };
  return req;
}

function makeRes() {
  const writes: string[] = [];
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  res.statusCode = 200;
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn();
  res.writeHead = vi.fn();
  res.write = vi.fn().mockImplementation((chunk: string) => {
    writes.push(chunk);
    return true;
  });
  return { res, writes };
}

const SID = '00000000-0000-0000-0000-0000000000aa';
const OWNER = 'user-owner';

describe('GET /api/sessions/:id/events (SSE)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s without a valid token', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider(null) as never,
        dataComposer: makeDataComposer({ user_id: OWNER }) as never,
      })
    );
    const req = makeReq(SID);
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER }) as never,
        dataComposer: makeDataComposer(null) as never,
      })
    );
    const req = makeReq(SID, 'Bearer x');
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(404);
  });

  it('403s when the session belongs to another user', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: 'someone-else' }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER }) as never,
      })
    );
    const req = makeReq(SID, 'Bearer x');
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('streams live bus events to an authorized owner, then cleans up on close', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER }) as never,
      })
    );
    const req = makeReq(SID, 'Bearer x');
    const { res, writes } = makeRes();

    await handler(req, res);

    // SSE opened with the right headers + a connected preamble.
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' })
    );
    expect(writes.some((w) => w.startsWith('event: connected'))).toBe(true);
    expect(sessionEventBus.subscriberCount(SID)).toBe(1);

    // A published event is written to the stream as an SSE frame.
    sessionEventBus.publish(SID, 'tool_call', { toolName: 'list_emails' });
    const frame = writes.find((w) => w.startsWith('event: tool_call'));
    expect(frame).toBeDefined();
    expect(frame).toContain('list_emails');

    // Client disconnects → unsubscribe (no leaked listener).
    (req as EventEmitter).emit('close');
    expect(sessionEventBus.subscriberCount(SID)).toBe(0);

    // Post-close events are no longer written.
    const before = writes.length;
    sessionEventBus.publish(SID, 'result', { text: 'done' });
    expect(writes.length).toBe(before);
  });
});

/**
 * Observer-attach M3: the §4.6 permission matrix (pure) and the obs channel
 * on the SSE route (eid frames, exclusive cursors, grant gating).
 */
import { resolveObservePermission } from './sessions.js';

describe('resolveObservePermission (spec §4.6 matrix)', () => {
  const WREN = '11111111-1111-1111-1111-111111111111';
  const MYRA = '22222222-2222-2222-2222-222222222222';

  it('denies across users unconditionally', () => {
    expect(
      resolveObservePermission(
        { userId: 'user-a', sbId: WREN },
        { userId: 'user-b', sbId: WREN, contactId: null }
      )
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it('allows a user token to observe their own sessions', () => {
    expect(
      resolveObservePermission({ userId: OWNER }, { userId: OWNER, sbId: MYRA, contactId: null })
    ).toEqual({ allowed: true });
  });

  it('allows an agent to observe its own session (same identity UUID)', () => {
    expect(
      resolveObservePermission(
        { userId: OWNER, sbId: WREN },
        { userId: OWNER, sbId: WREN, contactId: null }
      )
    ).toEqual({ allowed: true });
  });

  it('contact isolation: agents never observe contact-scoped sessions — even their own', () => {
    expect(
      resolveObservePermission(
        { userId: OWNER, sbId: MYRA },
        { userId: OWNER, sbId: MYRA, contactId: 'contact-x' }
      )
    ).toMatchObject({ allowed: false, reason: 'contact_isolated' });
  });

  it('user tokens still see contact-scoped sessions they own', () => {
    expect(
      resolveObservePermission(
        { userId: OWNER },
        { userId: OWNER, sbId: MYRA, contactId: 'contact-x' }
      )
    ).toEqual({ allowed: true });
  });

  it('cross-agent requires a grant (needs_grant names the owner identity)', () => {
    expect(
      resolveObservePermission(
        { userId: OWNER, sbId: WREN },
        { userId: OWNER, sbId: MYRA, contactId: null }
      )
    ).toEqual({ allowed: false, status: 'needs_grant', ownerSbId: MYRA });
  });

  it('denies agent observation of sessions with no owning identity', () => {
    expect(
      resolveObservePermission(
        { userId: OWNER, sbId: WREN },
        { userId: OWNER, sbId: null, contactId: null }
      )
    ).toMatchObject({ allowed: false, reason: 'session_has_no_owner_identity' });
  });
});

describe('GET /api/sessions/:id/events?channel=obs', () => {
  const WREN = '11111111-1111-1111-1111-111111111111';
  const MYRA = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => vi.clearAllMocks());

  it('403s cross-agent observation without a grant row', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER, sbId: WREN }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER, sb_id: MYRA }) as never,
      })
    );
    const req = makeReq(SID, 'Bearer t', { channel: 'obs' });
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('admits cross-agent observation with an unexpired grant', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER, sbId: WREN }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER, sb_id: MYRA }, null, {
          id: 'grant-1',
          expires_at: null,
        }) as never,
      })
    );
    const req = makeReq(`obs-grant-${Date.now()}`, 'Bearer t', { channel: 'obs' });
    const { res } = makeRes();
    await handler(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('rejects an EXPIRED grant', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER, sbId: WREN }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER, sb_id: MYRA }, null, {
          id: 'grant-1',
          expires_at: '2020-01-01T00:00:00Z',
        }) as never,
      })
    );
    const req = makeReq(SID, 'Bearer t', { channel: 'obs' });
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
  });

  it('streams canonical entries with SSE id = ledger eid, honoring the exclusive cursor', async () => {
    const sid = `obs-route-${Date.now()}`;
    sessionEventBus.publishObserverEntry(sid, {
      eid: 1,
      ts: '2026-08-07T00:00:01.000Z',
      type: 'backend_tool',
      name: 'WebSearch',
      status: 'running',
    });
    sessionEventBus.publishObserverEntry(sid, {
      eid: 2,
      ts: '2026-08-07T00:00:02.000Z',
      type: 'backend_text',
      preview: 'working…',
    });

    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER, sb_id: MYRA }) as never,
      })
    );
    // Last-Event-ID: 1 → resume strictly after eid 1.
    const req = makeReq(sid, 'Bearer t', { channel: 'obs' });
    (req.headers as Record<string, string>)['last-event-id'] = '1';
    const { res, writes } = makeRes();
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    req.emit('close');

    const frames = writes.join('');
    expect(frames).toContain('id: 2\nevent: backend_text');
    expect(frames).not.toContain('id: 1\n');
  });
});

describe('M4.2 — uniform gate, per-user cap, close-during-replay', () => {
  const WREN = '11111111-1111-1111-1111-111111111111';
  const MYRA = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => vi.clearAllMocks());

  it('the LEGACY channel enforces the same matrix (no bypass by omitting channel=obs)', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER, sbId: WREN }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER, sb_id: MYRA }) as never,
      })
    );
    // No channel param — the old bypass route. Cross-agent without grant → 403.
    const req = makeReq(SID, 'Bearer t');
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('contact-scoped sessions are agent-invisible on the legacy channel too', async () => {
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER, sbId: MYRA }) as never,
        dataComposer: makeDataComposer({
          user_id: OWNER,
          sb_id: MYRA,
          contact_id: 'contact-x',
        }) as never,
      })
    );
    const req = makeReq(SID, 'Bearer t');
    const { res } = makeRes();
    await handler(req, res);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
  });

  it('enforces the per-user connection cap across sessions with 429', async () => {
    const capUser = `cap-user-${Date.now()}`;
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: capUser }) as never,
        dataComposer: makeDataComposer({ user_id: capUser }) as never,
      })
    );
    const held: Array<ReturnType<typeof makeRes>> = [];
    for (let i = 0; i < 16; i++) {
      const req = makeReq(`sess-${i}`, 'Bearer t');
      const r = makeRes();
      held.push(r);
      await handler(req, r.res);
      expect(r.res.writeHead).toHaveBeenCalled();
    }
    const req17 = makeReq('sess-17', 'Bearer t');
    const { res: res17 } = makeRes();
    await handler(req17, res17);
    expect(res17.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(429);
  });

  it('a client close during backpressured obs replay settles the handler (no strand)', async () => {
    const sid = `strand-${Date.now()}`;
    for (let i = 1; i <= 5; i++) {
      sessionEventBus.publishObserverEntry(sid, {
        eid: i,
        ts: 't',
        type: 'backend_tool',
        name: 'x',
        status: 'running',
      });
    }
    const handler = getEventsHandler(
      createSessionsRouter({
        authProvider: makeAuthProvider({ userId: OWNER }) as never,
        dataComposer: makeDataComposer({ user_id: OWNER }) as never,
      })
    );
    const req = makeReq(sid, 'Bearer t', { channel: 'obs', afterEid: '0' });
    const { res } = makeRes();
    // Backpressure from the very first frame; drain never fires.
    (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => false);

    const pending = handler(req, res);
    // Client vanishes mid-replay.
    setImmediate(() => (req as EventEmitter).emit('close'));

    const settled = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('stranded'), 1_000)),
    ]);
    expect(settled).toBe('settled');
  });
});
