import { describe, it, expect, vi } from 'vitest';
import {
  parseSseBuffer,
  startSessionEventStream,
  type SessionEvent,
} from './session-event-stream.js';

describe('parseSseBuffer', () => {
  it('parses a complete event/data frame', () => {
    const { frames, rest } = parseSseBuffer('event: tool_call\ndata: {"toolName":"x"}\n\n');
    expect(frames).toEqual([{ event: 'tool_call', data: '{"toolName":"x"}' }]);
    expect(rest).toBe('');
  });

  it('holds a partial trailing frame in rest', () => {
    const { frames, rest } = parseSseBuffer('event: a\ndata: 1\n\nevent: b\ndata: 2');
    expect(frames).toEqual([{ event: 'a', data: '1' }]);
    expect(rest).toBe('event: b\ndata: 2');
  });

  it('ignores comment/keepalive lines', () => {
    const { frames } = parseSseBuffer(': ping\n\nevent: result\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'result', data: '{}' }]);
  });

  it('normalizes CRLF line endings', () => {
    const { frames } = parseSseBuffer('event: x\r\ndata: y\r\n\r\n');
    expect(frames).toEqual([{ event: 'x', data: 'y' }]);
  });

  it('joins multi-line data', () => {
    const { frames } = parseSseBuffer('data: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('reassembles a frame split across two chunks', () => {
    const a = parseSseBuffer('event: tool_call\nda');
    expect(a.frames).toEqual([]);
    const b = parseSseBuffer(a.rest + 'ta: {"n":1}\n\n');
    expect(b.frames).toEqual([{ event: 'tool_call', data: '{"n":1}' }]);
  });
});

// Build a mock fetch whose response body streams the given SSE text chunks.
function mockFetchStreaming(chunks: string[]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  }) as unknown as typeof fetch;
}

describe('startSessionEventStream', () => {
  it('emits parsed events from the stream and sends the bearer token', async () => {
    const events: SessionEvent[] = [];
    const fetchImpl = mockFetchStreaming([
      'event: connected\ndata: {"sessionId":"s1"}\n\n',
      'event: tool_call\ndata: {"type":"tool_call","data":{"toolName":"list_emails"}}\n\n',
    ]);

    const stop = startSessionEventStream({
      serverUrl: 'http://localhost:3001/',
      sessionId: 's1',
      token: 'tok-123',
      onEvent: (e) => events.push(e),
      fetchImpl,
      // Never actually reconnect during the test.
      setTimeoutImpl: (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
    });

    // Let the async reader drain the stream.
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    stop();

    expect(events[0].type).toBe('connected');
    expect(events[1].type).toBe('tool_call');
    expect(events[1].data).toMatchObject({ type: 'tool_call' });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://localhost:3001/api/sessions/s1/events');
    expect(call[1].headers.Authorization).toBe('Bearer tok-123');
  });

  it('reports connection failures via onError without throwing', async () => {
    const errors: Error[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, body: null }) as unknown as typeof fetch;

    const stop = startSessionEventStream({
      serverUrl: 'http://localhost:3001',
      sessionId: 's1',
      token: 't',
      onEvent: () => {},
      onError: (e) => errors.push(e),
      fetchImpl,
      setTimeoutImpl: (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1));
    stop();
    expect(errors[0].message).toContain('503');
  });

  it('stop() halts further reconnects', async () => {
    let connects = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      connects += 1;
      return Promise.resolve({ ok: false, status: 500, body: null });
    }) as unknown as typeof fetch;

    // Reconnect immediately so, without stop(), it would loop forever.
    let resolveTimer: (() => void) | null = null;
    const setTimeoutImpl = ((cb: () => void) => {
      resolveTimer = cb;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const stop = startSessionEventStream({
      serverUrl: 'http://localhost:3001',
      sessionId: 's1',
      token: 't',
      onEvent: () => {},
      onError: () => {},
      fetchImpl,
      setTimeoutImpl,
    });

    await vi.waitFor(() => expect(connects).toBe(1));
    stop();
    // Fire the pending reconnect timer; stopped=true should prevent a 2nd connect.
    resolveTimer?.();
    await new Promise((r) => setImmediate(r));
    expect(connects).toBe(1);
  });
});
