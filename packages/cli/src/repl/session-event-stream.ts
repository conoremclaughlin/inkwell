/**
 * Session Event Stream (client)
 *
 * Consumes the server's live session event stream over SSE
 * (GET /api/sessions/:id/events) so an attached `ink chat` terminal can render
 * a background worker's turn — heartbeats, incoming messages — as it churns,
 * instead of waiting on the coarse activity poll.
 *
 * We use fetch (not the global EventSource) because SSE needs an Authorization
 * bearer, which the EventSource API can't set. The reader auto-reconnects while
 * the REPL is alive and stops cleanly on abort.
 */

export interface SessionEvent {
  /** Event kind emitted by the worker (e.g. 'tool_call', 'result', 'connected'). */
  type: string;
  /** Parsed JSON payload (the bus SessionStreamEvent, or {} for chrome). */
  data: Record<string, unknown>;
}

/** A raw SSE frame: an event name and its data text. */
interface RawSseFrame {
  event: string;
  data: string;
}

/**
 * Parse a text buffer into complete SSE frames, returning any trailing partial
 * frame as `rest` to prepend to the next chunk. Frames are separated by a blank
 * line; `:`-prefixed lines are comments (keepalive pings) and yield no frame.
 * Exported for testing.
 */
export function parseSseBuffer(buffer: string): { frames: RawSseFrame[]; rest: string } {
  const frames: RawSseFrame[] = [];
  // Normalize CRLF so splitting on \n\n works regardless of server line endings.
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  // The last element is an incomplete frame (no terminating blank line yet).
  const rest = parts.pop() ?? '';

  for (const block of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue; // blank or comment/ping
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length > 0 || event !== 'message') {
      frames.push({ event, data: dataLines.join('\n') });
    }
  }

  return { frames, rest };
}

export interface SessionEventStreamOptions {
  serverUrl: string;
  sessionId: string;
  /** Bearer access token (self-issued PCP token). */
  token: string;
  onEvent: (event: SessionEvent) => void;
  onError?: (err: Error) => void;
  /** Reconnect backoff after a dropped/failed connection. Default 3s. */
  reconnectDelayMs?: number;
  /** Injectable fetch + timer for testing; default to globals. */
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: typeof setTimeout;
}

/**
 * Start consuming a session's SSE stream. Returns a stop() function that aborts
 * the connection and prevents further reconnects. Resolves nothing — it runs for
 * the lifetime of the REPL.
 */
export function startSessionEventStream(opts: SessionEventStreamOptions): () => void {
  const {
    serverUrl,
    sessionId,
    token,
    onEvent,
    onError,
    reconnectDelayMs = 3000,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
  } = opts;

  const url = `${serverUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/events`;
  let stopped = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed (${res.status})`);
        }

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Read until the stream ends (server closed) or we're stopped/aborted.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const frame of frames) {
            let data: Record<string, unknown> = {};
            if (frame.data) {
              try {
                const parsed = JSON.parse(frame.data);
                if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
              } catch {
                // Non-JSON data — surface as raw text so nothing is silently lost.
                data = { raw: frame.data };
              }
            }
            onEvent({ type: frame.event, data });
          }
        }
      } catch (err) {
        if (stopped) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }

      if (stopped) return;
      // Wait before reconnecting so a persistently-down server isn't hammered.
      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeoutImpl(resolve, reconnectDelayMs);
      });
    }
  };

  void run();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    controller?.abort();
  };
}
