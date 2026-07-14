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
function makeAuthProvider(result: { userId: string } | null) {
  return { verifyAccessToken: vi.fn().mockReturnValue(result) };
}

function makeDataComposer(session: { user_id: string } | null, error: unknown = null) {
  const single = vi.fn().mockResolvedValue({ data: session, error });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { getClient: () => ({ from }) };
}

function makeReq(id: string, authHeader?: string) {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.headers = authHeader ? { authorization: authHeader } : {};
  req.params = { id };
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
